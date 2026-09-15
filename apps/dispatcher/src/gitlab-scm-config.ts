// FlareDispatch Dispatcher — GitLab `scm` Layer config, derived from env vars.
//
// PURE, split out of workflow-gitlab.ts (which imports `cloudflare:workers`,
// unresolvable in a plain-Node test) so the token/base-URL hygiene rules are
// unit-testable directly, the same reasoning as gitlab-review-outcome.ts.

/** The env slice this module reads — a structural subset of `Env`. */
export type GitlabScmEnv = {
  readonly GITLAB_TOKEN?: string;
  readonly GITLAB_BASE_URL?: string;
};

/** What `makeGitlabScmLive` (`@fractalboxdev/flare-dispatch-runtime-cf`) accepts. */
export type GitlabScmConfig = {
  readonly token?: string;
  readonly baseUrl?: string;
};

/**
 * Build `makeGitlabScmLive`'s config from the Worker's env. Both fields are
 * TRIMMED, and a blank or whitespace-only `GITLAB_TOKEN` / `GITLAB_BASE_URL`
 * is treated as ABSENT — never as a valid credential or override — mirroring
 * the same rule the webhook route already applies to `GITLAB_WEBHOOK_SECRET`
 * and to `GITLAB_TOKEN` at its own throttle-note call site.
 */
export const gitlabScmConfig = (env: GitlabScmEnv): GitlabScmConfig => {
  const token = env.GITLAB_TOKEN?.trim();
  const baseUrl = env.GITLAB_BASE_URL?.trim();
  return {
    ...(token !== undefined && token.length > 0 ? { token } : {}),
    ...(baseUrl !== undefined && baseUrl.length > 0 ? { baseUrl } : {}),
  };
};
