// The Cloudflare Access identity gate (specs/interfaces.md FD-IFC-010 to FD-IFC-016, specs/operability.md FD-OPS-064,
// FD-OPS-078). Every gated route verifies the `Cf-Access-Jwt-Assertion` header or the `CF_Authorization` cookie
// against the team's JWKS before any route logic: RS256 only, a `kid` the JWKS publishes, `iss` the overlay's team
// domain, `aud` the overlay's audience and at most 60 s of clock skew. There is no mode that serves a gated route
// without an identity.
import { Effect, Schema } from "effect";

/** The error-model answer of a refused request: `{ error, message, request_id }` with its status. */
export class AccessDenied extends Schema.TaggedError<AccessDenied>()("AccessDenied", {
  status: Schema.Literals([401, 403, 503]),
  code: Schema.Literals(["unauthenticated", "forbidden", "not_configured"]),
  message: Schema.String,
  /** A browser request with no identity is sent to the Access login instead (FD-IFC-013). */
  redirect: Schema.optional(Schema.String),
}) {}

/** One RSA verifying key of the team's certs endpoint. */
export interface AccessJwk {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
}

/** A verified Access identity: the person's email or the service token's common name, and its subject. */
export interface AccessIdentity {
  readonly email: string | null;
  readonly commonName: string | null;
  readonly subject: string;
  /** `email` for a person, `common_name` for a service token. */
  readonly name: string;
}

export const MAX_CLOCK_SKEW_S = 60;
const JWT_HEADER = "Cf-Access-Jwt-Assertion";
const JWT_COOKIE = "CF_Authorization";

const base64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(b64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

const decodeSegment = (segment: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64urlToBytes(segment))) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const audiences = (aud: unknown): readonly string[] =>
  typeof aud === "string"
    ? [aud]
    : Array.isArray(aud)
      ? aud.filter((a): a is string => typeof a === "string")
      : [];

/** `https://<team domain>`, from a bare team domain or a URL. */
export const accessIssuer = (teamDomain: string): string =>
  new URL(/^https?:\/\//.test(teamDomain) ? teamDomain : `https://${teamDomain}`).origin;

/** The token's `kid`, or null for a token without one. */
export const jwtKid = (jwt: string): string | null => {
  const header = decodeSegment(jwt.split(".")[0] ?? "");
  return typeof header?.["kid"] === "string" ? header["kid"] : null;
};

/**
 * Verifies an Access JWT and answers its claims, or null. Pure apart from WebCrypto: the keys and the clock are the
 * caller's (FD-IFC-011, FD-IFC-012).
 */
export const verifyAccessJwt = async (
  jwt: string,
  params: {
    readonly keys: readonly AccessJwk[];
    readonly aud: string;
    readonly issuer: string;
    readonly nowSeconds: number;
  },
): Promise<Record<string, unknown> | null> => {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = decodeSegment(h);
  const payload = decodeSegment(p);
  if (header === null || payload === null || header["alg"] !== "RS256") return null;
  const kid = typeof header["kid"] === "string" ? header["kid"] : null;
  const jwk = kid === null ? undefined : params.keys.find((k) => k.kid === kid);
  if (jwk?.kty !== "RSA" || jwk.n === undefined || jwk.e === undefined) return null;
  let signature: Uint8Array;
  try {
    signature = base64urlToBytes(s);
  } catch {
    return null;
  }
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature as BufferSource,
      new TextEncoder().encode(`${h}.${p}`) as BufferSource,
    );
    if (!ok) return null;
  } catch {
    return null;
  }
  if (payload["iss"] !== params.issuer || !audiences(payload["aud"]).includes(params.aud))
    return null;
  const exp = payload["exp"];
  if (typeof exp !== "number" || params.nowSeconds > exp + MAX_CLOCK_SKEW_S) return null;
  const nbf = payload["nbf"];
  if (typeof nbf === "number" && params.nowSeconds < nbf - MAX_CLOCK_SKEW_S) return null;
  return payload;
};

