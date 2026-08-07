// FlareDispatch Dispatcher — check-run summary log-link tests.
//
// Asserts the contract every check-run summary now carries: the tokened
// log-viewer link appears on success AND failure whenever key material +
// origin exist, drops out cleanly (no broken markdown) when either is
// missing, and the token embedded in the link verifies against the signing
// helper it was minted with.

import { describe, expect, it } from "vitest";
import { appendFailureSummary } from "./failure-summary";
import { buildLogsUrl, resolveLogLinkSecret, signLogToken, verifyLogToken } from "./log-token";
import { logLinksSuffix, startedSummary } from "./summary-links";
import type { Env } from "./env";

const EXEC = "check:owner_repo:abc123def456";
const ORIGIN = "https://dispatcher.example";
const DETAILS =
  "https://dash.cloudflare.com/acct-id/workers/workflows/runs-workflow/instance/" + EXEC;

/** Mint the viewer URL exactly the way `RunWorkflow.run` does. */
const viewerUrl = async (secret: string): Promise<string> =>
  buildLogsUrl(ORIGIN, EXEC, await signLogToken(secret, EXEC));

describe("logLinksSuffix", () => {
  it("carries BOTH links — dashboard and signed viewer — when both exist", async () => {
    const env = { HMAC_SECRET: "hmac-secret" } as unknown as Env;
    const secret = resolveLogLinkSecret(env);
    expect(secret).toBe("hmac-secret");
    const logsUrl = await viewerUrl(secret as string);
    const suffix = logLinksSuffix({ detailsUrl: DETAILS, logsUrl });
    expect(suffix).toContain(`[view step logs in Cloudflare ↗](${DETAILS})`);
    expect(suffix).toContain(`[view full logs ↗](${logsUrl})`);
  });

  it("success summary embeds the signed viewer link", async () => {
    const logsUrl = await viewerUrl("hmac-secret");
    const summary = `✓ check — execution succeeded.${logLinksSuffix({ logsUrl })}`;
    expect(summary).toBe(`✓ check — execution succeeded. — [view full logs ↗](${logsUrl})`);
  });

  it("omits the viewer link cleanly when no key material is configured", () => {
    // A deploy with neither LOG_LINK_SECRET nor HMAC_SECRET → no secret → the
    // workflow never mints a token, so the suffix has only the dashboard link.
    const env = {} as unknown as Env;
    expect(resolveLogLinkSecret(env)).toBeUndefined();
    const suffix = logLinksSuffix({ detailsUrl: DETAILS });
    expect(suffix).not.toContain("view full logs");
    expect(suffix).toContain("view step logs in Cloudflare");
    // And with neither surface available the suffix is empty — the verdict
    // line renders exactly as it did before links existed.
    expect(logLinksSuffix({})).toBe("");
  });

  it("failure summary keeps its run-authored links AND gains the viewer link", async () => {
    const logsUrl = await viewerUrl("hmac-secret");
    const runMd = "`check` — `pnpm lint` exited `1`\n\n[View full check log ↗](https://r2.example/check.log?sig=x)";
    const summary = appendFailureSummary(
      `✗ check — execution failed.${logLinksSuffix({ detailsUrl: DETAILS, logsUrl })}`,
      runMd,
    );
    expect(summary).toContain(`[view full logs ↗](${logsUrl})`);
    expect(summary).toContain(`[view step logs in Cloudflare ↗](${DETAILS})`);
    // The run's own artifact link survives beneath the verdict line.
    expect(summary).toContain("[View full check log ↗](https://r2.example/check.log?sig=x)");
  });

  it("token in the viewer link verifies against the signing helper", async () => {
    const logsUrl = await viewerUrl("hmac-secret");
    const token = new URL(logsUrl).searchParams.get("t");
    expect(await verifyLogToken("hmac-secret", EXEC, token)).toBe(true);
    // Bound to the execution id + secret — not transferable.
    expect(await verifyLogToken("hmac-secret", "other:exec:id", token)).toBe(false);
    expect(await verifyLogToken("other-secret", EXEC, token)).toBe(false);
  });
});

describe("startedSummary", () => {
  it("links both surfaces from the opener when available", async () => {
    const logsUrl = await viewerUrl("hmac-secret");
    const summary = startedSummary(EXEC, { detailsUrl: DETAILS, logsUrl });
    expect(summary).toContain(`[\`${EXEC}\`](${DETAILS})`);
    expect(summary).toContain(`[view full logs ↗](${logsUrl})`);
  });

  it("viewer link alone still renders (no dashboard account id configured)", async () => {
    const logsUrl = await viewerUrl("hmac-secret");
    const summary = startedSummary(EXEC, { logsUrl });
    expect(summary).toBe(`Execution \`${EXEC}\` started — [view full logs ↗](${logsUrl})`);
  });

  it("degenerate deploy — no links — keeps the historical plain form", () => {
    expect(startedSummary(EXEC, {})).toBe(`Execution \`${EXEC}\` started.`);
  });
});
