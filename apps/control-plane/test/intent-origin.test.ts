// Executor batches may author run intents; control-plane payload bindings retain their own authority.
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { ExecutionSteps } from "@fractalboxdev/mameko-coordinator";
import {
  d1StageIntents,
  insertD1CheckpointBatch,
} from "@fractalboxdev/mameko-host-cloudflare/d1-checkpoints";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { channelConfig, executionConfig } from "../src/config.ts";
import { seedExecution } from "./conclude.test-support.ts";

const leasedExecution = async () => {
  const db = await migratedD1();
  await seedExecution(db, "exec-1");
  db.sqlite.exec(
    "insert into placements (execution_id, state, epoch, executor_id) values ('exec-1', 'leased', 1, 'dev1')",
  );
  return db;
};

it("[FD-AGT-034] [FD-GH-080] refuses an executor's forged pr.propose without staging or publishing it", async () => {
  const db = await leasedExecution();
  const kinds = channelConfig(buildProfile("production")).intentKinds!;
  try {
    const result = await Effect.runPromise(
      d1StageIntents(db, {
        executionId: "exec-1",
        epoch: 1,
        executorId: "dev1",
        intents: [
          {
            intent_key: "forged",
            kind: "pr.propose",
            payload: {
              executionId: "another-execution",
              run: "spec-drift-pr",
              repo: { owner: "acme", name: "other" },
              manifest: {},
            },
          },
        ],
        effectClassOf: (kind) => kinds[kind],
      }),
    );
    expect(result).toEqual({ _tag: "Rejected", reason: "undeclared kind" });
    expect(db.sqlite.prepare("select kind from staged_intents").all()).toEqual([]);
    expect(db.sqlite.prepare("select kind from outbox").all()).toEqual([]);
  } finally {
    db.sqlite.close();
  }
});

it("[FD-GH-008] refuses a checkpoint that forges the control plane's check conclusion", async () => {
  const db = await leasedExecution();
  const kinds = channelConfig(buildProfile("production")).anyOutcomeKinds;
  try {
    const result = await Effect.runPromise(
      insertD1CheckpointBatch(db, {
        executionId: "exec-1",
        epoch: 1,
        executorId: "dev1",
        intents: [
          {
            intentKey: "forged",
            kind: "check.conclude",
            limitKey: "acme/app",
            payload: { outcome: { _tag: "Success", epoch: 1 } },
          },
        ],
        localContent: false,
        effectClassOf: (kind) => kinds[kind],
      }),
    );
    expect(result).toEqual({ _tag: "Rejected", reason: "kind not applied for any outcome" });
    expect(db.sqlite.prepare("select kind from outbox").all()).toEqual([]);
  } finally {
    db.sqlite.close();
  }
});

it("[FD-GATE-056] still stages and publishes a run-authored release intent on success", async () => {
  const db = await leasedExecution();
  const profile = buildProfile("production");
  const kinds = channelConfig(profile).intentKinds!;
  const payload = { tag: "v1.0.0" };
  try {
    expect(
      await Effect.runPromise(
        d1StageIntents(db, {
          executionId: "exec-1",
          epoch: 1,
          executorId: "dev1",
          intents: [{ intent_key: "release", kind: "release.draft", payload }],
          effectClassOf: (kind) => kinds[kind],
        }),
      ),
    ).toEqual({ _tag: "Staged" });
    db.sqlite.exec(
      "update placements set state = 'accepted', accepted_epoch = 1 where execution_id = 'exec-1'",
    );
    await Effect.runPromise(
      ExecutionSteps.use((s) => s.applyOutbox("exec-1", { _tag: "Success", epoch: 1 }, 1)).pipe(
        Effect.provide(
          d1ExecutionSteps(db, {
            ...executionConfig(profile),
            meteredCost: () => Effect.succeed(null),
          }),
        ),
      ),
    );
    expect(
      db.sqlite
        .prepare("select kind, payload_json from outbox where intent_key = 'run:release'")
        .get(),
    ).toEqual({ kind: "release.draft", payload_json: JSON.stringify(payload) });
  } finally {
    db.sqlite.close();
  }
});
