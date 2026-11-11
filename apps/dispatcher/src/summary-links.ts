// FlareDispatch Dispatcher — the log link on check-run summaries.
//
// Every check-run summary a `RunWorkflow` posts — the `in_progress` opener AND
// the completed verdict, success and failure alike, on every dispatch path
// (Action, webhook, deploy, Slack, cron) — carries the same log link,
// assembled here so the opener and the verdict cannot drift: the tokened
// readable log viewer (`/logs/<execution>?t=<token>`, log-token.ts
// `buildLogsUrl`), the surface a PR reviewer on the Checks tab can open.
//
// A check-run is as public as its repository, so it never carries the
// Cloudflare dashboard URL: that URL embeds the deploying account's id and
// opens only for that account's members. Operators reach the dashboard link
// through the Access-gated executions API and log viewer (routes/executions.ts).
//
// The link drops out cleanly when its precondition is missing (no public
// origin or no log-link key material, see log-token.ts `resolveLogLinkSecret`),
// so a degenerate deploy renders the link-less summary rather than broken
// markdown. Same omit-not-break posture as the dispatch 202's `logsUrl` field
// (routes/dispatch.ts).

/** The per-execution log surface a summary can link. */
export interface SummaryLogLinks {
  /**
   * Tokened log-viewer URL — `undefined` without a public origin or log-link
   * key material.
   */
  readonly logsUrl?: string;
}

/**
 * The ` — [view full logs ↗](…)` suffix appended to every summary verdict line.
 * `""` when no link is available, so callers append unconditionally.
 */
export const logLinksSuffix = (links: SummaryLogLinks): string =>
  links.logsUrl !== undefined ? ` — [view full logs ↗](${links.logsUrl})` : "";

/**
 * The `in_progress` opener summary, with the shared suffix — logs are
 * discoverable from the moment the check-run appears, not only at the verdict.
 */
export const startedSummary = (executionId: string, links: SummaryLogLinks): string => {
  const suffix = logLinksSuffix(links);
  return suffix === ""
    ? `Execution \`${executionId}\` started.`
    : `Execution \`${executionId}\` started${suffix}`;
};
