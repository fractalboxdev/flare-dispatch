// Deploy console route — wiring + default-deny through `handleRequest`.
//
// The authorization core, page renderer, and identity normalization have their
// own focused unit tests (deploy-authz / deploy-page / deploy-access). This pass
// pins that the `/deploy` route is registered and FAILS CLOSED when the deploy
// Access application isn't configured — the security-critical default. The
// authenticated happy path needs a live Access JWT + get-identity and is
// verified against the deployed Worker (see the PR).

import { describe, expect, it } from "vitest";
import { handleRequest } from "../router";
import { makeFakeEnv, makeFakeR2, makeFakeWorkflow } from "../test-helpers";

const env = () =>
  makeFakeEnv({
    hmacSecret: "deploy-test-secret",
    workflow: makeFakeWorkflow(),
    storage: makeFakeR2(),
  });

describe("/deploy — default-deny when Access is unconfigured", () => {
  it("GET returns 503 access_not_configured (never falls open)", async () => {
    const res = await handleRequest(
      new Request("https://d.example/deploy", { method: "GET" }),
      env(),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "access_not_configured" });
  });

  it("POST is gated before it can dispatch anything", async () => {
    const res = await handleRequest(
      new Request("https://d.example/deploy", {
        method: "POST",
        body: new URLSearchParams({ env: "production", sha: "abc123" }),
      }),
      env(),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "access_not_configured" });
  });
});
