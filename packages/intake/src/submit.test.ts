// The check run admission opens: the `cp:check:open` row mameko's `admit` inserts with the execution, built by the
// `checkOpenPayload` binding from the run's check name and the request's head SHA.
import { LocalRegistration } from "@fractalboxdev/mameko-ports";
import { checkOpenPayload } from "@fractalboxdev/flare-dispatch-profile";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  admit,
  authenticated,
  CATALOG,
  harness,
  HEAD,
  REPO,
  testRun,
} from "./harness.test-support.ts";
import { localRegistrationLayer } from "./local.ts";

const SHA = "e".repeat(40);

/** The admitted-intent rows of one execution, with their payloads decoded. */
const opened = (h: Awaited<ReturnType<typeof harness>>, executionId: string) =>
  h
    .rows(
      "select intent_key, kind, tier, payload_json from outbox where execution_id = ? order by id",
      executionId,
    )
    .map((r) => ({
      intent_key: r["intent_key"],
      kind: r["kind"],
      tier: r["tier"],
      payload_json: JSON.parse(r["payload_json"] as string) as { name: string; head_sha: string },
    }));

describe("the check.open row admission inserts", () => {
  it("[FD-GH-005] admission inserts one cp:check:open row on the head SHA for an execution that owns a check", async () => {
    const h = await harness();
    const { executionId } = await admit(h, authenticated({ sha: SHA, inputs: { sha: SHA } }));
    expect(opened(h, executionId)).toEqual([
      {
        intent_key: "cp:check:open",
        kind: "check.open",
        tier: "effect",
        payload_json: { name: "flare-dispatch/check:ci", head_sha: SHA },
      },
    ]);
    // The row's insertion marks the execution as having opened its surface (MAMEKO-OUT-053).
    expect(h.rows("select surface_opened from executions where id = ?", executionId)).toEqual([
      { surface_opened: 1 },
    ]);
  });

  it("[FD-GH-005] admission inserts no check.open row for an execution of a run that owns no check", async () => {
    const h = await harness({
      settings: {
        catalog: (name) =>
          name === "lint" ? testRun("lint", { ownsCheck: false }) : CATALOG[name],
      },
    });
    const owner = await admit(h, authenticated({ sha: SHA, inputs: { sha: SHA } }));
    const other = await admit(
      h,
      authenticated({ run: "lint", label: null, sha: SHA, inputs: { sha: SHA } }),
    );
    expect(h.executions()).toHaveLength(2);
    expect(opened(h, owner.executionId).map((r) => r.intent_key)).toEqual(["cp:check:open"]);
    expect(opened(h, other.executionId)).toEqual([]);
  });

  it("[FD-GH-006] the check run is named flare-dispatch/<run>, with :<checkLabel> when the run declares one", async () => {
    const h = await harness();
    const labelled = await admit(h, authenticated({ sha: SHA, inputs: { sha: SHA } }));
    const bare = await admit(
      h,
      authenticated({ run: "lint", label: null, sha: SHA, inputs: { sha: SHA } }),
    );
    expect(opened(h, labelled.executionId).map((r) => r.payload_json.name)).toEqual([
      "flare-dispatch/check:ci",
    ]);
    expect(opened(h, bare.executionId).map((r) => r.payload_json.name)).toEqual([
      "flare-dispatch/lint",
    ]);
  });
});

describe("local-only work", () => {
  it("[FD-PROF-043] checkOpenPayload returns none for an execution that carries local-only", () => {
    const check = { name: "flare-dispatch/check:ci", headSha: SHA };
    expect(checkOpenPayload({ check, labels: [] })).toEqual({
      name: "flare-dispatch/check:ci",
      head_sha: SHA,
    });
    expect(checkOpenPayload({ check, labels: ["untrusted-input"] })).toEqual({
      name: "flare-dispatch/check:ci",
      head_sha: SHA,
    });
    expect(checkOpenPayload({ check, labels: ["local-only"] })).toBeNull();
    expect(checkOpenPayload({ check, labels: ["untrusted-input", "local-only"] })).toBeNull();
    expect(checkOpenPayload({ check: null, labels: [] })).toBeNull();
  });

  it("[FD-PROF-043] a local registration under a capacity lease is admitted with no check.open row", async () => {
    const h = await harness();
    // The same run at the same commit, dispatched without a capacity lease, opens its check run.
    const cloud = await admit(h, authenticated({ sha: HEAD, inputs: { sha: HEAD } }));
    expect(opened(h, cloud.executionId).map((r) => r.intent_key)).toEqual(["cp:check:open"]);
    const answer = await h.run(
      Effect.gen(function* () {
        const port = yield* LocalRegistration;
        return yield* port.register({ leaseId: "L1", epoch: 1 }, "check", {
          repo: REPO,
          sha: HEAD,
          ref: "refs/heads/feature",
          treeHash: "tree-1",
          inputsDigest: "inputs-1",
          inputs: { sha: HEAD },
        });
      }).pipe(Effect.provide(localRegistrationLayer)),
    );
    expect(answer).toMatchObject({ _tag: "accepted" });
    const executionId = (answer as { executionId: string }).executionId;
    expect(h.executions().map((e) => e["id"])).toContain(executionId);
    expect(h.records().find((r) => r["execution_id"] === executionId)).toMatchObject({
      labels_json: '["local-only"]',
    });
    expect(opened(h, executionId)).toEqual([]);
    expect(h.rows("select surface_opened from executions where id = ?", executionId)).toEqual([
      { surface_opened: 0 },
    ]);
  });
});
