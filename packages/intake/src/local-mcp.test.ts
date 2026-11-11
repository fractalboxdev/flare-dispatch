// The local registration port (phase 1) and the MCP dispatch tool (phase 2) through intake.
import { LocalRegistration } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { harness, HEAD, REPO, type Harness } from "./harness.test-support.ts";
import { localRegistrationLayer } from "./local.ts";
import { mcpDispatch } from "./mcp.ts";

const register = (h: Harness, run: string, registration: unknown) =>
  h.run(
    Effect.gen(function* () {
      const port = yield* LocalRegistration;
      return yield* port.register({ leaseId: "L1", epoch: 2 }, run, registration);
    }).pipe(Effect.provide(localRegistrationLayer)),
  );

const registration = {
  repo: REPO,
  sha: HEAD,
  ref: "refs/heads/feature",
  treeHash: "tree-1",
  inputsDigest: "inputs-1",
  inputs: { sha: HEAD },
};

describe("FD-INT-061 local submit", () => {
  it("[FD-INT-061] an accepted local.register records trigger local and the local-only constraint", async () => {
    const h = await harness();
    const answer = await register(h, "check", registration);
    expect(answer).toMatchObject({ _tag: "accepted", executionId: expect.any(String) });
    expect(h.records()[0]).toMatchObject({
      trigger: "local",
      placement_constraint: "local-only",
      labels_json: '["local-only"]',
      class: "batch",
    });
    expect(h.rows("select canonical from dedup_keys")[0]!.canonical).toBe(
      "local:L1:check:tree-1:inputs-1",
    );
    expect(h.recorded.resolved).toEqual([]);
  });

  it("[FD-INT-061] an unknown run or undecodable registration is rejected and admits nothing", async () => {
    const h = await harness();
    expect(await register(h, "no-such-run", registration)).toEqual({ _tag: "rejected" });
    expect(await register(h, "check", { ...registration, sha: "short" })).toEqual({
      _tag: "rejected",
    });
    expect(h.executions()).toEqual([]);
    expect(Layer.isLayer(localRegistrationLayer)).toBe(true);
  });
});

const mcpRequest = (identity: string | null) =>
  new Request("https://cp.example.com/mcp", {
    method: "POST",
    headers: identity === null ? {} : { "x-test-identity": identity },
  });

describe("MCP dispatch", () => {
  it("[FD-INT-062] an authenticated call submits trigger mcp with the caller's identity", async () => {
    const h = await harness();
    const result = await h.run(
      mcpDispatch(mcpRequest("agent@example.com"), {
        run: "check",
        repo: REPO,
        label: "ci",
        inputs: { sha: HEAD },
      }),
    );
    expect(result).toMatchObject({ execution_id: expect.any(String), class: "interactive" });
    expect(h.records()[0]).toMatchObject({ trigger: "mcp", caller: "agent@example.com" });
  });

  it("[FD-INT-062] a call with no Access identity is refused 401 and submits nothing", async () => {
    const h = await harness();
    const exit = await h.run(
      Effect.exit(mcpDispatch(mcpRequest(null), { run: "check", repo: REPO })),
    );
    expect(JSON.stringify(exit)).toContain("unauthenticated");
    expect(h.executions()).toEqual([]);
  });

  it("[FD-INT-063] a class above the assigned one keeps the assigned class; a lower one reaches resolution", async () => {
    const h = await harness();
    await h.run(
      mcpDispatch(mcpRequest("agent@example.com"), {
        run: "check",
        repo: REPO,
        label: "ci",
        inputs: { sha: HEAD },
        class: "release",
      }),
    );
    expect(h.records()[0]!.class).toBe("interactive");
    expect(h.recorded.resolved.map((r) => r.classInput)).toEqual([null, null]);
    const lower = await harness();
    await lower.run(
      mcpDispatch(mcpRequest("agent@example.com"), {
        run: "check",
        repo: REPO,
        label: "ci",
        inputs: { sha: HEAD },
        class: "batch",
      }),
    );
    expect(lower.recorded.resolved.map((r) => r.classInput)).toEqual([null, "batch"]);
  });
});
