// FlareDispatch Dispatcher — per-environment deploy authorization policy.
//
// The deploy console (`/deploy`) decides WHICH environments an authenticated
// Cloudflare Access identity may deploy to. Authentication is the Access JWT
// (edge SSO + in-Worker verify — deploy-access.ts); this module is the pure
// AUTHORIZATION core layered on top: identity → allowed environments.
//
// The policy lives in CONFIG_KV under `deploy.env-authz`, so it is editable
// without a code deploy. Two authorization axes, matching the login methods the
// deploy Access app offers:
//   * `githubTeams` — a GitHub org/team the identity belongs to (from the GitHub
//     IdP, surfaced via `/cdn-cgi/access/get-identity` groups). Entries are
//     `"org/team"` (matched full) or a bare `"team"` slug (matched loose).
//   * `emails`      — an explicit allowlist; the ONLY axis a one-time-PIN (email)
//     login can satisfy, since an OTP session carries no group membership.
// A per-env `requireGithubLogin: true` additionally demands the identity
// authenticated via GitHub (not OTP) — an OTP session, even to an allowlisted
// inbox, is refused. This is the "OTP can't reach production" guard: an OTP
// login to a compromised mailbox must never escalate into a gated environment.
//
// Pure + total: `allowedEnvs(identity, policy)` is data→data with no I/O,
// unit-tested in deploy-authz.test.ts. deploy-access.ts does the I/O (verify +
// get-identity) and routes/deploy.ts wires it to the HTTP surface.

/** One environment's authorization rule (a `deploy.env-authz` value entry). */
export interface EnvRule {
  /** GitHub org/team memberships that grant this env (`"org/team"` or `"team"`). */
  readonly githubTeams?: readonly string[];
  /** Explicit email allowlist that grants this env. */
  readonly emails?: readonly string[];
  /** Any authenticated identity may deploy this env (use sparingly). */
  readonly anyAuthenticated?: boolean;
  /** Require a GitHub login (not OTP) on top of the grant above. */
  readonly requireGithubLogin?: boolean;
}

/** The whole policy — environment name → its rule. */
export type EnvAuthzPolicy = Readonly<Record<string, EnvRule>>;

/** The identity fields an authorization decision reads (from get-identity). */
export interface DeployIdentity {
  readonly email: string;
  /** The login method that authenticated this session — e.g. "github", "onetimepin". */
  readonly idp: string;
  /**
   * The caller's GitHub username, when the Access identity carries one ("" if
   * not). Cloudflare's GitHub IdP does NOT put org/teams in `get-identity`, so
   * this is the key we resolve real team membership with, against the GitHub
   * API (github-teams.ts) — that result lands in `groups` below.
   */
  readonly login: string;
  /** Normalized group identifiers — GitHub `org/team` slugs once resolved. */
  readonly groups: readonly string[];
}

/**
 * Every distinct GitHub team the policy references (`"org/team"` entries),
 * deduped. Only these need a membership lookup — we never enumerate the org's
 * whole team list, just the ones authorization actually depends on.
 */
export const policyTeams = (policy: EnvAuthzPolicy): readonly string[] => {
  const seen = new Set<string>();
  for (const rule of Object.values(policy)) {
    for (const team of rule.githubTeams ?? []) {
      if (team.includes("/")) seen.add(team);
    }
  }
  return [...seen].sort();
};

const norm = (s: string): string => s.trim().toLowerCase();

/** Did this identity authenticate via GitHub (vs. one-time-PIN / other)? */
export const isGithubLogin = (identity: DeployIdentity): boolean =>
  norm(identity.idp).includes("github");

/**
 * Whether the identity satisfies a single GitHub-team requirement. Matches the
 * full `org/team` OR the bare `team` slug, case-insensitively, against any group
 * identifier surfaced by get-identity — Cloudflare's GitHub IdP may present a
 * team as `"org/team"` or as a bare team name depending on configuration.
 */
const identityInTeam = (identity: DeployIdentity, team: string): boolean => {
  const wanted = norm(team);
  const bare = wanted.includes("/") ? wanted.slice(wanted.lastIndexOf("/") + 1) : wanted;
  return identity.groups.some((g) => {
    const gg = norm(g);
    return gg === wanted || gg === bare;
  });
};

/** Does one rule grant this identity? `requireGithubLogin` gates first. */
const ruleAllows = (identity: DeployIdentity, rule: EnvRule): boolean => {
  if (rule.requireGithubLogin === true && !isGithubLogin(identity)) return false;
  if (rule.anyAuthenticated === true) return true;
  if (rule.emails?.some((e) => norm(e) === norm(identity.email)) === true) return true;
  if (rule.githubTeams?.some((t) => identityInTeam(identity, t)) === true) return true;
  return false;
};

/**
 * The environments this identity may deploy to, sorted for a stable render.
 * A fail-CLOSED function: an env whose rule the identity does not satisfy is
 * simply absent from the result (never surfaced with a deploy button).
 */
export const allowedEnvs = (
  identity: DeployIdentity,
  policy: EnvAuthzPolicy,
): readonly string[] =>
  Object.entries(policy)
    .filter(([, rule]) => ruleAllows(identity, rule))
    .map(([name]) => name)
    .sort();

/** Does deploying this env require the human-approval + cooldown gate? */
export const envRequiresApproval = (env: string, policy: EnvAuthzPolicy): boolean =>
  policy[env]?.requireGithubLogin === true;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Coerce one raw JSON value into an `EnvRule`, dropping unknown/mistyped keys. */
const toRule = (raw: unknown): EnvRule => {
  if (raw === null || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  return {
    ...(isStringArray(r["githubTeams"]) ? { githubTeams: r["githubTeams"] } : {}),
    ...(isStringArray(r["emails"]) ? { emails: r["emails"] } : {}),
    ...(r["anyAuthenticated"] === true ? { anyAuthenticated: true } : {}),
    ...(r["requireGithubLogin"] === true ? { requireGithubLogin: true } : {}),
  };
};

/**
 * Parse the `deploy.env-authz` CONFIG_KV value into a policy. Total: a null,
 * non-JSON, or non-object value yields an EMPTY policy (no env is deployable) —
 * fail-closed, never throws. Individual malformed rules degrade to `{}`.
 */
export const parseEnvAuthzPolicy = (raw: string | null): EnvAuthzPolicy => {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, EnvRule> = {};
  for (const [env, rule] of Object.entries(parsed as Record<string, unknown>)) {
    out[env] = toRule(rule);
  }
  return out;
};

/** The CONFIG_KV key the deploy-console policy lives under. */
export const ENV_AUTHZ_KEY = "deploy.env-authz";
