// FlareDispatch Dispatcher — Cloudflare Access enforcement for viewer surfaces.
//
// The human-facing read surfaces — the HTML log viewer (`/logs/:execution`),
// the product-demo viewer (`/demos/:execution`), the rrweb replay player
// (`/replay/:sessionId`), and the executions read API (`/v1/executions/...`,
// which serves the COMPLETE raw logs of a run) — are served from the Worker's
// own origin and, until now, were gated ONLY by a per-execution capability
// token (`?t=`, log-token.ts) — and `/replay` had no gate at all. A capability
// token embedded in a check-run is shareable by anyone who can see that
// check-run.
//
// (`/v1/artifacts/...` is intentionally NOT gated — it is an operator-curated,
// ULID-addressed open surface whose bytes are embedded as media in GitHub
// check-run summaries and the `/demos` gallery; see router.ts `isViewerSurface`.)
//
// This module adds Cloudflare Access (Zero Trust SSO) as a FIRST gate in front
// of every viewer surface, layered ON TOP of the existing token gate (both must
// pass). It verifies the `Cf-Access-Jwt-Assertion` JWT (or the `CF_Authorization`
// cookie) that Cloudflare injects on requests that traversed an Access
// application — against the team's published JWKS — and checks `iss`/`aud`/`exp`.
// A request that reaches the Worker WITHOUT a valid Access JWT (e.g. dialing the
// `*.workers.dev` origin directly to bypass an Access app bound to a custom
// domain) is refused. Access enforcement at the CF edge keeps unauthenticated
// users off the Worker entirely; this Worker-side verify is defence-in-depth.
//
// One viewer surface is NOT edge-gated: the dashboard `/`. The Access app is
// path-scoped to `/logs`, `/demos`, `/replay`, `/v1/executions` — a bare `/`
// destination would prefix-match every machine path (`/v1/dispatch`,
// `/v1/webhooks`, `/v1/artifacts`, …) and break CI/webhooks/check-run media.
// So `/` reaches the Worker un-gated. A *browser* navigation arriving there
// with no Access identity is 302'd into the SSO login (back to `/` after auth);
// only programmatic callers see the 403 JSON. See `isBrowserNavigation`.
//
// --- Default to secure -------------------------------------------------------
//
// Enforcement is ON BY DEFAULT. With `VIEWER_ACCESS_MODE` unset (or "required"):
//
//   * `ACCESS_AUD` + `ACCESS_TEAM_DOMAIN` unset → 503 access_not_configured.
//     The viewer refuses to serve rather than fall open. An operator who wants
//     the pre-Access (token-only) behaviour must say so explicitly.
//   * configured, but the request carries no / an invalid Access JWT → 403.
//
// The single explicit opt-out is `VIEWER_ACCESS_MODE=token-only`, for a deploy
// that deliberately relies on the capability token alone (and for `wrangler dev`
// / local smokes, where no Access app fronts the Worker). There is no implicit
// fall-open path: an unconfigured deploy is closed, not open.
//
// Spec: specs/07-trust-model.md § Operator → Dispatcher (viewer).

import type { Env } from "./env";

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The header Cloudflare Access injects with the signed identity assertion. */
const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
/** The cookie Access sets for top-level navigations (same JWT). */
const ACCESS_JWT_COOKIE = "CF_Authorization";

/**
 * Viewer Access enforcement mode. `"required"` (the default when unset) gates
 * every viewer surface behind a verified Access JWT; `"token-only"` is the
 * explicit opt-out that falls back to the capability token alone.
 */
export type ViewerAccessMode = "required" | "token-only";

/** Resolve the enforcement mode, defaulting to the secure ("required") path. */
export const resolveViewerAccessMode = (env: Env): ViewerAccessMode =>
  env.VIEWER_ACCESS_MODE === "token-only" ? "token-only" : "required";

// ---------------------------------------------------------------------------
// JWT verification (pure — no network). Exported for unit tests.
// ---------------------------------------------------------------------------

/** One RSA verifying key from the Access certs endpoint (`/cdn-cgi/access/certs`). */
export interface AccessJwk {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
  readonly use?: string;
}

/** What `verifyAccessJwt` needs to validate a token, all caller-supplied. */
export interface AccessVerifyParams {
  /** The verifying keys (JWKS `keys[]`) from the team's certs endpoint. */
  readonly keys: readonly AccessJwk[];
  /** The expected audience — the Access application's AUD tag. */
  readonly aud: string;
  /** The expected issuer — `https://<team>.cloudflareaccess.com`. */
  readonly issuer: string;
  /** Current time in seconds since epoch (injectable for tests). */
  readonly nowSeconds: number;
  /** Clock-skew tolerance in seconds (default 60). */
  readonly clockSkewSeconds?: number;
}