/** The JWT from the header, then the cookie. */
export const readAccessJwt = (request: Request): string | null => {
  const header = request.headers.get(JWT_HEADER);
  if (header !== null && header !== "") return header;
  for (const pair of (request.headers.get("Cookie") ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === JWT_COOKIE) {
      const value = pair.slice(eq + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
};

/** A top-level browser navigation, which goes to the Access login rather than a 401 (FD-IFC-013). */
export const isBrowserNavigation = (request: Request): boolean =>
  request.headers.get("Sec-Fetch-Mode") === "navigate" ||
  (request.headers.get("Accept") ?? "").includes("text/html");

/** The Access login URL that returns the browser to this request's path. */
export const accessLoginUrl = (teamDomain: string, aud: string, request: Request): string => {
  const url = new URL(request.url);
  const params = new URLSearchParams({ kid: aud, redirect_url: `${url.pathname}${url.search}` });
  return `${accessIssuer(teamDomain)}/cdn-cgi/access/login/${url.host}?${params.toString()}`;
};

/** How long a fetched JWKS is reused, and the shortest gap between two refetches on an unknown `kid`. */
export const JWKS_TTL_MS = 3_600_000;
export const JWKS_REFETCH_COOLDOWN_MS = 30_000;

/**
 * The team's verifying keys, fetched from `<issuer>/cdn-cgi/access/certs`. A token whose `kid` the cached set lacks
 * triggers one refetch at most every 30 s, so a rotated key verifies without waiting out the TTL.
 */
export class JwksCache {
  #keys: readonly AccessJwk[] | null = null;
  #fetchedAt = 0;
  #lastRefetch = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly issuer: string,
    // Workers reject `fetch` called with another `this`; `this.fetcher(...)` would bind the cache, so the default
    // calls the global through a closure.
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async #load(): Promise<readonly AccessJwk[] | null> {
    try {
      const res = await this.fetcher(`${this.issuer}/cdn-cgi/access/certs`);
      if (!res.ok) return null;
      const body = (await res.json()) as { keys?: unknown };
      return Array.isArray(body.keys) ? (body.keys as AccessJwk[]) : [];
    } catch {
      return null;
    }
  }

  async keysFor(kid: string | null, now: number): Promise<readonly AccessJwk[] | null> {
    if (this.#keys === null || now - this.#fetchedAt >= JWKS_TTL_MS) {
      this.#keys = await this.#load();
      this.#fetchedAt = now;
    }
    const known = kid !== null && (this.#keys ?? []).some((k) => k.kid === kid);
    if (!known && kid !== null && now - this.#lastRefetch >= JWKS_REFETCH_COOLDOWN_MS) {
      this.#lastRefetch = now;
      const fresh = await this.#load();
      if (fresh !== null) {
        this.#keys = fresh;
        this.#fetchedAt = now;
      }
    }
    return this.#keys;
  }
}

/** The gate's configuration: the overlay's `access.teamDomain` and `access.aud`. */
export interface AccessConfig {
  readonly teamDomain?: string | undefined;
  readonly aud?: string | undefined;
  readonly jwks: (issuer: string) => JwksCache;
  readonly now?: () => number;
}

/** The identity of a request, or the refusal the route answers; no route logic runs before it (FD-IFC-010). */
export const requireAccess = (request: Request, config: AccessConfig) =>
  Effect.gen(function* () {
    const { teamDomain, aud } = config;
    if (teamDomain === undefined || teamDomain === "" || aud === undefined || aud === "")
      return yield* new AccessDenied({
        status: 503,
        code: "not_configured",
        message: "the operator overlay sets no Access team domain or audience",
      });
    const jwt = readAccessJwt(request);
    if (jwt === null)
      return yield* new AccessDenied({
        status: 401,
        code: "unauthenticated",
        message: "no Cloudflare Access identity on this request",
        ...(isBrowserNavigation(request)
          ? { redirect: accessLoginUrl(teamDomain, aud, request) }
          : {}),
      });
    const issuer = accessIssuer(teamDomain);
    const now = (config.now ?? Date.now)();
    const keys = yield* Effect.promise(() => config.jwks(issuer).keysFor(jwtKid(jwt), now));
    const claims =
      keys === null
        ? null
        : yield* Effect.promise(() =>
            verifyAccessJwt(jwt, { keys, aud, issuer, nowSeconds: Math.floor(now / 1000) }),
          );
    if (claims === null)
      return yield* new AccessDenied({
        status: 403,
        code: "forbidden",
        message: "invalid Cloudflare Access token",
      });
    const email = typeof claims["email"] === "string" ? claims["email"] : null;
    const commonName = typeof claims["common_name"] === "string" ? claims["common_name"] : null;
    const name = email ?? commonName;
    if (name === null)
      return yield* new AccessDenied({
        status: 403,
        code: "forbidden",
        message: "the Access token names no identity",
      });
    return {
      email,
      commonName,
      subject: typeof claims["sub"] === "string" ? claims["sub"] : name,
      name,
    } satisfies AccessIdentity;
  });

const norm = (s: string) => s.trim().toLowerCase();

/** Whether an identity is one the overlay lists: an email or a service token's common name, case-insensitively. */
export const identityListed = (identity: AccessIdentity, listed: readonly string[]): boolean =>
  listed.some(
    (entry) =>
      (identity.email !== null && norm(entry) === norm(identity.email)) ||
      (identity.commonName !== null && norm(entry) === norm(identity.commonName)),
  );

/** The identity, when the overlay's `operators` lists it; 403 `forbidden` otherwise (FD-IFC-016, FD-OPS-078). */
export const requireOperator = (
  request: Request,
  config: AccessConfig,
  operators: readonly string[],
) =>
  Effect.gen(function* () {
    const identity = yield* requireAccess(request, config);
    if (!identityListed(identity, operators))
      return yield* new AccessDenied({
        status: 403,
        code: "forbidden",
        message: "this identity is not an operator of this control plane",
      });
    return identity;
  });

/** The error-model response for a refusal; a browser with no identity is redirected to the Access login. */
export const deniedResponse = (denied: AccessDenied, requestId: string): Response =>
  denied.redirect !== undefined
    ? Response.redirect(denied.redirect, 302)
    : Response.json(
        { error: denied.code, message: denied.message, request_id: requestId },
        { status: denied.status },
      );
