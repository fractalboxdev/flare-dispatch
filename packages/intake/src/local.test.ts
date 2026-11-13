// The local submit (phase 1) through intake.
import { checkProgressPayload } from "@fractalboxdev/flare-dispatch-github";
import { describe, expect, it } from "vitest";
import {
  admit,
  authenticated,
  CATALOG,
  harness,
  HEAD,
  manifest,
  REPO,
  repoWithManifest,
  type Harness,
} from "./harness.test-support.ts";
import { catalogRuns } from "./catalog.ts";
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

describe("a release-notes local submit", () => {
  it("[FD-INT-066] a local submit whose release-notes inputs name publish is rejected and admits nothing", async () => {
    const development = catalogRuns("development");
    const h = await harness({
      settings: {
        catalog: (name) => (name === "release-notes" ? development(name) : CATALOG[name]),
      },
    });
    const proposal = { repo: { owner: "acme", name: "app" }, baseBranch: "main" };
    const publish = { version: "v9.9.9", commit: HEAD, notesCommit: HEAD, pullRequest: 12 };
    expect(
      await register(h, "release-notes", { ...body, inputs: { ...proposal, publish } }),
    ).toEqual({ _tag: "rejected" });
    expect(h.executions()).toEqual([]);
    expect(h.records()).toEqual([]);
    // The same submit without publish proposes, so the rejection is the publish block's alone.
    expect(await register(h, "release-notes", { ...body, inputs: proposal })).toMatchObject({
      _tag: "admitted",
    });
  });
});

describe("FD-ARCH-018 work in a capacity lease and the check run", () => {
  const OTHER = "d".repeat(40);
  // `check` owns a check run; both runs are dispatchable, so a cloud dispatch of each is the contrast.
  const dispatchable = () =>
    harness({
      repos: {
        [REPO]: repoWithManifest(
          manifest([
            { recipe: "check", label: "ci", triggers: ["dispatch"], params: { steps: ["test"] } },
            { recipe: "nightly", triggers: ["dispatch"] },
          ]),
        ),
      },
    });
  const kinds = (h: Harness, executionId: string) =>
    h
      .rows("select kind from outbox where execution_id = ? order by id", executionId)
      .map((r) => r["kind"]);
  const execution = (h: Harness, executionId: string) =>
    h.rows(
      "select class, status, outcome_kind, surface_opened from executions where id = ?",
      executionId,
    )[0];
  const admittedId = (answer: unknown) => (answer as { executionId: string }).executionId;

  it("[FD-ARCH-018] a local.register admitted under a capacity lease opens no check run and binds no conclusion to it", async () => {
    const h = await dispatchable();
    const cloud = await admit(h, authenticated({ sha: HEAD, inputs: { sha: HEAD } }));
    const local = admittedId(await register(h, "check", body));
    // The same run at the same commit, admitted outside a capacity lease, opens its check run and carries the
    // outcome kind its conclusion is written from.
    expect(kinds(h, cloud.executionId)).toEqual(["check.open"]);
    expect(execution(h, cloud.executionId)).toMatchObject({
      outcome_kind: "check.conclude",
      surface_opened: 1,
    });
    expect(kinds(h, local)).toEqual([]);
    expect(execution(h, local)).toMatchObject({ outcome_kind: null, surface_opened: 0 });
  });

  it("[FD-ARCH-018] a capacity-lease execution that admission concludes writes no check.conclude row", async () => {
    const h = await dispatchable();
    // A batch execution of the same (run, scope) still queued is recorded `deferred` when a newer one is admitted.
    const firstLocal = admittedId(await register(h, "check", body));
    const secondLocal = admittedId(await register(h, "check", { ...body, treeHash: "tree-2" }));
    const firstCloud = await admit(
      h,
      authenticated({ run: "nightly", label: null, sha: HEAD, inputs: { sha: HEAD } }),
    );
    const secondCloud = await admit(
      h,
      authenticated({ run: "nightly", label: null, sha: OTHER, inputs: { sha: OTHER } }),
    );
    expect(execution(h, firstCloud.executionId)).toMatchObject({
      class: "batch",
      status: "deferred",
    });
    expect(kinds(h, firstCloud.executionId)).toEqual(["check.open", "check.conclude"]);
    expect(kinds(h, secondCloud.executionId)).toEqual(["check.open"]);
    expect(execution(h, firstLocal)).toMatchObject({ class: "batch", status: "deferred" });
    expect(kinds(h, firstLocal)).toEqual([]);
    expect(kinds(h, secondLocal)).toEqual([]);
  });

  it("[FD-ARCH-018] a capacity-lease execution gets no check.progress payload, so its check run is never updated", async () => {
    const h = await dispatchable();
    const local = admittedId(await register(h, "check", body));
    const record = h.records().find((r) => r["execution_id"] === local)!;
    const labels = JSON.parse(record["labels_json"] as string) as string[];
    const progress = (labels: readonly string[]) =>
      checkProgressPayload({
        check: { name: "flare-dispatch/check:ci", headSha: HEAD },
        labels,
        execution: { class: "batch", deadlineAt: 1_000 },
        queuePosition: 1,
      });
    expect(progress([])).toMatchObject({ name: "flare-dispatch/check:ci", head_sha: HEAD });
    expect(progress(labels)).toBeNull();
  });
});
