// The GitHub Actions OIDC token a dispatch carries: issuer, audience, expiry and
// an RS256 signature against the issuer's JWKS, cached for at most 1 h
// (FD-INT-035, FD-IFC-024, FD-IFC-025).
import { Clock, Context, Effect, Layer, Ref, Schema } from "effect";

export const ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
export const JWKS_URL = `${ACTIONS_ISSUER}/.well-known/jwks`;
export const JWKS_CACHE_MS = 3_600_000;
/** Accepted clock skew on `nbf`. */
export const SKEW_SEC = 60;

export class OidcInvalid extends Schema.TaggedError<OidcInvalid>()("OidcInvalid", {
  reason: Schema.String,
}) {}

export const ActionsClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  exp: Schema.Number,
  nbf: Schema.optionalKey(Schema.Number),
  sub: Schema.String,
  repository: Schema.String,
  ref: Schema.optionalKey(Schema.String),
  sha: Schema.optionalKey(Schema.String),
  workflow_ref: Schema.optionalKey(Schema.String),
  job_workflow_ref: Schema.optionalKey(Schema.String),
});
export type ActionsClaims = typeof ActionsClaims.Type;

const Jwk = Schema.Struct({
  kid: Schema.String,
  kty: Schema.Literal("RSA"),
  n: Schema.String,
  e: Schema.String,
});
const Jwks = Schema.Struct({ keys: Schema.Array(Schema.Unknown) });
type Jwk = typeof Jwk.Type;

const Header = Schema.Struct({ alg: Schema.String, kid: Schema.String });

const fromBase64url = (s: string): Uint8Array => {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

const segment = <S extends Schema.Decoder<unknown>>(schema: S, text: string, what: string) =>
  Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(fromBase64url(text))) as unknown,
    catch: () => new OidcInvalid({ reason: `${what} is not base64url JSON` }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((e) =>
      e instanceof OidcInvalid ? e : new OidcInvalid({ reason: `${what}: ${e.message}` }),
    ),
  );

export class OidcVerifier extends Context.Service<
  OidcVerifier,
  {
    /** The token's claims when it is an unexpired RS256 JWT from the Actions issuer for `audience`. */
    readonly verify: (token: string, audience: string) => Effect.Effect<ActionsClaims, OidcInvalid>;
  }
>()("@fractalboxdev/flare-dispatch-intake/OidcVerifier") {}

export const oidcVerifierLayer = (fetch: typeof globalThis.fetch) =>
  Layer.effect(
    OidcVerifier,
    Effect.gen(function* () {
      const cache = yield* Ref.make<{ readonly at: number; readonly keys: readonly Jwk[] } | null>(
        null,
      );

      const fetchKeys = Effect.gen(function* () {
        const body = yield* Effect.tryPromise({
          try: async () => (await fetch(JWKS_URL)).json() as Promise<unknown>,
          catch: (e) => new OidcInvalid({ reason: `the issuer's keys are unreadable: ${e}` }),
        });
        const jwks = yield* Schema.decodeUnknownEffect(Jwks)(body).pipe(
          Effect.mapError((e) => new OidcInvalid({ reason: `the issuer's keys: ${e.message}` })),
        );
        const keys = jwks.keys.flatMap((k) => (Schema.is(Jwk)(k) ? [k] : []));
        const at = yield* Clock.currentTimeMillis;
        yield* Ref.set(cache, { at, keys });
        return keys;
      });

      /** The key for `kid`; an unknown `kid` refetches once, so a rotated key verifies within one request. */
      const keyFor = (kid: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cached = yield* Ref.get(cache);
          const fresh = cached !== null && now - cached.at < JWKS_CACHE_MS;
          const keys = fresh ? cached.keys : yield* fetchKeys;
          const found = keys.find((k) => k.kid === kid);
          if (found !== undefined) return found;
          if (!fresh) return yield* new OidcInvalid({ reason: `no issuer key ${kid}` });
          const refetched = (yield* fetchKeys).find((k) => k.kid === kid);
          if (refetched === undefined)
            return yield* new OidcInvalid({ reason: `no issuer key ${kid}` });
          return refetched;
        });

      return {
        verify: (token, audience) =>
          Effect.gen(function* () {
            const parts = token.split(".");
            if (parts.length !== 3) return yield* new OidcInvalid({ reason: "not a JWT" });
            const [h, p, s] = parts as [string, string, string];
            const header = yield* segment(Header, h, "header");
            if (header.alg !== "RS256")
              return yield* new OidcInvalid({ reason: `algorithm ${header.alg}` });
            const jwk = yield* keyFor(header.kid);
            const valid = yield* Effect.tryPromise({
              try: async () => {
                const key = await crypto.subtle.importKey(
                  "jwk",
                  { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
                  { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
                  false,
                  ["verify"],
                );
                return crypto.subtle.verify(
                  "RSASSA-PKCS1-v1_5",
                  key,
                  fromBase64url(s).slice().buffer,
                  new TextEncoder().encode(`${h}.${p}`),
                );
              },
              catch: () => new OidcInvalid({ reason: "the signature does not verify" }),
            });
            if (!valid) return yield* new OidcInvalid({ reason: "the signature does not verify" });
            const claims = yield* segment(ActionsClaims, p, "claims");
            if (claims.iss !== ACTIONS_ISSUER)
              return yield* new OidcInvalid({ reason: `issuer ${claims.iss}` });
            const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
            if (!audiences.includes(audience))
              return yield* new OidcInvalid({ reason: "audience" });
            const nowSec = (yield* Clock.currentTimeMillis) / 1000;
            if (claims.exp <= nowSec) return yield* new OidcInvalid({ reason: "expired" });
            if (claims.nbf !== undefined && claims.nbf - SKEW_SEC > nowSec)
              return yield* new OidcInvalid({ reason: "not yet valid" });
            return claims;
          }),
      };
    }),
  );
