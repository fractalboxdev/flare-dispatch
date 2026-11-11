// A release matrix's `offload-test` parent runs twice on one workflow engine, the second run over the first run's
// journal, with mameko's `Intents` over the runner's intent list. Its intents are then staged and applied as the control
// plane does it, and the batch and the terminal write run again. The second run starts no job, makes no GitHub read
// and emits no intent; the second stage and write add no row.
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

/** The parent's workflow, run and then replayed, with each intent's position against the jobs started before it. */
const replayed = (ref: string, script: ChildScript) =>
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
      const counts = () => ({
        jobs: children.started.length,
        reads: github.reads.length,
        intents: list.intents().length,
        emissions: emissions.length,
      });
      const execute = offloadTestRun.workflow.execute(
        runPayload(EXECUTION, "offload-test", SCOPE, input(ref)),
      );
      return yield* Effect.gen(function* () {
        const first = yield* execute;
        const afterFirst = counts();
        const second = yield* execute;
        return {
          first,
          second,
          afterFirst,
          afterReplay: counts(),
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

/** The control plane's half: the batch staged and redelivered, the result accepted, the terminal write replayed. */
const applied = async (run: Awaited<ReturnType<typeof replayed>>) => {
  const plane = await leasedPlane(EXECUTION, "offload-test", SCOPE);
  const staged = await plane.stage(run.intents);
  const redelivered = await plane.stage(run.intents);
  plane.accept();
  await plane.applyOutbox(outcomeOf(run.first as { _tag: string; reason?: string }));
  const written = plane.snapshot();
  await plane.applyOutbox(outcomeOf(run.first as { _tag: string; reason?: string }));
  return { staged, redelivered, written, replayed: plane.snapshot(), effects: plane.effects() };
};

describe("a release matrix's intents under a replayed run", () => {
  it("[FD-GATE-056] emits release.draft before the first job starts, emits no other release intent and writes each row once under replay", async () => {
    const run = await replayed("refs/tags/v1.2.3", ok);
    expect(run.first).toEqual({ _tag: "success" });
    expect(run.second).toEqual(run.first);
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
    // The replay runs over the journal: no job, no GitHub read, no intent.
    expect(run.afterReplay).toEqual(run.afterFirst);

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
    expect(plane.replayed).toEqual(plane.written);
  });

  it("[FD-GATE-056] a failed release matrix emits release.draft before its first job, and the outbox writes no release row for the failure", async () => {
    const run = await replayed("refs/tags/v1.2.3", failing);
    expect(run.first).toEqual({ _tag: "failure", reason: "jobs: build" });
    expect(run.emissions).toEqual([{ kind: "release.draft", jobsStarted: 0 }]);
    expect(run.afterReplay).toEqual(run.afterFirst);

    const plane = await applied(run);
    // `release.draft` is applied for `success` only, so the staged draft of a failed matrix reaches no row.
    expect(plane.written.staged).toEqual([
      { intent_key: "run:release-draft:0", kind: "release.draft", committed: 1 },
    ]);
    expect(plane.effects).toEqual([]);
    expect(plane.replayed).toEqual(plane.written);
  });

  it("[FD-GATE-059] a dry-run tag runs every job, emits no release.draft or release.publish, and its replay starts no job", async () => {
    const run = await replayed("refs/tags/dry-run/v1.2.3", ok);
    expect(run.first).toEqual({ _tag: "success" });
    expect(run.second).toEqual(run.first);
    expect(run.jobs).toEqual(["build", "test"]);
    expect(run.intents).toEqual([]);
    expect(run.afterReplay).toEqual(run.afterFirst);

    const plane = await applied(run);
    expect(plane.effects).toEqual([]);
    expect(plane.written.outbox).toMatchObject([{ kind: "check.conclude", tier: "outcome" }]);
    expect(plane.replayed).toEqual(plane.written);
  });
});
