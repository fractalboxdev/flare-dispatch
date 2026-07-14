// FlareDispatch Dispatcher — GitHub team membership for deploy authorization.
//
// Cloudflare's GitHub IdP does NOT surface org/teams in `/cdn-cgi/access/get-identity`
// — a `groups` lookup on the Access identity always comes back empty (verified
// live). Team membership exists ONLY at the Access edge, which uses it to admit
// the request but never forwards it to the origin.
//
// So to keep GitHub teams as the management surface for per-environment deploy
// rights, the Worker asks GitHub itself: given the caller's GitHub login (from
// the Access identity) it checks membership of exactly the teams the policy
// references — `GET /orgs/{org}/teams/{slug}/memberships/{login}` — using the
// installed App's installation token (the same one the commit dropdown mints).
//
// Only policy-referenced teams are probed (never the org's full team list), so
// this is 1–2 API calls per page load, on top of an isolate-cached token.
//
// REQUIRES the GitHub App to hold **Organization permissions → Members: Read**.
// Without it every check 403s → no groups resolve → the `githubTeams` policy
// axis denies (fail-closed), which is why the rollout order is: grant the
// permission first, THEN switch `deploy.env-authz` back to `githubTeams`.
//
// `splitTeam` is pure and unit-tested (github-teams.test.ts).

import {
  getInstallationToken,
  resolveRepoInstallationId,
} from "@fractalboxdev/flare-dispatch-github-app";
import type { Env } from "./env";

const API_BASE = "https://api.github.com";

const ghHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "flare-dispatch",
});

/** Split an `"org/team"` policy entry; null when it isn't that shape. */
export const splitTeam = (
  entry: string,
): { readonly org: string; readonly slug: string } | null => {
  const slash = entry.indexOf("/");
  if (slash <= 0 || slash === entry.length - 1) return null;
  return { org: entry.slice(0, slash), slug: entry.slice(slash + 1) };
};

/**
 * Mint an installation token. The installation is resolved from `anchorRepo`
 * (any repo the App is installed on in the org) — the org installation is what
 * grants the org-level `members: read` scope we need.
 */
const installationToken = async (
  env: Env,
  anchorRepo: string,
): Promise<string | null> => {
  const appId = env.GITHUB_APP_ID;
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY;
  if (appId === undefined || privateKeyPem === undefined) return null;
  try {
    const installationId = await resolveRepoInstallationId({
      appId,
      privateKeyPem,
      repo: anchorRepo,
    });
    return await getInstallationToken({ appId, privateKeyPem, installationId });
  } catch {
    return null;
  }
};

/**
 * Is `login` an ACTIVE member of `org/slug`? GitHub answers 200 with
 * `{ state: "active" | "pending" }`, or 404 when not a member. A `pending`
 * invite is deliberately NOT membership. Any other status (403 = the App lacks
 * `members: read`) is treated as "not a member" — fail-closed.
 */
const isTeamMember = async (
  token: string,
  org: string,
  slug: string,
  login: string,
): Promise<boolean> => {
  try {
    const res = await fetch(
      `${API_BASE}/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/memberships/${encodeURIComponent(login)}`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { state?: unknown };
    return body.state === "active";
  } catch {
    return false;
  }
};

/**
 * The subset of `teams` (each `"org/team"`) that `login` actually belongs to.
 * Returns `[]` when the App can't serve the lookup — fail-closed, never throws.
 */
export const resolveTeamMemberships = async (
  env: Env,
  login: string,
  teams: readonly string[],
  anchorRepo: string,
): Promise<readonly string[]> => {
  if (login === "" || teams.length === 0) return [];
  const token = await installationToken(env, anchorRepo);
  if (token === null) return [];

  const checks = await Promise.all(
    teams.map(async (entry) => {
      const parsed = splitTeam(entry);
      if (parsed === null) return null;
      const member = await isTeamMember(token, parsed.org, parsed.slug, login);
      return member ? entry : null;
    }),
  );
  return checks.filter((t): t is string => t !== null);
};
