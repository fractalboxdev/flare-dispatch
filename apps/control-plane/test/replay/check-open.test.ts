// Admission and its `check.open` row run twice: intake's admission over D1 inserts the row with the execution, the
// outbox drains through the check-run applier, and the same request admitted again, as a redelivered webhook or a
// retried dispatch submits it, answers the first execution. The second pass adds no row and no GitHub call.
import {
  ActuatorRateLimitLive,
  CheckRunApplierLive,
  installationQuotaLayer,
} from "@fractalboxdev/flare-dispatch-github";
import { fakeGithub, fakeGithubLayers } from "@fractalboxdev/flare-dispatch-github/testing";
import {
  Admission,
  d1Admission,
  type IntakeAdmitInput,
} from "@fractalboxdev/flare-dispatch-intake";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { buildProfile, placementInputs } from "@fractalboxdev/flare-dispatch-profile";
import { drainOnce, executionId as newExecutionId } from "@fractalboxdev/mameko-coordinator";
import { d1OutboxStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { concludeFactsLayer } from "../../src/github.ts";
import { envOf, NOW, type TestD1 } from "../conclude.test-support.ts";

const profile = buildProfile("production");
const HEAD_SHA = "b".repeat(40);
const FIRST = newExecutionId(NOW, () => 0.1);
const SECOND = newExecutionId(NOW, () => 0.2);

const admitInput = (executionId: string): IntakeAdmitInput => {
  const { facts, params } = placementInputs(profile, {
    class: "required",
    labels: [],
    confidentiality: "non-confidential",
  });
  return {
    executionId,
    scopeId: "acme/app",
    run: "check",
    className: "required",
    labels: [],
    enqueuedAtMs: NOW,
    dedup: {
      sha256: "1".repeat(64),
      canonical: `check:ci:acme/app:${HEAD_SHA}`,
      requestDigest: null,
      digestBody: null,
      onMismatch: "duplicate",
    },
    placement: {
      facts: {
        runLabels: facts.runLabels,
        confidentiality: facts.confidentiality,
        cloudPinned: facts.cloudPinned,
        cloudOnly: facts.cloudOnly,
        localOnly: facts.localOnly,
        needsLocalModel: facts.needsLocalModel,
      },
      params,
    },
    maxDurationSec: 600,
    grants: { setup: [], agent: [] },
    check: { name: "flare-dispatch/check:ci", headSha: HEAD_SHA },
  };
};

const admit = (db: TestD1, executionId: string) =>
  Effect.runPromise(
    Admission.use((a) => a.admit(admitInput(executionId))).pipe(
      Effect.provide(d1Admission(db, profile)),
    ),
  );

const drain = (db: TestD1, gh: ReturnType<typeof fakeGithub>, now: number) =>
  Effect.runPromise(
    drainOnce({
      now,
      token: (id) => `tok-${id}-${now}`,
      random: () => 0,
      actuatorOf: { "check.open": "checkRun" },
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

const outbox = (db: TestD1) =>
  db.sqlite
    .prepare(
      "select execution_id, intent_key, kind, payload_json, state, external_ref from outbox order by id",
    )
    .all();

describe("the check.open row under a replayed admission", () => {
  it("[FD-GH-005] admission inserts cp:check:open once, and its applier creates one queued check run on the head SHA", async () => {
    const db = await migratedD1();
    const gh = fakeGithub();

    expect(await admit(db, FIRST)).toMatchObject({ _tag: "Queued", executionId: FIRST });
    expect(outbox(db)).toMatchObject([
      {
        execution_id: FIRST,
        intent_key: "cp:check:open",
        kind: "check.open",
        state: "pending",
      },
    ]);
    expect(JSON.parse((outbox(db)[0] as { payload_json: string }).payload_json)).toEqual({
      name: "flare-dispatch/check:ci",
      head_sha: HEAD_SHA,
    });

    const now = NOW + 1_000;
    await drain(db, gh, now);
    expect(gh.runs).toEqual([
      expect.objectContaining({
        name: "flare-dispatch/check:ci",
        external_id: FIRST,
        status: "queued",
      }),
    ]);
    expect(outbox(db)).toMatchObject([{ state: "applied", external_ref: "1000" }]);
    expect(gh.alarms).toEqual([]);

    // The same request again: admission answers the first execution, inserts no second row, and the drain sends nothing.
    const first = outbox(db);
    const calls = gh.calls.length;
    expect(await admit(db, SECOND)).toEqual({ _tag: "Duplicate", executionId: FIRST });
    await drain(db, gh, now + 60_000);
    expect(outbox(db)).toEqual(first);
    expect(gh.calls).toHaveLength(calls);
    expect(gh.runs).toHaveLength(1);
  });
});
