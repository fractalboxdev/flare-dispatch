// The terminal write and its conclusion run twice: mameko's `applyOutbox` stage over D1 as the `Execution` workflow
// runs it, replayed as an engine that lost the stage's journal entry runs it again, then the outbox drained through
// the check-run applier with the control plane's `ConcludeFacts`. The second run adds no D1 write, no intent and no
// GitHub call.
import {
  ActuatorRateLimitLive,
  checkConclusion,
  CheckRunApplierLive,
  installationQuotaLayer,
  verdictOf,
} from "@fractalboxdev/flare-dispatch-github";
import { fakeGithub, fakeGithubLayers } from "@fractalboxdev/flare-dispatch-github/testing";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import {
  drainOnce,
  ExecutionSteps,
  type ExecutionOutcome,
} from "@fractalboxdev/mameko-coordinator";
import { d1OutboxStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { executionConfig } from "../../src/config.ts";
import { concludeFactsLayer } from "../../src/github.ts";
import { envOf, seedExecution, type TestD1 } from "../conclude.test-support.ts";

const terminalWrite = (db: TestD1, executionId: string, outcome: ExecutionOutcome) =>
  Effect.runPromise(
    ExecutionSteps.use((steps) => steps.applyOutbox(executionId, outcome, null)).pipe(
      Effect.provide(
        d1ExecutionSteps(db, {
          ...executionConfig(buildProfile("production")),
          meteredCost: () => Effect.succeed(0),
        }),
      ),
    ),
  );

const drain = (db: TestD1, gh: ReturnType<typeof fakeGithub>, now: number) =>
  Effect.runPromise(
    drainOnce({
      now,
      token: (id) => `tok-${id}-${now}`,
      random: () => 0,
      actuatorOf: { "check.conclude": "checkRun" },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          d1OutboxStore(db),
          CheckRunApplierLive.pipe(
            Layer.provide(Layer.merge(fakeGithubLayers(gh), concludeFactsLayer(envOf(db)))),
          ),
          ActuatorRateLimitLive.pipe(Layer.provide(installationQuotaLayer())),
        ),
      ),
    ),
  );

const snapshot = (db: TestD1) => ({
  outbox: db.sqlite
    .prepare(
      "select execution_id, intent_key, kind, tier, payload_json, state, attempts, external_ref from outbox order by id",
    )
    .all(),
  executions: db.sqlite.prepare("select id, status, reason from executions order by id").all(),
});

const OUTCOMES: readonly ExecutionOutcome[] = [
  { _tag: "Success", epoch: 1 },
  { _tag: "Failure", reason: "lint: 3 errors", epoch: 1 },
  { _tag: "Skipped", detail: "draft-pr", epoch: 1 },
  { _tag: "Cancelled", cause: "superseded" },
];

describe("the check.conclude row under a replayed terminal write", () => {
  for (const outcome of OUTCOMES)
    it(`[FD-GH-014] the row the terminal write inserts concludes with checkConclusion's answer, once, for ${outcome._tag}`, async () => {
      const db = await migratedD1();
      await seedExecution(db, "exec-1");
      const gh = fakeGithub();

      await terminalWrite(db, "exec-1", outcome);
      const rows = snapshot(db).outbox as {
        kind: string;
        intent_key: string;
        tier: string;
      }[];
      expect(rows).toMatchObject([
        { kind: "check.conclude", intent_key: "outcome", tier: "outcome" },
      ]);
      // The terminal write stamps the row with the store's clock, so the drain runs after it.
      const now = Date.now() + 1_000;
      await drain(db, gh, now);
      const expected = checkConclusion(verdictOf(outcome));
      expect(gh.runs).toMatchObject([
        {
          name: "flare-dispatch/check:ci",
          external_id: "exec-1",
          status: "completed",
          conclusion: expected.conclusion,
          output: { title: expected.title },
        },
      ]);
      expect(snapshot(db).outbox).toMatchObject([{ state: "applied", external_ref: "1000" }]);
      expect(gh.alarms).toEqual([]);

      const first = snapshot(db);
      const calls = gh.calls.length;
      await terminalWrite(db, "exec-1", outcome);
      await drain(db, gh, now + 60_000);
      expect(snapshot(db)).toEqual(first);
      expect(gh.calls).toHaveLength(calls);
      expect(gh.runs).toHaveLength(1);
    });
});
