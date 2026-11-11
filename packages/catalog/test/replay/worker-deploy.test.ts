// A `worker-deploy` execution runs twice on one workflow engine, the second run over the first run's journal, with
// mameko's `Intents` over the runner's intent list. Its intents are then staged and applied as the control plane does
// it, and the batch and the terminal write run again. The second run starts no deploy command, makes no GitHub read
// and emits no intent; the second stage and write add no row.
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

const replayed = (script: readonly Scripted[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const exec = fakeExec(script);
      const github = fakeGithub({});
      const list = intentList();
      const counts = () => ({
        commands: exec.ran.length,
        reads: github.reads.length,
        intents: list.intents().length,
      });
      const execute = workerDeployRun.workflow.execute(
        runPayload(EXECUTION, "worker-deploy", SCOPE, input),
      );
      return yield* Effect.gen(function* () {
        const first = yield* execute;
        const afterFirst = counts();
        const second = yield* execute;
        return { first, second, afterFirst, afterReplay: counts(), intents: list.intents() };
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

const applied = async (run: Awaited<ReturnType<typeof replayed>>) => {
  const plane = await leasedPlane(EXECUTION, "worker-deploy", SCOPE);
  const staged = await plane.stage(run.intents);
  await plane.stage(run.intents);
  plane.accept();
  await plane.applyOutbox(outcomeOf(run.first as { _tag: string; reason?: string }));
  const written = plane.snapshot();
  await plane.applyOutbox(outcomeOf(run.first as { _tag: string; reason?: string }));
  return { staged, written, replayed: plane.snapshot(), effects: plane.effects() };
};

const followOn = { run: "deploy-smoke", repository: SCOPE, sha: SHA, ref: ctx.ref };

describe("a worker-deploy execution's follow-on under a replayed run", () => {
  it("[FD-GATE-069] a successful deploy emits one dispatch.followOn for deploy-smoke on its commit, written once under replay, and a failed one emits none", async () => {
    const run = await replayed([]);
    expect(run.first).toEqual({ _tag: "success" });
    expect(run.second).toEqual(run.first);
    expect(run.intents).toEqual([
      { intent_key: "deploy-smoke:0", kind: "dispatch.followOn", payload: followOn },
    ]);
    // The replay runs over the journal: no deploy command, no head read, no intent.
    expect(run.afterReplay).toEqual(run.afterFirst);
    expect(run.afterFirst.commands).toBeGreaterThan(0);

    const plane = await applied(run);
    expect(plane.staged).toEqual({ _tag: "Staged" });
    expect(plane.effects).toEqual([
      {
        id: `${EXECUTION}:run:deploy-smoke:0`,
        intent_key: "run:deploy-smoke:0",
        kind: "dispatch.followOn",
        payload_json: JSON.stringify(followOn),
      },
    ]);
    expect(plane.replayed).toEqual(plane.written);

    // A failed deploy emits no follow-on, so the outbox holds none.
    const failed = await replayed([{ match: "wrangler", exit: CommandExit.Exited({ code: 1 }) }]);
    expect(failed.first).toEqual({ _tag: "failure", reason: "exit: 1" });
    expect(failed.intents).toEqual([]);
    expect(failed.afterReplay).toEqual(failed.afterFirst);
    const failedPlane = await applied(failed);
    expect(failedPlane.effects).toEqual([]);
    expect(failedPlane.replayed).toEqual(failedPlane.written);
  });
});
