// The Cloudflare dashboard deep-link for a Workflow execution's instance page.
//
// Extracted so BOTH the Workflow entrypoint (which uses it for the GitHub
// check-run's `details_url`) and the dispatch route (which now returns it in
// the 202 so the caller — the GHA Action — can surface it immediately, on
// success AND failure) share one definition.

/** The Workflow's dashboard name segment — `RUNS_WORKFLOW` in wrangler config. */
export const WORKFLOWS_DASHBOARD_NAME = "runs-workflow";

/**
 * Build the Cloudflare dashboard deep-link for this execution's Workflow
 * instance (the `executionId` doubles as the CF Workflow `instanceId` —
 * `RUNS_WORKFLOW.create({ id: executionId })`), or `undefined` when the
 * account id is not configured (the BYOC default — consumers render exactly
 * as before, with no link).
 */
export const workflowDashboardUrl = (
  accountId: string | undefined,
  executionId: string,
): string | undefined =>
  accountId !== undefined && accountId.length > 0
    ? `https://dash.cloudflare.com/${accountId}/workers/workflows/${WORKFLOWS_DASHBOARD_NAME}/instance/${encodeURIComponent(executionId)}`
    : undefined;

/**
 * Deep-link to this deploy's AI Gateway analytics in the Cloudflare dashboard —
 * the detailed per-request token / cost / cache / latency view, by model and
 * provider, that complements our coarse per-recipe aggregate. The model-calling
 * runs route through this gateway (`AI_GATEWAY_ID`), so its analytics ARE the
 * detailed cost picture. `undefined` when the account id or gateway id is not
 * configured (no gateway → no link). Account-scoped path, matching the documented
 * `/:account/ai/ai-gateway` dashboard route.
 */
export const aiGatewayAnalyticsUrl = (
  accountId: string | undefined,
  gatewayId: string | undefined,
): string | undefined =>
  accountId !== undefined &&
  accountId.length > 0 &&
  gatewayId !== undefined &&
  gatewayId.length > 0
    ? `https://dash.cloudflare.com/${accountId}/ai/ai-gateway/${encodeURIComponent(gatewayId)}`
    : undefined;
