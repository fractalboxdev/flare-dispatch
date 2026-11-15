// A capability token the control plane mints for one execution lease and accepts only from it: bound to the
// execution id and the epoch, expiring at the lease's `deadline_at`, under a Worker secret of its own kind.
//
//   token   = <version> "." base64url(payload) "." base64url(mac)
//   payload = canonical JSON { execution_id, epoch, exp }
//   mac     = HMAC-SHA256(k, <version> "\n" base64url(payload))
//   k       = HKDF-SHA256(<the kind's Worker secret>, info = <the kind's label>)
//
// The token alone proves the lease it names was granted; whether that epoch is still the execution's current one is
// the route's check against the placement row.
import {
  base64url,
  canonicalJson,
  derivedHmacKey,
  fromBase64url,
  hmacSign,
  hmacVerify,
  utf8,
} from "@fractalboxdev/flare-dispatch-cache/crypto";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Option, Schema } from "effect";

/** One token kind: its version prefix and the HKDF label its key derives under. */
export interface LeaseTokenKind {
  readonly version: string;
  readonly label: string;
}

/** What a lease token binds: one execution at one epoch, until an expiry. */
export interface LeaseTokenScope {
  readonly executionId: string;
  readonly epoch: number;
  /** Epoch ms: the execution's `deadline_at`. */
  readonly expiresAt: number;
}

export type LeaseTokenRefusal = "missing" | "malformed" | "invalid" | "expired" | "other-execution";

const Payload = Schema.Struct({
  execution_id: Schema.String,
  epoch: Schema.Number,
  exp: Schema.Number,
});
const decodePayload = Schema.decodeUnknownOption(Payload);

export const signLeaseToken = async (
  kind: LeaseTokenKind,
  secret: string,
  scope: LeaseTokenScope,
): Promise<string> => {
  const payload = base64url(
    utf8(
      canonicalJson({ execution_id: scope.executionId, epoch: scope.epoch, exp: scope.expiresAt }),
    ),
  );
  const key = await derivedHmacKey(secret, kind.label);
  return `${kind.version}.${payload}.${base64url(await hmacSign(key, `${kind.version}\n${payload}`))}`;
};

/**
 * Verifies `presented` as a token of `kind` under `secret` at `nowMs`, and answers the scope it binds. Where the route
 * names the execution, a token for any other is `other-execution`.
 */
export const verifyLeaseToken = async (
  kind: LeaseTokenKind,
  secret: string,
  presented: string | null,
  nowMs: number,
  executionId?: string,
): Promise<
  | { readonly ok: true; readonly scope: LeaseTokenScope }
  | { readonly ok: false; readonly reason: LeaseTokenRefusal }
> => {
  if (presented === null || presented === "") return { ok: false, reason: "missing" };
  const parts = presented.split(".");
  if (parts.length !== 3 || parts[0] !== kind.version) return { ok: false, reason: "malformed" };
  const [, payload, macText] = parts as [string, string, string];
  const mac = fromBase64url(macText);
  const body = fromBase64url(payload);
  if (mac === undefined || mac.length !== 32 || body === undefined)
    return { ok: false, reason: "malformed" };
  const key = await derivedHmacKey(secret, kind.label);
  if (!(await hmacVerify(key, mac, `${kind.version}\n${payload}`)))
    return { ok: false, reason: "invalid" };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const decoded = decodePayload(json);
  if (Option.isNone(decoded)) return { ok: false, reason: "malformed" };
  const p = decoded.value;
  if (executionId !== undefined && p.execution_id !== executionId)
    return { ok: false, reason: "other-execution" };
  if (nowMs >= p.exp) return { ok: false, reason: "expired" };
  return { ok: true, scope: { executionId: p.execution_id, epoch: p.epoch, expiresAt: p.exp } };
};

/** The bearer token of an `Authorization` header, or null. */
export const bearerOf = (request: Request): string | null => {
  const auth = request.headers.get("authorization");
  return auth === null ? null : (/^Bearer\s+(\S+)$/i.exec(auth.trim())?.[1] ?? null);
};

/**
 * The leases whose tokens are revoked: one row per execution and epoch. A lease's end revokes every token minted for
 * it, its model-lease token and its control-plane read token, and each route refuses a revoked lease's token
 * (MAMEKO-ISO-053, MAMEKO-HOST-052).
 */
const REVOCATION_SCHEMA = [
  `create table if not exists fd_lease_token_revocations (
    execution_id text not null,
    epoch integer not null,
    revoked_at integer not null,
    primary key (execution_id, epoch))`,
] as const;

const revocationsMigrated = new WeakMap<object, Promise<unknown>>();

const migrateRevocations = (db: D1Like): Promise<unknown> => {
  const existing = revocationsMigrated.get(db);
  if (existing !== undefined) return existing;
  const run = (async () => {
    for (const sql of REVOCATION_SCHEMA) await db.prepare(sql).run();
  })().catch((e: unknown) => {
    revocationsMigrated.delete(db);
    throw e;
  });
  revocationsMigrated.set(db, run);
  return run;
};

/** Revokes every token of the execution's lease at `epoch`, as the lease ends. */
export const revokeLeaseTokens = async (
  db: D1Like,
  executionId: string,
  epoch: number,
  now: number,
): Promise<void> => {
  await migrateRevocations(db);
  await db
    .prepare(
      `insert into fd_lease_token_revocations (execution_id, epoch, revoked_at) values (?, ?, ?)
       on conflict (execution_id, epoch) do nothing`,
    )
    .bind(executionId, epoch, now)
    .run();
};

/** Whether the execution's lease at `epoch` has had its tokens revoked. */
export const leaseTokensRevoked = async (
  db: D1Like,
  executionId: string,
  epoch: number,
): Promise<boolean> => {
  await migrateRevocations(db);
  const { results } = await db
    .prepare(
      "select 1 as revoked from fd_lease_token_revocations where execution_id = ? and epoch = ?",
    )
    .bind(executionId, epoch)
    .all();
  return results.length > 0;
};