const base64urlToBytes = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

const decodeJson = (segment: string): Record<string, unknown> | null => {
  try {
    const text = new TextDecoder().decode(base64urlToBytes(segment));
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** `aud` may be a string or an array of strings — normalize to a list. */
const audienceList = (aud: unknown): readonly string[] => {
  if (typeof aud === "string") return [aud];
  if (Array.isArray(aud)) return aud.filter((a): a is string => typeof a === "string");
  return [];
};

/**
 * Verify a Cloudflare Access JWT against the supplied JWKS + claims. Returns
 * `true` only when the signature is valid AND `iss`/`aud`/`exp`/`nbf` all check
 * out. Pure: no I/O, time injected via `nowSeconds`. Access signs with RS256
 * (RSASSA-PKCS1-v1_5 over SHA-256); a token with any other `alg` is refused.
 */
export const verifyAccessJwt = async (
  jwt: string,
  params: AccessVerifyParams,
): Promise<boolean> => {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [headerSeg, payloadSeg, sigSeg] = parts as [string, string, string];

  const header = decodeJson(headerSeg);
  const payload = decodeJson(payloadSeg);
  if (header === null || payload === null) return false;
  if (header["alg"] !== "RS256") return false;

  // Select the verifying key by `kid` (fall back to the sole key when the token
  // carries no kid and exactly one key is published).
  const kid = typeof header["kid"] === "string" ? header["kid"] : undefined;
  const candidates =
    kid !== undefined
      ? params.keys.filter((k) => k.kid === kid)
      : params.keys.length === 1
        ? params.keys
        : [];
  if (candidates.length === 0) return false;

  const signed = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  const signature = base64urlToBytes(sigSeg);

  let signatureOk = false;
  for (const jwk of candidates) {
    if (jwk.kty !== "RSA" || jwk.n === undefined || jwk.e === undefined) continue;
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
        signed as BufferSource,
      );
      if (ok) {
        signatureOk = true;
        break;
      }
    } catch {
      // Malformed key material — try the next candidate.
    }
  }
  if (!signatureOk) return false;

  // Claims. Issuer + audience must match the configured Access application; the
  // token must be currently valid (with a small clock-skew tolerance).
  if (payload["iss"] !== params.issuer) return false;
  if (!audienceList(payload["aud"]).includes(params.aud)) return false;

  const skew = params.clockSkewSeconds ?? 60;
  const exp = payload["exp"];
  if (typeof exp !== "number" || params.nowSeconds > exp + skew) return false;
  const nbf = payload["nbf"];
  if (typeof nbf === "number" && params.nowSeconds < nbf - skew) return false;
  return true;
};

// ---------------------------------------------------------------------------
// JWKS fetch (cached in module memory) + the request-level gate.
// ---------------------------------------------------------------------------

interface CertsCacheEntry {
  readonly keys: readonly AccessJwk[];
  readonly fetchedAtMs: number;
}

/** Module-memory JWKS cache, keyed by certs URL. Survives within a Worker isolate. */
const certsCache = new Map<string, CertsCacheEntry>();
/** Access rotates signing keys infrequently; an hour is well within tolerance. */
const CERTS_TTL_MS = 60 * 60 * 1000;

/** Visible for tests — drop any cached JWKS so a fresh fetch is forced. */
export const clearAccessCertsCache = (): void => certsCache.clear();

/**
 * Normalize `ACCESS_TEAM_DOMAIN` to the issuer origin. Accepts a bare team
 * domain (`myteam.cloudflareaccess.com`) or a full URL; always returns the
 * scheme+host with no trailing slash (`https://myteam.cloudflareaccess.com`).
 */
export const accessIssuer = (teamDomain: string): string => {
  const withScheme = /^https?:\/\//.test(teamDomain)
    ? teamDomain
    : `https://${teamDomain}`;
  return new URL(withScheme).origin;
};

