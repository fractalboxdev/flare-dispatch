// The identity checks of specs/interfaces.md § Surfaces and their identity gates: the Cloudflare Access JWT, the GitHub
// Actions OIDC token and the link token. Each answers an identity or an error from the error model; none has a mode
// that passes a request without one (FD-IFC-015).
import { Context, Effect, Match } from "effect";
import { ApiConfig } from "./config.ts";
import { apiError, type ApiError } from "./errors.ts";
import { ACTIONS_ISSUER, ACTIONS_JWKS } from "@fractalboxdev/flare-dispatch-github/jwks";
import { JwksSource, verifyWithJwks, type Claims } from "./jwt.ts";
import { checkLinkToken, type LinkPurpose } from "./link-token.ts";

export { ACTIONS_ISSUER, ACTIONS_JWKS };
export const CLOCK_SKEW_S = 60;

/** A person or a service token, as Access identifies it: the email, or the service token's common name. */
export interface AccessIdentity {
  readonly _tag: "Access";
  readonly id: string;
  readonly claims: Claims;
}

/** A workflow run, as its Actions OIDC token identifies it (FD-IFC-025). */
export interface ActionsIdentity {
  readonly _tag: "Actions";
  readonly id: string;
  readonly repository: string;
  readonly ref: string;
  readonly workflowRef: string;
  readonly sha: string | undefined;
}

/** A request that proved possession of a link token for one object. */
export interface LinkHolder {
  readonly _tag: "Link";
  readonly id: string;
  readonly purpose: LinkPurpose;
  readonly objectId: string;
}

/** A surface whose route checks its own credential, or that needs none. */
export interface Unidentified {
  readonly _tag: "Unidentified";
}

export type Identity = AccessIdentity | ActionsIdentity | LinkHolder | Unidentified;

export class CurrentIdentity extends Context.Service<CurrentIdentity, Identity>()(
  "@fractalboxdev/flare-dispatch-api/CurrentIdentity",
) {}

/** A gate that answers a response other than an error: the browser's redirect into the Access login (FD-IFC-013). */
export interface LoginRedirect {
  readonly _tag: "LoginRedirect";
  readonly location: string;
}

const ACCESS_HEADER = "cf-access-jwt-assertion";
const ACCESS_CLIENT_HEADER = "cf-access-token";
const ACCESS_COOKIE = "CF_Authorization";

export const accessIssuer = (teamDomain: string): string =>
  new URL(/^https?:\/\//.test(teamDomain) ? teamDomain : `https://${teamDomain}`).origin;

/** The Access JWT the edge injects, the one `fd` sends, or the browser's cookie. */
export const readAccessJwt = (request: Request): string | undefined => {
  for (const name of [ACCESS_HEADER, ACCESS_CLIENT_HEADER]) {
    const value = request.headers.get(name);
    if (value !== null && value.trim() !== "") return value.trim();
  }
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === ACCESS_COOKIE) {
      const value = pair.slice(eq + 1).trim();
      if (value !== "") return value;
    }
  }
  return undefined;
};

export const readBearer = (request: Request): string | undefined => {
  const header = request.headers.get("authorization");
  const match = header === null ? null : /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
};

const isBrowserNavigation = (request: Request) =>
  request.headers.get("sec-fetch-mode") === "navigate" ||
  (request.headers.get("accept") ?? "").includes("text/html");

