// FlareDispatch Dispatcher — the GitLab `review` step's retry/timeout budget,
// as ONE shared source of truth.
//
// Two very different consumers need these same numbers:
//
//   - workflow-gitlab.ts builds the actual `WorkflowStepConfig` from them —
//     it alone may import `cloudflare:workers`.
//   - gitlab-review-outcome.ts renders the attempt count and the timeout
//     wording into the note body and the Slack message — it must stay
//     plain-Node-testable (no `cloudflare:workers`), so it takes these as
//     plain data, never as a `WorkflowStepConfig`.
//
// Splitting this out means the two files bump together automatically instead
// of by convention: before this module existed, each side kept its OWN copy
// of the retry limit / attempt count / timeout text, with a comment asking
// whoever changed one to remember the other.
//
// PURE — no imports, so both sides can depend on it without pulling in
// anything the other can't.

/**
 * How many RETRIES the `review` step gets after its first attempt — CF's
 * default (5) turned one slow full-tier review into a 37-minute run and two
 * silent errored instances on a live deployment. One
 * retry covers a transient platform error; a second timeout is never worth a
 * third attempt.
 */
export const REVIEW_STEP_RETRY_LIMIT = 1;

/**
 * Total attempts the `review` step makes before giving up — the first try
 * plus every retry.
 */
export const REVIEW_STEP_ATTEMPTS = REVIEW_STEP_RETRY_LIMIT + 1;

/**
 * The step's per-attempt wall-clock budget, as the exact string
 * `WorkflowStepConfig.timeout` accepts (a CF Workflows duration literal). A
 * full-tier review over a 30k-char diff needed more than ten minutes, so the
 * step gets 25 minutes and finishes (the duration lands in D1 for the
 * bake-off) instead of dying unmeasured.
 */
export const REVIEW_STEP_TIMEOUT = "25 minutes";
