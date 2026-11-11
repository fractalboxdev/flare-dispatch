// The local submit (phase 1) through intake.
import { describe, expect, it } from "vitest";
import { harness, HEAD, REPO, type Harness } from "./harness.test-support.ts";
import { submitLocal } from "./local.ts";

const register = (h: Harness, run: string, body: unknown) =>
  h.run(submitLocal({ leaseId: "L1", epoch: 2 }, run, body));

const body = {
  repository: REPO,
  baseCommit: HEAD,
  ref: "refs/heads/feature",
  treeHash: "tree-1",
  inputsDigest: "inputs-1",
  inputs: { sha: HEAD },
};

describe("FD-INT-061 local submit", () => {
  it("[FD-INT-061] an accepted local submit records trigger local, class batch and the local-only constraint", async () => {
    const h = await harness();
    const answer = await register(h, "check", body);
    expect(answer).toMatchObject({ _tag: "admitted", executionId: expect.any(String) });
    expect(h.records()[0]).toMatchObject({
      execution_id: (answer as { executionId: string }).executionId,
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

  it("[FD-INT-061] an unknown run, an undecodable body or inputs the run rejects admit nothing", async () => {
    const h = await harness();
    expect(await register(h, "no-such-run", body)).toEqual({ _tag: "rejected" });
    expect(await register(h, "check", { ...body, baseCommit: "short" })).toEqual({
      _tag: "rejected",
    });
    expect(await register(h, "check", { ...body, inputs: { sha: 7 } })).toEqual({
      _tag: "rejected",
    });
    expect(h.executions()).toEqual([]);
    expect(h.records()).toEqual([]);
  });
});
