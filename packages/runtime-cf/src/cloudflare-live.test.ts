// Unit tests for the live `cloudflare` capability — pure URL/normalize helpers
// plus a `deployments` call driven by a stub `fetch` (no Workers runtime).

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { cloudflare } from "@fractalboxdev/flare-dispatch-core";
import {
  cfReason,
  makeCloudflareLive,
  normalizeDeployment,
  pagesDeploymentsUrl,
} from "./cloudflare-live";

describe("pure helpers", () => {
  it("cfReason maps status families", () => {
    expect(cfReason(401)).toBe("unauthorized");
    expect(cfReason(403)).toBe("unauthorized");
    expect(cfReason(429)).toBe("rate-limited");
    expect(cfReason(503)).toBe("transient");
    expect(cfReason(404)).toBe("other");
  });

  it("pagesDeploymentsUrl encodes the project", () => {
    const url = pagesDeploymentsUrl("acc123", "my site");
    expect(url).toContain("/accounts/acc123/pages/projects/my%20site/deployments");
  });

  it("normalizeDeployment maps nested CF fields", () => {
    const d = normalizeDeployment("p", {
      id: "dep1",
      environment: "production",
      url: "https://p.pages.dev",
      created_on: "2026-06-01T00:00:00Z",
      latest_stage: { status: "failure" },
      deployment_trigger: { metadata: { branch: "feat/x" } },
    });
    expect(d).toEqual({
      project: "p",
      id: "dep1",
      environment: "production",
      status: "failure",
      url: "https://p.pages.dev",
      branch: "feat/x",
      createdAt: Date.parse("2026-06-01T00:00:00Z"),
    });
  });
});

describe("makeCloudflareLive.deployments", () => {
  const stubFetch = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("reads a configured project's deployments and filters by status", async () => {
    const layer = makeCloudflareLive({
      apiToken: "cf-token",
      accountId: "acc123",
      fetchImpl: stubFetch({
        result: [
          { id: "ok", latest_stage: { status: "success" }, environment: "production" },
          { id: "bad", latest_stage: { status: "failure" }, environment: "production" },
        ],
      }),
    });
    const got = await Effect.runPromise(
      cloudflare
        .deployments({ projects: ["site-a"], status: "failure" })
        .pipe(Effect.provide(layer)),
    );
    expect(got.map((d) => d.id)).toEqual(["bad"]);
  });

  it("fails with CloudflareApiError on a non-2xx", async () => {
    const layer = makeCloudflareLive({
      apiToken: "cf-token",
      accountId: "acc123",
      fetchImpl: stubFetch({}, 403),
    });
    const exit = await Effect.runPromiseExit(
      cloudflare.deployments({ projects: ["site-a"] }).pipe(Effect.provide(layer)),
    );
    expect(exit._tag).toBe("Failure");
  });
});
