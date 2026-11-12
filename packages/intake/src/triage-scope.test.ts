import { describe, expect, it } from "vitest";
import { catalogRuns } from "./catalog.ts";
import {
  admit,
  authenticated,
  harness,
  manifest,
  REPO,
  refusal,
  repoWithManifest,
} from "./harness.test-support.ts";
import { submitLocal } from "./local.ts";

describe("triage issue scope", () => {
  const setup = () =>
    harness({
      settings: { catalog: catalogRuns("production") },
      repos: {
        [REPO]: repoWithManifest(manifest([{ recipe: "triage-issues", triggers: ["dispatch"] }])),
      },
    });

  it("refuses a production dispatch that reads a different repository's issues before admission", async () => {
    const h = await setup();
    expect(
      await refusal(
        h,
        authenticated({
          run: "triage-issues",
          label: null,
          inputs: {
            repo: { owner: "unrelated", name: "public" },
          },
        }),
      ),
    ).toEqual({ status: 400, code: "invalid_inputs" });
    expect(h.executions()).toEqual([]);
    expect(h.records()).toEqual([]);
    expect(h.rows("select * from dedup_keys")).toEqual([]);
    expect(h.rows("select * from placements")).toEqual([]);
  });

  it("admits the same repository with case-insensitive owner and name", async () => {
    const h = await setup();
    const inputs = { repo: { owner: "ACME", name: "App" } };
    const answer = await admit(h, authenticated({ run: "triage-issues", label: null, inputs }));
    expect(
      h.rows("select scope_id from executions where id = ?", answer.executionId)[0]!.scope_id,
    ).toBe(REPO);
    expect(JSON.parse(String(h.records()[0]!.inputs_json))).toEqual(inputs);
  });

  it("also refuses a mismatched local registration through the common submit path", async () => {
    const h = await setup();
    expect(
      await h.run(
        submitLocal({ leaseId: "capacity-1", epoch: 1 }, "triage-issues", {
          repository: REPO,
          baseCommit: "a".repeat(40),
          ref: "refs/heads/main",
          treeHash: "tree",
          inputsDigest: "inputs",
          inputs: { repo: { owner: "unrelated", name: "public" } },
        }),
      ),
    ).toEqual({ _tag: "rejected" });
    expect(h.executions()).toEqual([]);
    expect(h.records()).toEqual([]);
  });
});
