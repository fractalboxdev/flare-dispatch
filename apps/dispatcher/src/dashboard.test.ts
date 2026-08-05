// Tests for the `GET /` dashboard — the pure renderer plus an end-to-end pass
// through `handleRequest` over the in-memory D1/R2/Workflow fakes.

import { describe, expect, it } from "vitest";

import { renderDashboard, type DashboardRow } from "./dashboard";
import { handleRequest } from "./router";
import { makeFakeD1, makeFakeEnv, makeFakeR2, makeFakeWorkflow } from "./test-helpers";

const baseRow = (over: Partial<DashboardRow>): DashboardRow => ({
  id: "offload-test:owner_repo:abc123",
  run: "offload-test",
  repo: "owner/repo",
  ref: "refs/heads/main",
  sha: "abc123def456",
  status: "success",
  startedAt: 1000,
  completedAt: 2000,
  durationMs: 1000,
  costMicroUsd: null,
  costBasis: null,
  logsUrl: null,
  demosUrl: null,
  selfHealPrUrl: null,
  ...over,
});

describe("renderDashboard", () => {
  const data = (rows: readonly DashboardRow[]) => ({
    origin: "https://flare-dispatch-app.fractalbox.dev",
    rows,
    nowMs: 60_000,
    repoSlug: "fractalbox/flare-dispatch",
  });

  it("renders an empty state when there are no executions", () => {
    const html = renderDashboard(data([]));
    expect(html).toContain("No executions yet");
    expect(html).not.toContain("<tbody>");
  });

  it("renders a row with its run, repo, short sha, and status badge", () => {
    const html = renderDashboard(data([baseRow({ status: "failure" })]));
    expect(html).toContain("offload-test");
    expect(html).toContain("owner/repo");
    expect(html).toContain("abc123d"); // 7-char short sha
    expect(html).toContain('class="badge fail"');
  });

  it("links Logs / Demo only when their tokened URLs are present", () => {
    const html = renderDashboard(
      data([
        baseRow({
          run: "product-demo",
          logsUrl: "https://x/logs/a?t=tok",
          demosUrl: "https://x/demos/a?t=tok",
        }),
      ]),
    );
    expect(html).toContain('href="https://x/logs/a?t=tok"');
    expect(html).toContain('href="https://x/demos/a?t=tok"');
  });

  it("makes the run name a click-through to the log viewer when logs exist", () => {
    const html = renderDashboard(
      data([baseRow({ run: "offload-test", logsUrl: "https://x/logs/a?t=tok" })]),
    );
    expect(html).toContain('class="rowlink"');
    expect(html).toContain('<a href="https://x/logs/a?t=tok" title="View logs">offload-test</a>');
  });

  it("keeps the run name as plain text when no log link is configured", () => {
    const html = renderDashboard(data([baseRow({ run: "offload-test", logsUrl: null })]));
    expect(html).not.toContain('class="rowlink"');
    expect(html).toContain("offload-test");
  });

  it("renders the self-heal tag linking to the fix PRs when set", () => {
    const html = renderDashboard(
      data([
        baseRow({
          run: "self-heal-pr",
          selfHealPrUrl: "https://github.com/owner/repo/pulls?q=is%3Apr%20label%3Aself-heal",
        }),
      ]),
    );
    expect(html).toContain("🩹 self-heal");
    expect(html).toContain('class="badge selfheal"');
    expect(html).toContain(
      'href="https://github.com/owner/repo/pulls?q=is%3Apr%20label%3Aself-heal"',
    );
  });

  it("omits the self-heal tag when no fix PR was opened", () => {
    // The run NAME is "self-heal-pr" (so "self-heal" is present); assert the
    // tag pill itself is absent.
    const html = renderDashboard(data([baseRow({ run: "self-heal-pr", selfHealPrUrl: null })]));
    expect(html).not.toContain("🩹");
    expect(html).not.toContain("badge selfheal");
  });

  it("escapes HTML in execution fields", () => {
    const html = renderDashboard(data([baseRow({ repo: "<script>" })]));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("emits canonical + OG metadata pointing at the origin root", () => {
    const html = renderDashboard(data([]));
    expect(html).toContain(
      '<link rel="canonical" href="https://flare-dispatch-app.fractalbox.dev/" />',
    );
    expect(html).toContain('property="og:title"');
  });
});

describe("GET / — dashboard route", () => {
  const fixture = (executions: Record<string, unknown>[]) => {
    const metadata = makeFakeD1({ executions });
    const env = makeFakeEnv({
      hmacSecret: "dashboard-test-secret",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      metadata,
      publicOrigin: "https://flare-dispatch-app.fractalbox.dev",
    });
    return { env };
  };

  const execRow = (over: Record<string, unknown>) => ({
    id: "offload-test:owner_repo:abc1234",
    run: "offload-test",
    repo: "owner/repo",
    ref: "refs/heads/main",
    sha: "abc1234def567",
    status: "success",
    started_at: 1000,
    completed_at: 2000,
    parent_execution_id: null,
    input_json: "{}",
    summary_json: null,
    check_run_id: null,
    ...over,
  });

  it("returns 200 text/html listing executions with tokened log links", async () => {
    const { env } = fixture([execRow({ id: "a:b:c", run: "offload-test", status: "success" })]);
    const res = await handleRequest(new Request("https://flare-dispatch-app.fractalbox.dev/"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("offload-test");
    expect(body).toContain("/logs/a%3Ab%3Ac?t=");
  });

  it("links the product-demo viewer for product-demo runs", async () => {
    const { env } = fixture([execRow({ id: "demo1", run: "product-demo", status: "success" })]);
    const res = await handleRequest(new Request("https://flare-dispatch-app.fractalbox.dev/"), env);
    const body = await res.text();
    expect(body).toContain("/demos/demo1?t=");
  });

  it("405s a non-GET method", async () => {
    const { env } = fixture([]);
    const res = await handleRequest(
      new Request("https://flare-dispatch-app.fractalbox.dev/", {
        method: "POST",
      }),
      env,
    );
    expect(res.status).toBe(405);
  });

  it("403s when Cloudflare Access is required but no identity is present", async () => {
    const metadata = makeFakeD1({ executions: [] });
    const env = makeFakeEnv({
      hmacSecret: "s",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      metadata,
      viewerAccessMode: "required",
    });
    // ACCESS_AUD / ACCESS_TEAM_DOMAIN unset under "required" → 503, default-deny.
    const res = await handleRequest(new Request("https://flare-dispatch-app.fractalbox.dev/"), env);
    expect(res.status).toBe(503);
  });
});

describe("GET /v1/dashboard.json — SPA feed", () => {
  const fixture = (executions: Record<string, unknown>[]) => {
    const metadata = makeFakeD1({ executions });
    const env = makeFakeEnv({
      hmacSecret: "dashboard-test-secret",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      metadata,
      publicOrigin: "https://flare-dispatch-app.fractalbox.dev",
    });
    return { env };
  };

  const execRow = (over: Record<string, unknown>) => ({
    id: "offload-test:owner_repo:abc1234",
    run: "offload-test",
    repo: "owner/repo",
    ref: "refs/heads/main",
    sha: "abc1234def567",
    status: "success",
    started_at: 1000,
    completed_at: 2000,
    parent_execution_id: null,
    input_json: "{}",
    summary_json: null,
    check_run_id: null,
    ...over,
  });

  it("returns 200 application/json with rows carrying tokened log links", async () => {
    const { env } = fixture([execRow({ id: "a:b:c", run: "offload-test" })]);
    const res = await handleRequest(
      new Request("https://flare-dispatch-app.fractalbox.dev/v1/dashboard.json"),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      repoSlug: string;
      rows: { id: string; run: string; logsUrl: string | null; selfHealPrUrl: string | null }[];
    };
    expect(body.repoSlug).toBe("fractalbox/flare-dispatch");
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.id).toBe("a:b:c");
    expect(body.rows[0]?.logsUrl).toContain("/logs/a%3Ab%3Ac?t=");
    // A plain offload-test run drove no fix PR — no self-heal tag.
    expect(body.rows[0]?.selfHealPrUrl).toBeNull();
  });

  it("sets selfHealPrUrl for a self-heal-pr run that opened a fix PR (prStaged)", async () => {
    const { env } = fixture([
      execRow({
        id: "heal1",
        run: "self-heal-pr",
        repo: "owner/repo",
        summary_json: JSON.stringify({ incidentId: "ci:owner/repo:abc", prStaged: true }),
      }),
    ]);
    const res = await handleRequest(
      new Request("https://flare-dispatch-app.fractalbox.dev/v1/dashboard.json"),
      env,
    );
    const body = (await res.json()) as { rows: { selfHealPrUrl: string | null }[] };
    expect(body.rows[0]?.selfHealPrUrl).toBe(
      "https://github.com/owner/repo/pulls?q=is%3Apr%20label%3Aself-heal",
    );
  });

  it("leaves selfHealPrUrl null for a self-heal-pr run that opened no PR (no-fix)", async () => {
    const { env } = fixture([
      execRow({
        id: "heal2",
        run: "self-heal-pr",
        summary_json: JSON.stringify({ outcome: "no-fix", prStaged: false }),
      }),
    ]);
    const res = await handleRequest(
      new Request("https://flare-dispatch-app.fractalbox.dev/v1/dashboard.json"),
      env,
    );
    const body = (await res.json()) as { rows: { selfHealPrUrl: string | null }[] };
    expect(body.rows[0]?.selfHealPrUrl).toBeNull();
  });

  it("405s a non-GET method", async () => {
    const { env } = fixture([]);
    const res = await handleRequest(
      new Request("https://flare-dispatch-app.fractalbox.dev/v1/dashboard.json", {
        method: "POST",
      }),
      env,
    );
    expect(res.status).toBe(405);
  });

  it("503s when Cloudflare Access is required but unconfigured (default-deny)", async () => {
    const env = makeFakeEnv({
      hmacSecret: "s",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      metadata: makeFakeD1({ executions: [] }),
      viewerAccessMode: "required",
    });
    const res = await handleRequest(
      new Request("https://flare-dispatch-app.fractalbox.dev/v1/dashboard.json"),
      env,
    );
    expect(res.status).toBe(503);
  });
});

describe("app shell routing — gated SPA shell with SSR fallback", () => {
  // A stub Workers Static Assets binding that returns the SPA shell regardless
  // of the requested path (the asset layer's SPA fallback behaviour).
  const fakeAssets = (body: string): Fetcher =>
    ({
      fetch: async () =>
        new Response(body, { status: 200, headers: { "content-type": "text/html" } }),
    }) as unknown as Fetcher;

  const base = {
    hmacSecret: "dashboard-test-secret",
    workflow: makeFakeWorkflow(),
    storage: makeFakeR2(),
    metadata: makeFakeD1({ executions: [] }),
    publicOrigin: "https://flare-dispatch-app.fractalbox.dev",
  };

  it("serves the SPA shell from the asset binding for / when ASSETS is present", async () => {
    const env = makeFakeEnv({
      ...base,
      assets: fakeAssets('<!doctype html><div id="root"></div>'),
    });
    const res = await handleRequest(new Request("https://flare-dispatch-app.fractalbox.dev/"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  it("gates and serves the shell for /executions/:id (SPA deep-link)", async () => {
    const env = makeFakeEnv({ ...base, assets: fakeAssets("SHELL") });
    const res = await handleRequest(
      new Request("https://flare-dispatch-app.fractalbox.dev/executions/a%3Ab%3Ac"),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("SHELL");
  });

  it("503s /executions/:id when Cloudflare Access is required but unconfigured", async () => {
    const env = makeFakeEnv({
      hmacSecret: "s",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      metadata: makeFakeD1({ executions: [] }),
      viewerAccessMode: "required",
      assets: fakeAssets("SHELL"),
    });
    const res = await handleRequest(
      new Request("https://flare-dispatch-app.fractalbox.dev/executions/x"),
      env,
    );
    expect(res.status).toBe(503);
  });

  it("falls back to the SSR dashboard for / when no asset binding is present", async () => {
    const env = makeFakeEnv({
      ...base,
      metadata: makeFakeD1({
        executions: [
          {
            id: "a:b:c",
            run: "offload-test",
            repo: "owner/repo",
            ref: "refs/heads/main",
            sha: "abc1234def567",
            status: "success",
            started_at: 1000,
            completed_at: 2000,
            parent_execution_id: null,
            input_json: "{}",
            summary_json: null,
            check_run_id: null,
          },
        ],
      }),
    });
    const res = await handleRequest(new Request("https://flare-dispatch-app.fractalbox.dev/"), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The SSR marker the SPA shell never contains.
    expect(body).toContain("Latest executions");
    expect(body).toContain("offload-test");
  });
});
