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
