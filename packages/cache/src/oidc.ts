// The control plane's OIDC issuer (specs/provenance.md FD-PROV-049, FD-PROV-050): ES256 JWTs whose public keys
// `/.well-known/jwks.json` serves. An identity provider verifies a token against the JWKS it last fetched, so a key
// retired by rotation stays in the set for at least the longest token lifetime.
import { Effect, Option, Schema } from "effect";
import { asBuffer, base64url, utf8 } from "./crypto.ts";

export const OIDC_MAX_TTL_SEC = 3600;
export const OIDC_DEFAULT_TTL_SEC = 900;
/** Claims the control plane sets; a run's request may set none of them. */
export const OIDC_RESERVED_CLAIMS = ["iss", "sub", "aud", "iat", "nbf", "exp", "jti"] as const;

/** A public ES256 JWK with its `kid`. */
const PublicEcJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
  kid: Schema.NonEmptyString,
});
/** A private ES256 JWK with its `kid`. */
const PrivateEcJwk = Schema.Struct({ ...PublicEcJwk.fields, d: Schema.String });
const KeySet = Schema.Struct({
  current: PrivateEcJwk,
  retired: Schema.Array(Schema.Struct({ jwk: PublicEcJwk, retiredAt: Schema.Finite })),
});

/** The issuer's keys, as the `OIDC_SIGNING_JWK` secret holds them ({@link parseOidcKeys}). */
export interface OidcKeys {
  /** The current private ES256 JWK, with its `kid`. */
  readonly current: typeof PrivateEcJwk.Type;
  /** Keys retired by rotation: public JWK and the epoch ms of the rotation. */
  readonly retired: readonly { readonly jwk: typeof PublicEcJwk.Type; readonly retiredAt: number }[];
}

export class OidcRefused extends Schema.TaggedError<OidcRefused>()("OidcRefused", {
  reason: Schema.Literals(["reserved-claim", "ttl", "key"]),
  detail: Schema.String,
}) {}

const publicOf = (jwk: typeof PublicEcJwk.Type) => ({
  kty: "EC",
  crv: "P-256",
  x: jwk.x,
  y: jwk.y,
  kid: jwk.kid,
  use: "sig",
  alg: "ES256",
});

/**
 * The JWKS (FD-PROV-049): the current key, and every retired key until `retainSec` after its rotation, at least the
 * 3600 s longest token lifetime.
 */
export const jwks = (keys: OidcKeys, nowMs: number, retainSec = OIDC_MAX_TTL_SEC) => ({
  keys: [
    publicOf(keys.current),
    ...keys.retired
      .filter((r) => nowMs - r.retiredAt < Math.max(retainSec, OIDC_MAX_TTL_SEC) * 1000)
      .map((r) => publicOf(r.jwk)),
  ],
});

const decodeSecret = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Union([KeySet, PrivateEcJwk])));

/**
 * The key set the `OIDC_SIGNING_JWK` secret holds: either one private ES256 JWK with its `kid`, or, after a rotation,
 * `{ "current": <private JWK>, "retired": [{ "jwk": <public JWK>, "retiredAt": <epoch ms> }] }`. `undefined` while
 * the secret is unset or holds no P-256 key with a `kid` (FD-IFC-051).
 */
export const parseOidcKeys = (secret: string | undefined): OidcKeys | undefined => {
  if (secret === undefined || secret.trim() === "") return undefined;
  return Option.match(decodeSecret(secret.trim()), {
    onNone: () => undefined,
    onSome: (keys): OidcKeys => ("current" in keys ? keys : { current: keys, retired: [] }),
  });
};

export interface TokenRequest {
  readonly run: string;
  readonly executionId: string;
  readonly audience: string;
  readonly ttlSec?: number;
  readonly claims?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Issues one token (FD-PROV-050): `sub` is `<run>:<execution_id>`, the lifetime is at most 3600 s with a default of
 * 900 s, and a request that sets a reserved claim is refused.
 */
export const issueOidcToken = (keys: OidcKeys, issuer: string, request: TokenRequest, nowMs: number) =>
  Effect.gen(function* () {
    const reserved = Object.keys(request.claims ?? {}).filter((k) =>
      (OIDC_RESERVED_CLAIMS as readonly string[]).includes(k),
    );
    if (reserved.length > 0)
      return yield* Effect.fail(new OidcRefused({ reason: "reserved-claim", detail: reserved.join(", ") }));
    const ttl = request.ttlSec ?? OIDC_DEFAULT_TTL_SEC;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > OIDC_MAX_TTL_SEC)
      return yield* Effect.fail(new OidcRefused({ reason: "ttl", detail: `${ttl} s` }));
    const key = yield* Effect.tryPromise({
      try: () => crypto.subtle.importKey("jwk", keys.current, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
      catch: () => new OidcRefused({ reason: "key", detail: "the signing JWK does not import" }),
    });
    const iat = Math.floor(nowMs / 1000);
    const header = base64url(utf8(JSON.stringify({ alg: "ES256", typ: "JWT", kid: keys.current.kid })));
    const payload = base64url(
      utf8(
        JSON.stringify({
          ...request.claims,
          iss: issuer.replace(/\/+$/, ""),
          sub: `${request.run}:${request.executionId}`,
          aud: request.audience,
          iat,
          exp: iat + ttl,
          jti: crypto.randomUUID(),
        }),
      ),
    );
    const signature = yield* Effect.promise(() =>
      crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, asBuffer(utf8(`${header}.${payload}`))),
    );
    return { jwt: `${header}.${payload}.${base64url(signature)}`, expiresAt: (iat + ttl) * 1000 };
  });
