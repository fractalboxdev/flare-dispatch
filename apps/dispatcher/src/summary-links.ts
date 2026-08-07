// FlareDispatch Dispatcher — the log-link suffix on check-run summaries.
//
// Every check-run summary a `RunWorkflow` posts — the `in_progress` opener AND
// the completed verdict, success and failure alike, on every dispatch path
// (Action, webhook, deploy, Slack, cron) — carries the same pair of log links,
// assembled here so the opener and the verdict cannot drift:
//
//   * `detailsUrl` — the Cloudflare Workflows instance page (dashboard-url.ts),
//     the operator's step timeline. Only reachable with dashboard access to
//     the deploy's Cloudflare account.
//   * `logsUrl` — the tokened readable log viewer
//     (`/logs/<execution>?t=<token>`, log-token.ts `buildLogsUrl`), which is
//     the surface a PR reviewer on the Checks tab can actually open. The same
//     viewer the SSR dashboard at `GET /` deep-links per execution.
//
// Either link drops out cleanly when its precondition is missing
// (`CLOUDFLARE_ACCOUNT_ID` unset → no dashboard link; no public origin or no
// log-link key material, see log-token.ts `resolveLogLinkSecret` → no viewer
// link), so a degenerate deploy renders the historical link-less summary
// rather than broken markdown. Same omit-not-break posture as the dispatch
// 202's `logsUrl` field (routes/dispatch.ts).

/** The two per-execution log surfaces a summary can link. Both optional. */
export interface SummaryLogLinks {
  /** Cloudflare Workflows instance page — `undefined` without an account id. */
  readonly detailsUrl?: string;
  /**
   * Tokened log-viewer URL — `undefined` without a public origin or log-link
   * key material.
   */
  readonly logsUrl?: string;
}

/**
 * The ` — [view … ↗](…)` suffix appended to every summary verdict line.
 * `""` when neither link is available, so callers append unconditionally.
 */
export const logLinksSuffix = (links: SummaryLogLinks): string => {
  const cf =
    links.detailsUrl !== undefined
      ? ` — [view step logs in Cloudflare ↗](${links.detailsUrl})`
      : "";
  const viewer =
    links.logsUrl !== undefined ? ` — [view full logs ↗](${links.logsUrl})` : "";
  return `${cf}${viewer}`;
};

/**
 * The `in_progress` opener summary. Links the execution id to the Workflows
 * instance page (when available) and appends the shared suffix — logs are
 * discoverable from the moment the check-run appears, not only at the verdict.
 */
export const startedSummary = (executionId: string, links: SummaryLogLinks): string => {
  const idMd =
    links.detailsUrl !== undefined
      ? `[\`${executionId}\`](${links.detailsUrl})`
      : `\`${executionId}\``;
  const suffix = logLinksSuffix(links);
  return suffix === "" ? `Execution ${idMd} started.` : `Execution ${idMd} started${suffix}`;
};
