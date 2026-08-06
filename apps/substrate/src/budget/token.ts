// The one sanctioned in-container credential: the per-execution model-proxy
// token (specs/adr/0006-credential-boundary.md, 0009-two-tier-budgets.md).
//
// ADR-0006 forbids every long-lived credential inside a container and then
// carves out exactly one, because an agent that cannot reach a model cannot do
// agentic work and there is no artifact to hand back mid-inference. The carve-out
// is narrow by construction, and each property below is a line of code here
// rather than a promise:
//
// - **Execution-scoped.** The claims name the execution and the consumer. A
//   token lifted out of one container authenticates as that execution and
//   nothing else, so what a leak buys is that execution's remaining budget.
// - **Budget-capped.** The token authenticates; it carries no balance. Spend
//   lives in the two-tier store (`store-d1.ts`), which is the only thing that
//   can refuse — a stateless token cannot hold a cap, and a cap that lives in
//   the credential is a cap the holder can re-mint.
// - **Header-only.** `bearerToken` reads `Authorization` and *refuses* a
//   `?token=` even when one would verify. Query parameters land in access logs,
//   referrers and shell history; the transport restriction is worth more than
//   the convenience, so presenting one is an error rather than a fallback.
// - **Revoked at max wall-clock.** `expiresAt` is clamped at mint to the run's
//   ceiling and checked on every call, so expiry does not depend on a finalize
//   step running, an alarm firing, or a container shutting down cleanly. The
//   `epoch` claim is the early-revoke path: the store bumps it, and every token
//   minted before the bump stops verifying at once.
// - **Never logged.** No function here returns a token in an error, and no
//   reason string contains one.
//
// Unit tested in token.test.ts.
import { makeEnvelope } from "../engine/signed-envelope";

export type ModelTokenClaims = {
  /** The substrate's namespaced execution id — `consumer:key`. */
  executionId: string;
  /** Which consumer's ceiling this execution's spend counts against. */
  consumer: string;
  /**
   * ms-epoch, clamped at mint. Never extended in place: a longer-lived token is
   * a new mint, so a run that overruns loses the old one rather than inheriting
   * a rolling expiry.
   */
  expiresAt: number;
  /** Revocation generation. A token from an earlier epoch is dead on arrival. */
  epoch: number;
};

/**
 * The hard ceiling on how long any model-proxy token stays valid, whatever a
 * caller asks for. This is the wall-clock revocation ADR-0006 requires: at 30
 * minutes past mint, a leaked token is worthless whether or not anything ran to
 * clean it up.
 */
export const MODEL_TOKEN_MAX_TTL_MS = 30 * 60_000;

const envelope = makeEnvelope<ModelTokenClaims>("mp1");

export type MintInput = {
  executionId: string;
  consumer: string;
  epoch: number;
  /** Requested lifetime; silently clamped down, never up. */
  ttlMs?: number;
};

/** Mint a token for one execution. The value is returned once and never stored. */
export async function mintModelToken(
  secret: string,
  input: MintInput,
  now: number = Date.now(),
): Promise<string> {
  const ttl = Math.min(
    MODEL_TOKEN_MAX_TTL_MS,
    Math.max(0, input.ttlMs ?? MODEL_TOKEN_MAX_TTL_MS),
  );
  return envelope.sign(secret, {
    executionId: input.executionId,
    consumer: input.consumer,
    epoch: input.epoch,
    expiresAt: now + ttl,
  });
}

export type ModelTokenVerdict =
  | { ok: true; claims: ModelTokenClaims }
  | { ok: false; reason: string };

/**
 * Verify a presented token against what the proxy expects.
 *
 * `expect.epoch` is the store's current revocation generation, read on the same
 * request. Comparing against a value read at mint time would make revocation a
 * race the holder wins.
 */
export async function verifyModelToken(
  secret: string,
  presented: string | undefined,
  expect: { executionId: string; epoch: number },
  now: number,
): Promise<ModelTokenVerdict> {
  const opened = await envelope.open(secret, presented);
  if (!opened.ok) return opened;
  const claims = opened.claims;

  if (claims.executionId !== expect.executionId)
    return { ok: false, reason: "token was minted for a different execution" };
  if (claims.epoch !== expect.epoch)
    return { ok: false, reason: "token was revoked" };
  if (typeof claims.expiresAt !== "number" || now >= claims.expiresAt)
    return { ok: false, reason: "token expired" };

  return { ok: true, claims };
}

export type PresentedToken =
  | { ok: true; token: string }
  | { ok: false; reason: string };

/**
 * Pull the token off the request — `Authorization: Bearer <token>`, and only
 * from there.
 *
 * A `?token=` is refused explicitly rather than ignored, so a client that
 * builds the URL form fails loudly on its first call instead of shipping a
 * credential into every log that records a URL. The refusal is checked before
 * the header, because a request carrying both is a client that will fall back
 * to the query form the moment the header path breaks.
 */
export function bearerToken(request: Request, url: URL): PresentedToken {
  if (url.searchParams.has("token"))
    return { ok: false, reason: "model proxy tokens are header-only" };

  const header = request.headers.get("authorization");
  if (header === null) return { ok: false, reason: "no authorization header" };
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (match === null) return { ok: false, reason: "authorization is not a bearer token" };
  return { ok: true, token: match[1] as string };
}
