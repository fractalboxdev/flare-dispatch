// A release matrix's `offload-test` parent runs on a workflow engine with mameko's `Intents` over the runner's intent
// list. The recipe holds no durable wait, so its body runs once per epoch. Its intents are then staged and applied as
// the control plane does it: the channel receives the `exec.intents` batch twice, as a redelivery, and the terminal
// write runs twice, as an `Execution` workflow that lost the stage's journal entry runs it. The second stage and the
// second write add no row.
import { Intents, intentList } from "@fractalboxdev/mameko-run";
import { Effect, Layer } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { describe, expect, it } from "vitest";
import {
  ctx,
  fakeChildren,
  fakeGithub,
  SHA,
  type ChildScript,
} from "../../src/gate.test-support.ts";
import type { OffloadTestInput } from "../../src/inputs.ts";
import { Outcome } from "../../src/reasons.ts";
import { offloadTestRun } from "../../src/runs.ts";
import { leasedPlane, outcomeOf, runPayload } from "./plane.test-support.ts";

const SCOPE = "o/r";
const EXECUTION = "exec-release";

const ok: ChildScript = () => ({ verdict: { _tag: "Recorded", outcome: Outcome.success() } });
const failing: ChildScript = (r) => ({
  verdict: {
    _tag: "Recorded",
    outcome: r.key === "build" ? Outcome.failure("exit: 1") : Outcome.success(),
  },
});

const input = (ref: string): OffloadTestInput => ({
  ...ctx,
  ref,
  scope: SCOPE,
  entry: {
    release: true,
    jobs: [
      { key: "build", command: "pnpm build" },
      { key: "test", command: "pnpm test" },
    ],
  },
  parentDedupKey: `offload-test:${SCOPE}:${SHA}`,
  trigger: "other",
  defaultBranch: "main",
});

/** The parent's workflow, with each intent's position against the jobs started before it. */
const ran = (ref: string, script: ChildScript) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const children = yield* fakeChildren(script);
      const github = fakeGithub({});
      const list = intentList();
      const emissions: { kind: string; jobsStarted: number }[] = [];
      const intents = Layer.effect(
        Intents,
        Effect.gen(function* () {
          const inner = yield* Intents;
          return {
            emit: (step: string, intent: { readonly kind: string; readonly payload: unknown }) =>
              inner
                .emit(step, intent)
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() =>
                      emissions.push({ kind: intent.kind, jobsStarted: children.started.length }),
                    ),
                  ),
                ),
          };
        }),
      ).pipe(Layer.provide(list.layer));
      return yield* Effect.gen(function* () {
        const result = yield* offloadTestRun.workflow.execute(
          runPayload(EXECUTION, "offload-test", SCOPE, input(ref)),
        );
        return {
          result,
          emissions,
          intents: list.intents(),
          jobs: children.started.map((s) => s.key),
        };
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            offloadTestRun.layer,
            Layer.mergeAll(children.layer, github.layer, intents, WorkflowEngine.layerMemory),
          ),
        ),
      );
    }),
  );

/** The control plane's half: the batch staged and redelivered, the result accepted, the terminal write run twice. */
const applied = async (run: Awaited<ReturnType<typeof ran>>) => {
  const plane = await leasedPlane(EXECUTION, "offload-test", SCOPE);
  const staged = await plane.stage(run.intents);
  const redelivered = await plane.stage(run.intents);
  plane.accept();
  await plane.applyOutbox(outcomeOf(run.result));
  const written = plane.snapshot();
  await plane.applyOutbox(outcomeOf(run.result));
  return { staged, redelivered, written, rewritten: plane.snapshot(), effects: plane.effects() };
};

describe("a release matrix's intents under a redelivered batch and a repeated terminal write", () => {
  it("[FD-GATE-056] emits release.draft before the first job starts, emits no other release intent and writes each row once", async () => {
    const run = await ran("refs/tags/v1.2.3", ok);
    expect(run.result).toEqual({ _tag: "success" });
    expect(run.emissions).toEqual([
      { kind: "release.draft", jobsStarted: 0 },
      { kind: "release.publish", jobsStarted: 2 },
    ]);
    expect(run.intents).toEqual([
      {
        intent_key: "release-draft:0",
        kind: "release.draft",
        payload: { tag: "v1.2.3", sha: SHA },
      },
      {
        intent_key: "release-publish:0",
        kind: "release.publish",
        payload: { tag: "v1.2.3", sha: SHA },
      },
    ]);

    const plane = await applied(run);
    expect(plane.staged).toEqual({ _tag: "Staged" });
    expect(plane.redelivered).toEqual({ _tag: "Duplicate" });
    expect(plane.effects).toEqual([
      {
        id: `${EXECUTION}:run:release-draft:0`,
        intent_key: "run:release-draft:0",
        kind: "release.draft",
        payload_json: JSON.stringify({ tag: "v1.2.3", sha: SHA }),
      },
      {
        id: `${EXECUTION}:run:release-publish:0`,
        intent_key: "run:release-publish:0",
        kind: "release.publish",
        payload_json: JSON.stringify({ tag: "v1.2.3", sha: SHA }),
      },
    ]);
    expect(plane.rewritten).toEqual(plane.written);
  });

  it("[FD-GATE-056] a failed release matrix emits release.draft before its first job, and the outbox writes no release row for the failure", async () => {
    const run = await ran("refs/tags/v1.2.3", failing);
    expect(run.result).toEqual({ _tag: "failure", reason: "jobs: build" });
    expect(run.emissions).toEqual([{ kind: "release.draft", jobsStarted: 0 }]);

    const plane = await applied(run);
    // `release.draft` is applied for `success` only, so the staged draft of a failed matrix reaches no row.
    expect(plane.written.staged).toEqual([
      { intent_key: "run:release-draft:0", kind: "release.draft", committed: 1 },
    ]);
    expect(plane.effects).toEqual([]);
    expect(plane.rewritten).toEqual(plane.written);
  });

  it("[FD-GATE-059] a dry-run tag runs every job, emits no release.draft or release.publish, and the outbox holds no release row", async () => {
    const run = await ran("refs/tags/dry-run/v1.2.3", ok);
    expect(run.result).toEqual({ _tag: "success" });
    expect(run.jobs).toEqual(["build", "test"]);
    expect(run.emissions).toEqual([]);
    expect(run.intents).toEqual([]);

    const plane = await applied(run);
    expect(plane.effects).toEqual([]);
    expect(plane.written.outbox).toMatchObject([{ kind: "check.conclude", tier: "outcome" }]);
    expect(plane.rewritten).toEqual(plane.written);
  });
});
