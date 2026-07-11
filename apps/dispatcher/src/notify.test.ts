// Tests for the completion-notify email renderer.

import { describe, expect, it } from "vitest";
import { renderResultEmail } from "./notify";

const base = {
  run: "playwright-demo",
  executionId: "01J0EXEC",
  repo: "owner/name",
  sha: "abc123def456",
} as const;

describe("renderResultEmail", () => {
  it("renders a success with output URLs as links", () => {
    const { subject, html, text } = renderResultEmail({
      ...base,
      status: "success",
      detailsUrl: "https://dash.cloudflare.com/x/instance/01J0EXEC",
      output: {
        videoUri: "https://r2.example/demo-bundle.tar.zst",
        logUri: "https://r2.example/playwright.log",
        exitCode: 0,
        durationMs: 1234,
      },
    });

    expect(subject).toBe("[FlareDispatch] playwright-demo — ✓ succeeded");
    // URL output fields become anchors with humanized labels.
    expect(html).toContain('<a href="https://r2.example/demo-bundle.tar.zst">');
    expect(html).toContain("Video"); // videoUri → "Video"
    expect(html).toContain("Log"); // logUri → "Log"
    expect(html).toContain("Exit Code"); // exitCode → "Exit Code"
    expect(html).toContain("View step logs in Cloudflare");
    // Plain-text alternative carries the same data.
    expect(text).toContain("SUCCEEDED");
    expect(text).toContain("Video: https://r2.example/demo-bundle.tar.zst");
    expect(text).toContain("Step logs: https://dash.cloudflare.com");
  });

  it("renders an array-of-objects output (product-demo stories) as per-item clickable links", () => {
    const { subject, html, text } = renderResultEmail({
      ...base,
      run: "product-demo",
      status: "success",
      output: {
        replayUri: "https://dispatcher.example/replay/run-level",
        stories: [
          {
            name: "sign-in-and-home",
            status: "passed",
            replayUri: "https://dispatcher.example/replay/chapter-0",
            keyScreenshotUri:
              "https://dispatcher.example/v1/artifacts/x/sign-in-and-home.png",
            replayJsonUri: "", // empty fields are noise — must be skipped
          },
          {
            name: "add-a-game",
            status: "failed",
            replayUri: "https://dispatcher.example/replay/chapter-1",
            keyScreenshotUri: "",
            replayJsonUri: "",
          },
        ],
      },
    });

    // A partial pass (1 of 2) is still an overall success — the subject leads
    // with the passed/total tally so the inbox shows it, not a flat "succeeded".
    expect(subject).toBe("[FlareDispatch] product-demo — ✓ 1/2 passed");
    // Each story renders as its own block with CLICKABLE links — not one
    // escaped JSON blob.
    expect(html).toContain("sign-in-and-home");
    expect(html).toContain(
      '<a href="https://dispatcher.example/replay/chapter-0">',
    );
    expect(html).toContain(
      '<a href="https://dispatcher.example/replay/chapter-1">',
    );
    expect(html).toContain("Key Screenshot"); // keyScreenshotUri → humanized label
    expect(html).not.toContain("replayJsonUri"); // no JSON-blob fallback, empty skipped
    // Plain-text alternative lists per-story lines with the URLs.
    expect(text).toContain("sign-in-and-home");
    expect(text).toContain(
      "Replay: https://dispatcher.example/replay/chapter-0",
    );
    // Empty fields skipped in text too.
    expect(text).not.toContain("Replay Json:");
  });

  it("suppresses the raw replay-JSON escape hatch from a top-level output", () => {
    const { html, text } = renderResultEmail({
      ...base,
      run: "product-demo",
      status: "success",
      output: {
        replayUri: "https://dispatcher.example/replay/run-level",
        // Non-empty raw-rrweb-JSON hatch — must NOT surface as a "Replay Json" row.
        replayJsonUri: "https://r2.example/x/replay.json?sig=abc",
        summaryMd: "all good",
      },
    });

    // The human-facing player link still renders…
    expect(html).toContain(
      '<a href="https://dispatcher.example/replay/run-level">',
    );
    // …but the raw-JSON hatch is gone from both the label and the URL.
    expect(html).not.toContain("Replay Json");
    expect(html).not.toContain("replay.json");
    expect(text).not.toContain("Replay Json:");
    expect(text).not.toContain("replay.json");
  });

  it("leads the subject with the story tally even on a clean all-pass run", () => {
    const { subject } = renderResultEmail({
      ...base,
      run: "product-demo",
      status: "success",
      output: {
        stories: [
          { name: "a", status: "passed" },
          { name: "b", status: "passed" },
          { name: "c", status: "passed" },
        ],
      },
    });
    expect(subject).toBe("[FlareDispatch] product-demo — ✓ 3/3 passed");
  });

  it("renders a failure without output", () => {
    const { subject, html, text } = renderResultEmail({
      ...base,
      status: "failure",
      detailsUrl: "https://dash.cloudflare.com/x/instance/01J0EXEC",
    });

    expect(subject).toBe("[FlareDispatch] playwright-demo — ✗ failed");
    expect(html).toContain("failed before producing output");
    expect(html).toContain("✗ Failed");
    expect(text).toContain("FAILED");
  });

  it("renders the run-authored failure summary on the failure branch", () => {
    const { html, text } = renderResultEmail({
      ...base,
      status: "failure",
      detailsUrl: "https://dash.cloudflare.com/x/instance/01J0EXEC",
      failureDisplay: "# product-demo — 0/2 chapters passed\n| landing | ❌ fail |",
    });

    // The markdown is shown verbatim (escaped) in a <pre> block…
    expect(html).toContain("<pre");
    expect(html).toContain("0/2 chapters passed");
    expect(html).toContain("| landing | ❌ fail |");
    // …replacing the generic "no output" paragraph.
    expect(html).not.toContain("failed before producing output");
    // Plain-text alternative carries the same markdown.
    expect(text).toContain("0/2 chapters passed");
  });

  it("HTML-escapes the failure summary (caller-influenced markdown)", () => {
    const { html } = renderResultEmail({
      ...base,
      status: "failure",
      failureDisplay: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("ignores failureDisplay on a success", () => {
    const { html } = renderResultEmail({
      ...base,
      status: "success",
      output: { exitCode: 0 },
      failureDisplay: "should not render",
    });
    expect(html).not.toContain("should not render");
  });

  it("HTML-escapes caller-influenced output values", () => {
    const { html } = renderResultEmail({
      ...base,
      status: "success",
      output: { note: "<script>alert(1)</script>" },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the details link when no detailsUrl is given", () => {
    const { html } = renderResultEmail({
      ...base,
      status: "success",
      output: { exitCode: 0 },
    });
    expect(html).not.toContain("View step logs");
  });

  it("ignores a non-object output (no result rows)", () => {
    const { html } = renderResultEmail({
      ...base,
      status: "success",
      output: "just a string",
    });
    expect(html).not.toContain("Results");
  });

  it("renders the product-demo viewer link as a watch-the-demo CTA", () => {
    const demoUrl =
      "https://dispatcher.example/demos/01J0EXEC?t=tok.sig";
    const { html, text } = renderResultEmail({
      ...base,
      run: "product-demo",
      status: "success",
      demoUrl,
      output: { replayUri: "https://dispatcher.example/replay/run-level" },
    });
    expect(html).toContain(`<a href="${demoUrl}"`);
    expect(html).toContain("Watch the product demo");
    expect(text).toContain(`Watch the product demo: ${demoUrl}`);
  });

  it("omits the demo CTA on a failed run (no viewer page exists)", () => {
    const { html, text } = renderResultEmail({
      ...base,
      run: "product-demo",
      status: "failure",
      demoUrl: "https://dispatcher.example/demos/01J0EXEC?t=tok.sig",
    });
    expect(html).not.toContain("Watch the product demo");
    expect(text).not.toContain("Watch the product demo");
  });
});
