// The committed GitHub App manifest: the permissions and events specs/github-output.md § App registration lists, and
// nothing else (FD-OPS-076). The drift check compares the registered App against it (FD-OPS-022, FD-OPS-023).
import type { AppPermissions } from "./drift.ts";

export const APP_PERMISSIONS: AppPermissions = {
  default_permissions: {
    checks: "write",
    contents: "write",
    pull_requests: "write",
    issues: "write",
    metadata: "read",
    actions: "read",
    administration: "read",
    deployments: "read",
    merge_queues: "read",
  },
  default_events: [
    "pull_request",
    "push",
    "merge_group",
    "check_run",
    "check_suite",
    "deployment_status",
    "installation",
    "installation_repositories",
    "repository_ruleset",
    "branch_protection_rule",
  ],
};

/** The manifest the install flow posts to GitHub, for the dispatcher at `origin`. */
export const appManifest = (origin: string, name = "FlareDispatch") => ({
  name,
  url: origin,
  hook_attributes: { url: `${origin}/v1/webhooks/github`, active: true },
  redirect_url: `${origin}/v1/github/install/callback`,
  public: false,
  ...APP_PERMISSIONS,
});
