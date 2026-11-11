// A `worker-deploy` execution runs on a workflow engine with mameko's `Intents` over the runner's intent list. The
// recipe holds no durable wait, so its body runs once per epoch. Its intents are then staged and applied as the control
// plane does it: the channel receives the `exec.intents` batch twice, as a redelivery, and the terminal write runs
// twice, as an `Execution` workflow that lost the stage's journal entry runs it. The second stage and the second write
// add no row.
import { intentList } from "@fractalboxdev/mameko-run";
import { Effect, Layer } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { describe, expect, it } from "vitest";
import { CommandExit } from "../../src/command.ts";
import {
  ctx,
  fakeArtifacts,
  fakeExec,
  fakeGithub,
  memoryLedger,
  SHA,
  type Scripted,
} from "../../src/gate.test-support.ts";
import type { WorkerDeployInput } from "../../src/inputs.ts";
import { workerDeployRun } from "../../src/runs.ts";
import { leasedPlane, outcomeOf, runPayload } from "./plane.test-support.ts";

const SCOPE = "o/r";
const EXECUTION = "exec-deploy";

const input: WorkerDeployInput = {
  ...ctx,
  scope: SCOPE,
  branch: "main",
  entry: { command: "pnpm wrangler deploy", grants: ["cf-api"] },
};

const ran = (script: readonly Scripted[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const exec = fakeExec(script);
      const github = fakeGithub({});
      const list = intentList();
      return yield* Effect.gen(function* () {
        const result = yield* workerDeployRun.workflow.execute(
          runPayload(EXECUTION, "worker-deploy", SCOPE, input),
        );
        return {
          result,
          deploys: exec.ran.filter((c) => c.command === input.entry.command).length,
          intents: list.intents(),
        };
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            workerDeployRun.layer,
            Layer.mergeAll(
              exec.layer,
              fakeArtifacts().layer,
              github.layer,
              memoryLedger(),
              list.layer,
              WorkflowEngine.layerMemory,
            ),
          ),
        ),
      );
    }),
  );

const applied = async (run: Awaited<ReturnType<typeof ran>>) => {
  const plane = await leasedPlane(EXECUTION, "worker-deploy", SCOPE);
  const staged = await plane.stage(run.intents);
  const redelivered = await plane.stage(run.intents);
  plane.accept();
  await plane.applyOutbox(outcomeOf(run.result));
  const written = plane.snapshot();
  await plane.applyOutbox(outcomeOf(run.result));
  return { staged, redelivered, written, rewritten: plane.snapshot(), effects: plane.effects() };
};

const followOn = { run: "deploy-smoke", repository: SCOPE, sha: SHA, ref: ctx.ref };

describe("a worker-deploy execution's follow-on under a redelivered batch and a repeated terminal write", () => {
  it("[FD-GATE-069] a successful deploy emits one dispatch.followOn for deploy-smoke on its commit, written once, and a failed one emits none", async () => {
    const run = await ran([]);
    expect(run.result).toEqual({ _tag: "success" });
    expect(run.deploys).toBe(1);
    expect(run.intents).toEqual([
      { intent_key: "deploy-smoke:0", kind: "dispatch.followOn", payload: followOn },
    ]);

    const plane = await applied(run);
    expect(plane.staged).toEqual({ _tag: "Staged" });
    expect(plane.redelivered).toEqual({ _tag: "Duplicate" });
    expect(plane.effects).toEqual([
      {
        id: `${EXECUTION}:run:deploy-smoke:0`,
        intent_key: "run:deploy-smoke:0",
        kind: "dispatch.followOn",
        payload_json: JSON.stringify(followOn),
      },
    ]);
    expect(plane.rewritten).toEqual(plane.written);

    // A failed deploy emits no follow-on, so the outbox holds none.
    const failed = await ran([{ match: "wrangler", exit: CommandExit.Exited({ code: 1 }) }]);
    expect(failed.result).toEqual({ _tag: "failure", reason: "exit: 1" });
    expect(failed.deploys).toBe(1);
    expect(failed.intents).toEqual([]);
    const failedPlane = await applied(failed);
    expect(failedPlane.effects).toEqual([]);
    expect(failedPlane.rewritten).toEqual(failedPlane.written);
  });
});
