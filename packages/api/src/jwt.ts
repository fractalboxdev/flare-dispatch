// RS256 JWT verification against a JWKS, shared by the Access gate and the Actions OIDC check. Verification is pure:
// the keys and the time come from the caller, so a test signs real tokens with a throwaway key pair.
import { Context, Effect, Layer, Schema } from "effect";
import { base64urlDecode, utf8 } from "./crypto.ts";

/** One RSA verifying key of a JWKS. */
export interface Jwk {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
  readonly use?: string;
}

export interface VerifyParams {
  readonly keys: readonly Jwk[];
  readonly issuer: string;
  readonly audience: string;
  readonly nowSeconds: number;
  /** The clock skew tolerated on `exp` and `nbf`; at most 60 s (FD-IFC-011). */
  readonly clockSkewSeconds: number;
}

export type Claims = Readonly<Record<string, unknown>>;

/**
 * Why a token failed. `malformed` and `signature` are the token's own fault; `unknown_kid` is a token whose key the
 * cached JWKS lacks, which a rotation explains.
 */
export type JwtRejection = "malformed" | "algorithm" | "unknown_kid" | "signature" | "claims";

export type JwtResult =
  | { readonly _tag: "Valid"; readonly claims: Claims }
  | { readonly _tag: "Invalid"; readonly reason: JwtRejection };

const decodeSegment = (segment: string): Record<string, unknown> | undefined => {
  const bytes = base64urlDecode(segment);
  if (bytes === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const audiences = (aud: unknown): readonly string[] =>
  typeof aud === "string"
    ? [aud]
    : Array.isArray(aud)
      ? aud.filter((a): a is string => typeof a === "string")
      : [];

const invalid = (reason: JwtRejection): JwtResult => ({ _tag: "Invalid", reason });

/** Verifies an RS256 JWT: a `kid` in the JWKS, the signature, `iss`, `aud`, `exp` and `nbf` within the skew. */
export const verifyJwt = async (jwt: string, params: VerifyParams): Promise<JwtResult> => {
  const parts = jwt.split(".");
  if (parts.length !== 3) return invalid("malformed");
  const [headerSeg, payloadSeg, sigSeg] = parts as [string, string, string];
  const header = decodeSegment(headerSeg);
  const payload = decodeSegment(payloadSeg);
  const signature = base64urlDecode(sigSeg);
  if (header === undefined || payload === undefined || signature === undefined)
    return invalid("malformed");
  if (header["alg"] !== "RS256") return invalid("algorithm");
  const kid = header["kid"];
  if (typeof kid !== "string") return invalid("unknown_kid");
  const key = params.keys.find((k) => k.kid === kid && k.kty === "RSA");
  if (key === undefined || key.n === undefined || key.e === undefined)
    return invalid("unknown_kid");
  let verified = false;
  try {
    const imported = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      imported,
      signature,
      utf8(`${headerSeg}.${payloadSeg}`),
    );
  } catch {
    verified = false;
  }
  if (!verified) return invalid("signature");
  const skew = Math.min(params.clockSkewSeconds, 60);
  const exp = payload["exp"];
  const nbf = payload["nbf"];
  if (payload["iss"] !== params.issuer) return invalid("claims");
  if (!audiences(payload["aud"]).includes(params.audience)) return invalid("claims");
  if (typeof exp !== "number" || params.nowSeconds > exp + skew) return invalid("claims");
  if (nbf !== undefined && (typeof nbf !== "number" || params.nowSeconds < nbf - skew))
    return invalid("claims");
  return { _tag: "Valid", claims: payload };
};

export class JwksUnavailable extends Schema.TaggedError<JwksUnavailable>()("JwksUnavailable", {
  url: Schema.String,
}) {}

/**
 * The JWKS of an issuer. `fresh` bypasses any cache, for a `kid` a rotation may have just introduced; the live Layer
 * caches each URL for at most one hour (FD-INT-035).
 */
export class JwksSource extends Context.Service<
  JwksSource,
  {
    readonly keys: (
      url: string,
      options: { readonly fresh: boolean },
    ) => Effect.Effect<readonly Jwk[], JwksUnavailable>;
  }
>()("@fractalboxdev/flare-dispatch-api/JwksSource") {}

const JWKS_TTL_S = 3_600;
const REVALIDATE_COOLDOWN_MS = 30_000;

/** Fetches each JWKS through the edge cache with a one-hour TTL; a fresh read happens at most once per 30 s. */
export const JwksSourceLive = Layer.sync(JwksSource, () => {
  let lastFreshMs = 0;
  return JwksSource.of({
    keys: (url, { fresh }) =>
      Effect.tryPromise({
        try: async () => {
          const now = Date.now();
          const bypass = fresh && now - lastFreshMs > REVALIDATE_COOLDOWN_MS;
          if (bypass) lastFreshMs = now;
          const response = await fetch(url, {
            cf: { cacheTtl: bypass ? 0 : JWKS_TTL_S, cacheEverything: true },
          } as RequestInit);
          if (!response.ok) throw new Error(`${response.status}`);
          const body = (await response.json()) as { readonly keys?: readonly Jwk[] };
          return Array.isArray(body.keys) ? body.keys : [];
        },
        catch: () => new JwksUnavailable({ url }),
      }),
  });
});

/** Verifies against the cached keys, and once more against fresh keys when the token's `kid` is unknown. */
export const verifyWithJwks = (
  jwt: string,
  url: string,
  params: Omit<VerifyParams, "keys">,
): Effect.Effect<JwtResult, JwksUnavailable, JwksSource> =>
  Effect.gen(function* () {
    const source = yield* JwksSource;
    const cached = yield* source.keys(url, { fresh: false });
    const first = yield* Effect.promise(() => verifyJwt(jwt, { ...params, keys: cached }));
    if (first._tag === "Valid" || first.reason !== "unknown_kid") return first;
    const fresh = yield* source.keys(url, { fresh: true });
    return yield* Effect.promise(() => verifyJwt(jwt, { ...params, keys: fresh }));
  });
