// FlareDispatch Dispatcher — `/demos/:execution` product-demo viewer tests.
//
// Drives the `handleRequest` router with a hand-built `Request` + fake Env
// (test-helpers.ts), exercising the capability-token gate, the hero replay
// embed, and the per-chapter GIF gallery rendered from `summary_json`. Same
// Vitest-2-only pattern as logs.test.ts.

import { describe, expect, it } from "vitest";
import { handleRequest } from "../router";
import { signLogToken } from "../log-token";
import { makeFakeEnv, makeFakeD1, makeFakeR2, makeFakeWorkflow } from "../test-helpers";

const SECRET = "log-secret-please-rotate";
const ORIGIN = "https://dispatcher.example";
const EXEC = "product-demo:owner_repo:abc123def456";

const SUMMARY = {
  replayUri: `${ORIGIN}/replay/sess-aaaaaaaa`,
  replayJsonUri: `${ORIGIN}/v1/artifacts/${EXEC}/replay-0.json`,
  summaryMd: "# product-demo — 1/2 chapters passed",
  gifUri: `${ORIGIN}/v1/artifacts/${EXEC}/demo.gif`,
  stories: [
    {
      name: "Sign up",
      status: "passed",
      durationMs: 1000,
      chapterStartMs: 0,
      chapterEndMs: 1000,
      narrative: "The visitor creates an account and lands on the dashboard.",
      keyScreenshotUri: `${ORIGIN}/v1/artifacts/${EXEC}/key-screenshot-0.png`,
      chapterGifUri: `${ORIGIN}/v1/artifacts/${EXEC}/chapter-0.gif`,
      replayUri: `${ORIGIN}/replay/sess-aaaaaaaa`,
      replayJsonUri: `${ORIGIN}/v1/artifacts/${EXEC}/replay-0.json`,
    },
    {
      name: "Checkout",
      status: "failed",
      durationMs: 2000,
      chapterStartMs: 0,
      chapterEndMs: 2000,
      narrative: "Payment step errored before completion.",
      keyScreenshotUri: `${ORIGIN}/v1/artifacts/${EXEC}/key-screenshot-1.png`,
      // No chapterGifUri — exercises the key-screenshot fallback.
      replayUri: "",
      replayJsonUri: "",
    },
  ],
};

const fixture = (summaryJson: string | null = JSON.stringify(SUMMARY)) => {
  const metadata = makeFakeD1({
    executions: [
      {
        id: EXEC,
        run: "product-demo",
        repo: "owner/repo",
        ref: "refs/heads/main",
        sha: "abc123def456789",
        status: "success",
        started_at: 1000,
        completed_at: 2000,
        parent_execution_id: null,
        input_json: JSON.stringify({ secret: "should-not-leak" }),
        summary_json: summaryJson,
        check_run_id: null,
      },
    ],
    steps: [],
  });
  return makeFakeEnv({
    hmacSecret: "h",
    workflow: makeFakeWorkflow(),
    storage: makeFakeR2(),
    metadata,
    logLinkSecret: SECRET,
    publicOrigin: ORIGIN,
  });
};

const get = (env: ReturnType<typeof fixture>, path: string) =>
  handleRequest(new Request(`${ORIGIN}${path}`, { method: "GET" }), env);

describe("GET /demos/:execution", () => {
  it("403s without a valid capability token", async () => {
    const res = await get(fixture(), `/demos/${encodeURIComponent(EXEC)}`);
    expect(res.status).toBe(403);
  });

  it("renders the hero replay + per-chapter gallery with a valid token", async () => {
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(fixture(), `/demos/${encodeURIComponent(EXEC)}?t=${t}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    // Hero = the single player, opened on the primary chapter's replay.
    expect(html).toContain(`<iframe id="hero" src="${ORIGIN}/replay/sess-aaaaaaaa"`);
    // Both chapter names + their narratives render.
    expect(html).toContain("Sign up");
    expect(html).toContain("The visitor creates an account");
    expect(html).toContain("Checkout");
    expect(html).toContain("Payment step errored");
    // Chapter 0 uses its GIF; chapter 1 (no GIF) falls back to the screenshot.
    expect(html).toContain(`src="${ORIGIN}/v1/artifacts/${EXEC}/chapter-0.gif"`);
    expect(html).toContain(`src="${ORIGIN}/v1/artifacts/${EXEC}/key-screenshot-1.png"`);
    // Pass/fail badges.
    expect(html).toContain("pass");
    expect(html).toContain("fail");
    // Chapter 0 has a replay → clickable + active (it IS the hero's replay) and
    // carries the data the hero-swap script reads; chapter 1 (no replay) is not.
    expect(html).toContain(`data-replay="${ORIGIN}/replay/sess-aaaaaaaa" data-name="Sign up"`);
    expect(html).toMatch(/class="card clickable active"/);
    expect(html).toContain("Open full-screen ↗");
  });

  it("405s on a non-GET method", async () => {
    const t = await signLogToken(SECRET, EXEC);
    const res = await handleRequest(
      new Request(`${ORIGIN}/demos/${encodeURIComponent(EXEC)}?t=${t}`, {
        method: "POST",
      }),
      fixture(),
    );
    expect(res.status).toBe(405);
  });

  it("404s with a guidance page when no demo result was persisted (failed run)", async () => {
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(fixture(null), `/demos/${encodeURIComponent(EXEC)}?t=${t}`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("No demo result is available");
  });
});
