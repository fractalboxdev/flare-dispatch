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

/** Mint the viewer URL exactly the way `RunWorkflow.run` does. */
const viewerUrl = async (secret: string): Promise<string> =>
  buildLogsUrl(ORIGIN, EXEC, await signLogToken(secret, EXEC));

describe("logLinksSuffix", () => {
  it("carries the signed viewer link and never a Cloudflare dashboard link", async () => {
    const env = { HMAC_SECRET: "hmac-secret" } as unknown as Env;
    const secret = resolveLogLinkSecret(env);
    expect(secret).toBe("hmac-secret");
    const logsUrl = await viewerUrl(secret as string);
    const suffix = logLinksSuffix({ logsUrl });
    expect(suffix).toBe(` — [view full logs ↗](${logsUrl})`);
    expect(suffix).not.toContain("dash.cloudflare.com");
  });

  it("success summary embeds the signed viewer link", async () => {
    const logsUrl = await viewerUrl("hmac-secret");
    const summary = `✓ check — execution succeeded.${logLinksSuffix({ logsUrl })}`;
    expect(summary).toBe(`✓ check — execution succeeded. — [view full logs ↗](${logsUrl})`);
  });

  it("is empty when no key material is configured", () => {
    // A deploy with neither LOG_LINK_SECRET nor HMAC_SECRET → no secret → the
    // workflow never mints a token, and the verdict line renders link-less.
    const env = {} as unknown as Env;
    expect(resolveLogLinkSecret(env)).toBeUndefined();
    expect(logLinksSuffix({})).toBe("");
  });

  it("failure summary keeps its run-authored links AND gains the viewer link", async () => {
    const logsUrl = await viewerUrl("hmac-secret");
    const runMd =
      "`check` — `pnpm lint` exited `1`\n\n[View full check log ↗](https://r2.example/check.log?sig=x)";
    const summary = appendFailureSummary(
      `✗ check — execution failed.${logLinksSuffix({ logsUrl })}`,
      runMd,
    );
    expect(summary).toContain(`[view full logs ↗](${logsUrl})`);
    expect(summary).not.toContain("dash.cloudflare.com");
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
  it("links the viewer from the opener", async () => {
    const logsUrl = await viewerUrl("hmac-secret");
    const summary = startedSummary(EXEC, { logsUrl });
    expect(summary).toBe(`Execution \`${EXEC}\` started — [view full logs ↗](${logsUrl})`);
  });

  it("degenerate deploy — no links — keeps the plain form", () => {
    expect(startedSummary(EXEC, {})).toBe(`Execution \`${EXEC}\` started.`);
  });
});
