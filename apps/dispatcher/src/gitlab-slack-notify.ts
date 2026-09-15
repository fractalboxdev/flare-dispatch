// FlareDispatch Dispatcher — GitLab MR-review Slack failure notification.
//
// A best-effort, fire-and-forget alert for the operator: when a review ends
// `failure` or `skipped-quota` AND the optional `SLACK_WEBHOOK_URL` secret is
// set, GitlabReviewWorkflow's `notify-failure` step (workflow-gitlab.ts) POSTs
// a plain-text message here. Split in two so the message SHAPE is unit-testable
// without a network call:
//
//   * `buildSlackFailureMessage` — PURE. Builds the `{ text }` payload a Slack
//     incoming webhook expects (plain text + mrkdwn links, no Block Kit — a
//     webhook needs nothing fancier for one alert line).
//   * `postSlackFailureNotification` — the I/O. Never throws: a bad webhook
//     URL, a non-2xx, or a network failure is logged and swallowed, because a
//     Slack outage must never fail the Workflow (the MR note is the record of
//     truth; Slack is a convenience ping on top of it).

/** What the Slack message needs to know about one failed/degraded review. */
export type SlackFailureNotifyInput = {
  /** GitLab numeric project id or `"group/project"` path. */
  readonly projectId: string;
  /** The merge-request `iid`. */
  readonly iid: number;
  /** The project's web URL — the base for the MR / note links. */
  readonly projectWebUrl: string;
  /** MR title, when the webhook payload carried one — falls back to `project/iid`. */
  readonly title?: string;
  /** The reviewed head sha (truncated to 12 chars for the message). */
  readonly headSha: string;
  /** The posted/updated note's id, when there is one — links straight to the note. */
  readonly noteId: string | null;
  readonly status: "failure" | "skipped-quota" | "note-not-posted";
  /** Plain-text reason — truncated to 200 chars here (never trust the caller to). */
  readonly reason: string;
  /** How many times the review step ran (2 when its retry was exhausted, else 1). */
  readonly attempts: number;
  /** The Workflow instance id — only used when `accountId` is also set. */
  readonly executionId: string;
  /** `env.WORKFLOW_NAME` — defaults to `gitlab-review` (the example config's own name). */
  readonly workflowName?: string;
  /** `env.CLOUDFLARE_ACCOUNT_ID` — the Workflow-instance link is omitted without it. */
  readonly accountId?: string;
};

/** Default Workflow name — matches `wrangler.gitlab.example.jsonc`'s `workflows[].name`. */
const DEFAULT_WORKFLOW_NAME = "gitlab-review";

/** Longest reason text the message carries (matches the note's own truncation). */
const MAX_REASON_CHARS = 200;

/**
 * Escape Slack mrkdwn's three special characters — per Slack's documented
 * escaping rules, `&` MUST be escaped first so it doesn't double-escape the
 * entities just produced for `<` / `>`. Both the MR title and the failure
 * reason are untrusted text (an MR title an author wrote; a reason string
 * that can echo backend/model output) — unescaped, a `>` closes a `<url|text>`
 * link early and any text after it becomes clickable, and a `<...|...>` inside
 * either field would inject an attacker-chosen link into the message.
 */
const escapeMrkdwn = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Build the Slack incoming-webhook payload for a failed/degraded MR review —
 *  PURE, no I/O. `{ text }` only (plain text + mrkdwn links, no Block Kit). */
export const buildSlackFailureMessage = (
  input: SlackFailureNotifyInput,
): { readonly text: string } => {
  const subject = escapeMrkdwn(
    input.title !== undefined && input.title.trim().length > 0
      ? input.title
      : `${input.projectId}/${input.iid}`,
  );
  const mrUrl = `${input.projectWebUrl.replace(/\/$/, "")}/-/merge_requests/${input.iid}`;
  const noteUrl = input.noteId !== null ? `${mrUrl}#note_${input.noteId}` : mrUrl;
  const sha12 = input.headSha.slice(0, 12);
  const reason = escapeMrkdwn(input.reason.slice(0, MAX_REASON_CHARS));
  const statusWord =
    input.status === "skipped-quota"
      ? "skipped (quota exhausted)"
      : input.status === "note-not-posted"
        ? "finished, but the note was not posted"
        : "failed";
  const attemptsWord = input.attempts === 1 ? "1 attempt" : `${input.attempts} attempts`;

  const lines = [
    `:warning: flare-dispatch MR review ${statusWord} — <${noteUrl}|${subject}>`,
    `head \`${sha12}\` · status \`${input.status}\` · ${attemptsWord}`,
    `reason: ${reason}`,
  ];

  if (input.accountId !== undefined && input.accountId.trim().length > 0) {
    // A blank/whitespace-only WORKFLOW_NAME is treated the same as absent —
    // never interpolated verbatim into the dashboard URL, which would leave
    // a malformed `.../workflows//instance/...` link.
    const workflowName =
      input.workflowName !== undefined && input.workflowName.trim().length > 0
        ? input.workflowName
        : DEFAULT_WORKFLOW_NAME;
    const wfUrl = `https://dash.cloudflare.com/${input.accountId}/workers/workflows/${workflowName}/instance/${input.executionId}`;
    lines.push(`<${wfUrl}|Workflow instance>`);
  }

  return { text: lines.join("\n") };
};

/** The POST's wall-clock budget — a hung Slack webhook must not hang the
 *  `notify-failure` step (and so the Workflow) alongside it. */
const POST_TIMEOUT_MS = 10_000;

/**
 * Redact the webhook URL out of a caught error's message before logging it —
 * some `fetch` failures (a malformed URL, in particular) echo the URL back
 * in `Error#message`, and the URL is a bearer credential: anyone who can post
 * to it can post as this Slack app. `wrangler tail` output is not as tightly
 * held as a secret store.
 */
const redactWebhookUrl = (message: string, webhookUrl: string): string =>
  message.split(webhookUrl).join("<redacted>");

/**
 * POST the message to the Slack incoming-webhook URL. Best-effort: any
 * failure (network, non-2xx, or exceeding the {@link POST_TIMEOUT_MS} budget)
 * is logged (without the webhook URL — see {@link redactWebhookUrl}) and
 * swallowed — a Slack outage must never fail the Workflow. Returns whether
 * the POST was accepted (2xx).
 */
export const postSlackFailureNotification = async (
  webhookUrl: string,
  message: { readonly text: string },
): Promise<boolean> => {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[gitlab-review] Slack notify failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    const errMessage = e instanceof Error ? e.message : String(e);
    console.warn(`[gitlab-review] Slack notify failed: ${redactWebhookUrl(errMessage, webhookUrl)}`);
    return false;
  }
};