const fetchAccessCerts = async (
  issuer: string,
  nowMs: number,
): Promise<readonly AccessJwk[] | null> => {
  const url = `${issuer}/cdn-cgi/access/certs`;
  const cached = certsCache.get(url);
  if (cached !== undefined && nowMs - cached.fetchedAtMs < CERTS_TTL_MS) {
    return cached.keys;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) return cached?.keys ?? null;
    const body = (await res.json()) as { keys?: readonly AccessJwk[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    certsCache.set(url, { keys, fetchedAtMs: nowMs });
    return keys;
  } catch {
    // Network blip — serve the last good keys if we have them, else fail closed.
    return cached?.keys ?? null;
  }
};

/**
 * A top-level browser navigation (vs. an API/programmatic fetch). The Access
 * app fronts `/logs`, `/demos`, `/replay`, `/v1/executions` at the edge and
 * 302s those to SSO before the Worker sees them — but the dashboard `/` is NOT
 * an Access destination (a bare `/` would prefix-match every machine path —
 * `/v1/dispatch`, `/v1/webhooks`, `/v1/artifacts`, … — and break CI), so `/`
 * reaches the Worker un-gated. For a browser landing there with no Access
 * identity we send it INTO the Access login flow ourselves (302), rather than
 * the 403 JSON an API caller gets. After SSO the host-scoped `CF_Authorization`
 * cookie carries the JWT back, and the next `/` request verifies and renders.
 */
const isBrowserNavigation = (request: Request): boolean => {
  if (request.headers.get("Sec-Fetch-Mode") === "navigate") return true;
  return (request.headers.get("Accept") ?? "").includes("text/html");
};

/**
 * The Access login URL for this team + application, returning the browser to
 * `request`'s own path after SSO. Shape mirrors the 302 Access itself issues
 * for a gated destination: `<issuer>/cdn-cgi/access/login/<app-host>?kid=<aud>&
 * redirect_url=<path>` (the optional signed `meta` hint Access adds is not
 * required — the flow works without it).
 */
export const accessLoginUrl = (
  teamDomain: string,
  aud: string,
  request: Request,
): string => {
  const reqUrl = new URL(request.url);
  const params = new URLSearchParams({
    kid: aud,
    redirect_url: `${reqUrl.pathname}${reqUrl.search}`,
  });
  return `${accessIssuer(teamDomain)}/cdn-cgi/access/login/${reqUrl.host}?${params.toString()}`;
};

/** Pull the Access JWT from the header, falling back to the cookie. */
const readAccessJwt = (request: Request): string | null => {
  const header = request.headers.get(ACCESS_JWT_HEADER);
  if (header !== null && header.length > 0) return header;
  const cookie = request.headers.get("Cookie");
  if (cookie === null) return null;
  for (const pair of cookie.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === ACCESS_JWT_COOKIE) {
      const value = pair.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
};

/**
 * Gate a viewer surface behind Cloudflare Access. Returns `null` when the
 * request may proceed (mode is `token-only`, or a valid Access JWT was
 * presented), or an error `Response` to return as-is:
 *
 *   503 access_not_configured — mode "required" but ACCESS_AUD / ACCESS_TEAM_DOMAIN unset
 *   403 access_denied         — JWT missing or failed verification
 *
 * The capability-token gate (log-auth.ts) still runs AFTER this for the routes
 * that have one — Access is an additional first factor, not a replacement.
 */
export const gateViewerAccess = async (
  env: Env,
  request: Request,
): Promise<Response | null> => {
  if (resolveViewerAccessMode(env) === "token-only") return null;

  const aud = env.ACCESS_AUD;
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  if (
    aud === undefined ||
    aud === "" ||
    teamDomain === undefined ||
    teamDomain === ""
  ) {
    return json(
      {
        error: "access_not_configured",
        message:
          "viewer surfaces require Cloudflare Access (set ACCESS_AUD + ACCESS_TEAM_DOMAIN), or set VIEWER_ACCESS_MODE=token-only to opt out",
      },
      503,
    );
  }

  const jwt = readAccessJwt(request);
  if (jwt === null) {
    // A browser landing on an un-gated viewer surface (the dashboard `/`) with
    // no Access identity: bounce it into the SSO login instead of stranding it
    // on a 403 JSON. API/programmatic callers still get the machine-readable
    // 403 (they can't complete an interactive login anyway).
    if (isBrowserNavigation(request)) {
      return Response.redirect(accessLoginUrl(teamDomain, aud, request), 302);
    }
    return json(
      {
        error: "access_denied",
        message:
          "no Cloudflare Access identity on this request — reach this surface through your Access application, not the Worker origin directly",
      },
      403,
    );
  }

  const issuer = accessIssuer(teamDomain);
  const nowMs = Date.now();
  const keys = await fetchAccessCerts(issuer, nowMs);
  if (keys === null || keys.length === 0) {
    return json(
      {
        error: "access_denied",
        message: "could not load Cloudflare Access verification keys",
      },
      403,
    );
  }

  const ok = await verifyAccessJwt(jwt, {
    keys,
    aud,
    issuer,
    nowSeconds: Math.floor(nowMs / 1000),
  });
  if (!ok) {
    return json(
      { error: "access_denied", message: "invalid Cloudflare Access token" },
      403,
    );
  }
  return null;
};
