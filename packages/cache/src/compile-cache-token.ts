// Compile-cache tokens (FD-CACHE-057). A token binds one repository, one execution at one epoch, its readable and
// writable namespaces and an expiry no later than the execution's `deadline_at`:
//
//   token   = "cc3." base64url(payload) "." base64url(mac)
//   payload = canonical JSON { repo, execution_id, epoch, read, write, exp }
//   mac     = HMAC-SHA256(k_cc, "cc3\n" base64url(payload))
//   k_cc    = HKDF-SHA256(secret, info = "flare-dispatch/compile-cache/v3")
//
// The route takes the namespaces from the verified payload only (FD-CACHE-058). The HKDF label keeps `k_cc`
// independent of every other key derived from the same secret.
import { Option, Schema } from "effect";
import {
  base64url,
  canonicalJson,
  derivedHmacKey,
  fromBase64url,
  hmacSign,
  hmacVerify,
  utf8,
} from "./crypto.ts";

const VERSION = "cc3";
export const COMPILE_CACHE_TOKEN_LABEL = "flare-dispatch/compile-cache/v3";

export interface CompileCacheScope {
  /** `owner/name`, lowercase. */
  readonly repo: string;
  readonly executionId: string;
  readonly epoch: number;
  readonly read: readonly string[];
  readonly write: string | null;
  /** Epoch ms. */
  readonly expiresAt: number;
}

const Payload = Schema.Struct({
  repo: Schema.String,
  execution_id: Schema.String,
  epoch: Schema.Number,
  read: Schema.Array(Schema.String),
  write: Schema.NullOr(Schema.String),
  exp: Schema.Number,
});
const decodePayload = Schema.decodeUnknownOption(Payload);

export const signCompileCacheToken = async (
  secret: string,
  scope: CompileCacheScope,
): Promise<string> => {
  const payload = base64url(
    utf8(
      canonicalJson({
        repo: scope.repo.toLowerCase(),
        execution_id: scope.executionId,
        epoch: scope.epoch,
        read: scope.read,
        write: scope.write,
        exp: scope.expiresAt,
      }),
    ),
  );
  const key = await derivedHmacKey(secret, COMPILE_CACHE_TOKEN_LABEL);
  return `${VERSION}.${payload}.${base64url(await hmacSign(key, `${VERSION}\n${payload}`))}`;
};

export type TokenRefusal = "missing" | "malformed" | "invalid" | "expired" | "other-repository";

/** Verifies `presented` for the repository the request path names, at `nowMs`. */
export const verifyCompileCacheToken = async (
  secret: string,
  repo: string,
  presented: string | null,
  nowMs: number,
): Promise<
  | { readonly ok: true; readonly scope: CompileCacheScope }
  | { readonly ok: false; readonly reason: TokenRefusal }
> => {
  if (presented === null || presented === "") return { ok: false, reason: "missing" };
  const parts = presented.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: "malformed" };
  const [, payload, macText] = parts as [string, string, string];
  const mac = fromBase64url(macText);
  const body = fromBase64url(payload);
  if (mac === undefined || mac.length !== 32 || body === undefined)
    return { ok: false, reason: "malformed" };
  const key = await derivedHmacKey(secret, COMPILE_CACHE_TOKEN_LABEL);
  if (!(await hmacVerify(key, mac, `${VERSION}\n${payload}`)))
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
  if (p.repo !== repo.toLowerCase()) return { ok: false, reason: "other-repository" };
  if (nowMs >= p.exp) return { ok: false, reason: "expired" };
  return {
    ok: true,
    scope: {
      repo: p.repo,
      executionId: p.execution_id,
      epoch: p.epoch,
      read: p.read,
      write: p.write,
      expiresAt: p.exp,
    },
  };
};
