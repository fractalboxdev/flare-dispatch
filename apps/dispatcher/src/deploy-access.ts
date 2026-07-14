// FlareDispatch Dispatcher — Cloudflare Access gate for the deploy console.
//
// `/deploy` is a privileged WRITE surface with its OWN Access application (a
// distinct AUD from the viewer app), so it can't ride the viewer gate
// (access-auth.ts, keyed on `ACCESS_AUD` / `VIEWER_ACCESS_MODE`). This module is
// the deploy-side counterpart: it verifies the Access JWT against
// `DEPLOY_ACCESS_AUD` and then resolves the caller's FULL identity — email,
// login method, and GitHub org/team groups — from `/cdn-cgi/access/get-identity`
// (the JWT itself carries no group membership). deploy-authz.ts turns that
// identity into the set of deployable environments.
//
// It reuses the verified crypto/JWKS primitives EXPORTED from access-auth.ts
// (single source of truth for RS256 verification + the JWKS rotation retry),
// with its own revalidation cooldown so the two gates don't share mutable state.
//
// `normalizeIdentity` is pure and unit-tested (deploy-access.test.ts); the fetch
// + gate are the I/O seam routes/deploy.ts calls.

import {
  accessIssuer,
  accessLoginUrl,
  fetchAccessCerts,
  isBrowserNavigation,
  jwtHasKnownKid,
  readAccessJwt,
  verifyAccessJwt,
} from "./access-auth";
import type { DeployIdentity } from "./deploy-authz";
import type { Env } from "./env";

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---------------------------------------------------------------------------
// Identity normalization (pure — exported for tests).
// ---------------------------------------------------------------------------

/** The get-identity fields we read — everything optional/defensive. */
interface RawGroup {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly email?: unknown;
}
interface RawIdentity {
  readonly email?: unknown;
  readonly idp?: { readonly type?: unknown; readonly id?: unknown } | string;
  readonly groups?: readonly RawGroup[];
}

const pushStr = (into: string[], v: unknown): void => {
  if (typeof v === "string" && v.length > 0) into.push(v);
};

/**
 * Flatten a get-identity response into the `DeployIdentity` the authz core
 * reads. GitHub org/team memberships arrive in `groups[]`; Cloudflare's exact
 * per-group shape varies, so we collect every string identifier (name, email,
 * id) and let `allowedEnvs` match loosely. Total: missing fields degrade to
 * empty, never throw.
 */
export const normalizeIdentity = (raw: RawIdentity): DeployIdentity => {
  const email = typeof raw.email === "string" ? raw.email : "";
  const idp =
    typeof raw.idp === "string"
      ? raw.idp
      : typeof raw.idp?.type === "string"
        ? raw.idp.type
        : "";
  const groups: string[] = [];
  for (const g of raw.groups ?? []) {
    pushStr(groups, g.name);
    pushStr(groups, g.email);
    pushStr(groups, g.id);
  }
  return { email, idp, groups };
};

/**
 * Fetch the caller's full identity from `<issuer>/cdn-cgi/access/get-identity`,
 * forwarding their Access cookie. Returns null on any failure (fail-closed —
 * the gate then denies rather than authorizing an unresolved identity).
 */
export const fetchDeployIdentity = async (
  issuer: string,
  jwt: string,
): Promise<DeployIdentity | null> => {
  try {
    const res = await fetch(`${issuer}/cdn-cgi/access/get-identity`, {
      headers: { cookie: `CF_Authorization=${jwt}` },
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as RawIdentity;
    return normalizeIdentity(raw);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

/** JWKS revalidation cooldown — mirrors access-auth.ts, own state per gate. */
const REVALIDATE_COOLDOWN_MS = 30_000;
let lastRevalidateMs = 0;

/** Visible for tests — reset the revalidation cooldown between cases. */
export const clearDeployCertsCooldown = (): void => {
  lastRevalidateMs = 0;
};

/** The outcome of gating a `/deploy` request. */
export type DeployGateResult =
  | { readonly ok: true; readonly identity: DeployIdentity }
  | { readonly ok: false; readonly response: Response };

/**
 * Gate a `/deploy` request behind the deploy Access application, then resolve
 * the caller's identity. Mirrors the viewer gate's posture — default-deny when
 * unconfigured (503), browser-navigation bounce to SSO login vs. 403 JSON for
 * programmatic callers, and a one-shot JWKS revalidation on a rotated-key miss.
 */
export const gateDeploy = async (
  env: Env,
  request: Request,
): Promise<DeployGateResult> => {
  const aud = env.DEPLOY_ACCESS_AUD;
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  if (aud === undefined || aud === "" || teamDomain === undefined || teamDomain === "") {
    return {
      ok: false,
      response: json(
        {
          error: "access_not_configured",
          message:
            "the deploy console requires Cloudflare Access (set DEPLOY_ACCESS_AUD + ACCESS_TEAM_DOMAIN)",
        },
        503,
      ),
    };
  }

  const jwt = readAccessJwt(request);
  if (jwt === null) {
    if (isBrowserNavigation(request)) {
      return {
        ok: false,
        response: Response.redirect(accessLoginUrl(teamDomain, aud, request), 302),
      };
    }
    return {
      ok: false,
      response: json(
        {
          error: "access_denied",
          message:
            "no Cloudflare Access identity — reach /deploy through your Access application, not the Worker origin directly",
        },
        403,
      ),
    };
  }

  const issuer = accessIssuer(teamDomain);
  const nowMs = Date.now();
  let keys = await fetchAccessCerts(issuer);
  if (keys === null || keys.length === 0) {
    return {
      ok: false,
      response: json(
        { error: "access_denied", message: "could not load Cloudflare Access verification keys" },
        403,
      ),
    };
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  let ok = await verifyAccessJwt(jwt, { keys, aud, issuer, nowSeconds });
  if (!ok && !jwtHasKnownKid(keys, jwt) && nowMs - lastRevalidateMs > REVALIDATE_COOLDOWN_MS) {
    lastRevalidateMs = nowMs;
    const fresh = await fetchAccessCerts(issuer, { revalidate: true });
    if (fresh !== null && fresh.length > 0) {
      keys = fresh;
      ok = await verifyAccessJwt(jwt, { keys, aud, issuer, nowSeconds });
    }
  }
  if (!ok) {
    return {
      ok: false,
      response: json({ error: "access_denied", message: "invalid Cloudflare Access token" }, 403),
    };
  }

  const identity = await fetchDeployIdentity(issuer, jwt);
  if (identity === null) {
    return {
      ok: false,
      response: json(
        {
          error: "identity_unavailable",
          message: "could not resolve your Access identity (get-identity) — try re-authenticating",
        },
        403,
      ),
    };
  }
  return { ok: true, identity };
};
