// @fractalboxdev/flare-dispatch-github-app — public API.
//
// GitHub App authentication helpers for the FlareDispatch check-run callback:
//
//   * `signAppJwt`           — RS256 App JWT from the PEM private key.
//   * `getInstallationToken` — exchange the JWT for a short-lived installation
//                              token (in-memory cached, per Worker isolate).
//   * `createCheckRun` / `updateCheckRun` — post the run verdict.
//
// Provider-neutral fetch code: plain typed `async` functions, no Effect
// dependency. The Effect Layer (`ChecksGithubLive` in @fractalboxdev/flare-dispatch-runtime-cf)
// wraps these.
//
// Spec: specs/04-gha-integration.md § Check-runs callback, specs/pm/plan.md
// § PR6.

export { signAppJwt, type SignAppJwtOptions } from "./jwt";
export {
  getInstallationToken,
  resolveRepoInstallationId,
  __clearTokenCache,
  __clearRepoInstallationCache,
  type GetInstallationTokenOptions,
  type ResolveRepoInstallationOptions,
} from "./installation-token";
export {
  createCheckRun,
  progressCheckRun,
  updateCheckRun,
  type CheckConclusion,
  type CheckRunOutput,
  type CreateCheckRunOptions,
  type ProgressCheckRunOptions,
  type UpdateCheckRunOptions,
} from "./check-runs";
export { createPullReview, type PullReviewEvent, type CreatePullReviewOptions } from "./reviews";
export {
  listActionRuns,
  actionRunsUrl,
  normalizeRun,
  type ActionRun,
  type ListActionRunsOptions,
} from "./actions";
export {
  openDraftPullRequest,
  commitFilesAndOpenPr,
  treeEntry,
  deletionEntry,
  type FileEdit,
  type FileDeletion,
  type TreeEntry,
  type CommitFilesOptions,
  type CommitFilesResult,
  type OpenDraftPullRequestOptions,
  type OpenDraftPullRequestResult,
} from "./pull-requests";
export {
  listPullRequests,
  normalizePullRequest,
  pullRequestsUrl,
  type ListPullRequestsOptions,
  type PullRequestSummary,
} from "./pull-request-list";
export {
  readRepoTextFile,
  repoContentsUrl,
  type ReadRepoTextFileOptions,
  type ReadRepoTextFileResult,
} from "./repo-files";
export { createRelease, type CreateReleaseOptions, type CreateReleaseResult } from "./releases";
export {
  fetchPublicAppRegistration,
  diffRegistration,
  hasFailingDrift,
  appSettingsUrl,
  type AppRegistration,
  type DesiredRegistration,
  type PermissionDrift,
  type RegistrationDrift,
  type FetchAppRegistrationOptions,
} from "./registration";
export { GithubApiError } from "./errors";