const loginUrl = (teamDomain: string, aud: string, request: Request) => {
  const url = new URL(request.url);
  const query = new URLSearchParams({ kid: aud, redirect_url: `${url.pathname}${url.search}` });
  return `${accessIssuer(teamDomain)}/cdn-cgi/access/login/${url.host}?${query.toString()}`;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

const identityOf = (claims: Claims): string | undefined => {
  for (const key of ["email", "common_name", "sub"]) {
    const value = claims[key];
    if (typeof value === "string" && value !== "") return value.toLowerCase();
  }
  return undefined;
};

/**
 * Verifies the request's Access JWT (FD-IFC-011): RS256, a `kid` in the team's JWKS, `iss` equal to the team domain,
 * `aud` equal to the overlay's, 60 s of skew. No configuration answers `not_configured` (FD-IFC-014), no token
 * `unauthenticated` or a login redirect (FD-IFC-013), and a token that fails `forbidden` (FD-IFC-012).
 */
export const authenticateAccess = (
  request: Request,
  options: { readonly redirectBrowser: boolean },
): Effect.Effect<AccessIdentity | LoginRedirect, ApiError, ApiConfig | JwksSource> =>
  Effect.gen(function* () {
    const { access } = yield* ApiConfig;
    if (access === undefined)
      return yield* apiError(
        "not_configured",
        "this deployment has no Access team domain or audience",
      );
    const jwt = readAccessJwt(request);
    if (jwt === undefined) {
      if (options.redirectBrowser && isBrowserNavigation(request))
        return {
          _tag: "LoginRedirect",
          location: loginUrl(access.teamDomain, access.aud, request),
        } as const;
      return yield* apiError("unauthenticated", "an Access identity is required");
    }
    const issuer = accessIssuer(access.teamDomain);
    const result = yield* verifyWithJwks(jwt, `${issuer}/cdn-cgi/access/certs`, {
      issuer,
      audience: access.aud,
      nowSeconds: nowSeconds(),
      clockSkewSeconds: CLOCK_SKEW_S,
    }).pipe(
      Effect.catchTag("JwksUnavailable", () =>
        Effect.fail(apiError("unavailable", "the Access keys could not be read")),
      ),
    );
    const id = result._tag === "Valid" ? identityOf(result.claims) : undefined;
    if (result._tag === "Invalid" || id === undefined)
      return yield* apiError("forbidden", "the Access token is not valid for this deployment");
    return { _tag: "Access", id, claims: result.claims } as const;
  });

/**
 * Verifies an Actions OIDC token against GitHub's keys with the overlay's audience (FD-IFC-024), and takes the
 * repository, ref and workflow ref from its claims (FD-IFC-025).
 */
export const authenticateActions = (
  token: string,
): Effect.Effect<ActionsIdentity, ApiError, ApiConfig | JwksSource> =>
  Effect.gen(function* () {
    const { oidcAudience } = yield* ApiConfig;
    if (oidcAudience === undefined)
      return yield* apiError("not_configured", "this deployment has no Actions OIDC audience");
    const result = yield* verifyWithJwks(token, ACTIONS_JWKS, {
      issuer: ACTIONS_ISSUER,
      audience: oidcAudience,
      nowSeconds: nowSeconds(),
      clockSkewSeconds: CLOCK_SKEW_S,
    }).pipe(
      Effect.catchTag("JwksUnavailable", () =>
        Effect.fail(apiError("unavailable", "GitHub's OIDC keys could not be read")),
      ),
    );
    if (result._tag === "Invalid")
      return yield* apiError("unauthenticated", "the Actions OIDC token is not valid");
    const { repository, ref, workflow_ref: workflowRef, sha } = result.claims;
    if (
      typeof repository !== "string" ||
      typeof ref !== "string" ||
      typeof workflowRef !== "string"
    )
      return yield* apiError(
        "unauthenticated",
        "the Actions OIDC token lacks its repository claims",
      );
    return {
      _tag: "Actions",
      id: `actions:${repository}:${workflowRef}`,
      repository,
      ref,
      workflowRef,
      sha: typeof sha === "string" ? sha : undefined,
    } as const;
  });

/** The access group an Access route admits beyond any valid identity. */
export type AccessGroup = "any" | "operators" | "dispatchers";

export const inGroup = (
  config: { readonly operators: readonly string[]; readonly dispatchers: readonly string[] },
  group: AccessGroup,
  id: string,
): boolean =>
  group === "any" ||
  (group === "operators" ? config.operators : config.dispatchers).includes(id.toLowerCase());

/**
 * A dispatch carries an Actions OIDC token as its bearer, or an Access JWT of an identity in `dispatchers`; anything
 * else answers `unauthenticated` before the route looks up the run (FD-IFC-027).
 */
export const authenticateDispatch = (
  request: Request,
): Effect.Effect<AccessIdentity | ActionsIdentity, ApiError, ApiConfig | JwksSource> =>
  Effect.gen(function* () {
    const bearer = readBearer(request);
    if (bearer !== undefined) return yield* authenticateActions(bearer);
    const config = yield* ApiConfig;
    const unauthenticated = apiError(
      "unauthenticated",
      "a dispatch needs an Actions OIDC token or the Access identity of a dispatcher",
    );
    const access = yield* authenticateAccess(request, { redirectBrowser: false }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          error.error === "not_configured" || error.error === "unavailable"
            ? error
            : unauthenticated,
        ),
      ),
    );
    return yield* Match.value(access).pipe(
      Match.tag("Access", (identity) =>
        inGroup(config, "dispatchers", identity.id)
          ? Effect.succeed(identity)
          : Effect.fail(unauthenticated),
      ),
      Match.tag("LoginRedirect", () => Effect.fail(unauthenticated)),
      Match.exhaustive,
    );
  });

/**
 * A log or artifact route serves an Access identity, or a request whose `t` parameter is a link token for that object
 * that has neither expired nor been revoked (FD-IFC-017, FD-IFC-020, FD-IFC-021).
 */
export const authenticateLink = (
  request: Request,
  purpose: LinkPurpose,
  objectId: string,
): Effect.Effect<AccessIdentity | LinkHolder | LoginRedirect, ApiError, ApiConfig | JwksSource> =>
  Effect.gen(function* () {
    const token = new URL(request.url).searchParams.get("t");
    if (token === null || token === "")
      return yield* authenticateAccess(request, { redirectBrowser: true });
    const { linkKey, linkEpoch } = yield* ApiConfig;
    if (linkKey === undefined)
      return yield* apiError("not_configured", "this deployment has no link key");
    const check = yield* Effect.promise(() =>
      checkLinkToken(linkKey, token, {
        purpose,
        objectId,
        nowS: nowSeconds(),
        currentEpoch: linkEpoch,
      }),
    );
    return yield* Match.value(check).pipe(
      Match.tagsExhaustive({
        Granted: () =>
          Effect.succeed<LinkHolder>({
            _tag: "Link",
            id: `link:${purpose}:${objectId}`,
            purpose,
            objectId,
          }),
        Expired: () => Effect.fail(apiError("link_expired", "the link has expired")),
        Revoked: () => Effect.fail(apiError("link_revoked", "the link has been revoked")),
        Invalid: () =>
          Effect.fail(apiError("forbidden", "the link token is not valid for this object")),
      }),
    );
  });
