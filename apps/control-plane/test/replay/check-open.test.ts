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
  d1IntakeStore,
  IntakeStore,
  type IntakeAdmitInput,
} from "@fractalboxdev/flare-dispatch-intake";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { buildProfile, placementInputs } from "@fractalboxdev/flare-dispatch-profile";
import { drainOnce, executionId as newExecutionId } from "@fractalboxdev/mameko-coordinator";
import { d1OutboxStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { concludeFactsLayer } from "../../src/github.ts";
import { envOf, NOW, record, type TestD1 } from "../conclude.test-support.ts";

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

const admit = (db: TestD1, executionId: string, overrides: Partial<IntakeAdmitInput> = {}) =>
  Effect.runPromise(
    Admission.use((a) => a.admit({ ...admitInput(executionId), ...overrides })).pipe(
      Effect.provide(d1Admission(db, profile)),
    ),
  );

const drain = (db: TestD1, gh: ReturnType<typeof fakeGithub>, now: number) =>
  Effect.runPromise(
    drainOnce({
      now,
      token: (id) => `tok-${id}-${now}`,
      random: () => 0,
      actuatorOf: { "check.open": "checkRun", "check.conclude": "checkRun" },
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
  it.each([
    { check: null, labels: [] },
    { check: { name: "flare-dispatch/check:ci", headSha: HEAD_SHA }, labels: ["local-only"] },
  ])(
    "[FD-PROF-043] admission concludes no-check and local-only requests without GitHub rows: %j",
    async (overrides) => {
      const db = await migratedD1();
      const input = admitInput(FIRST);
      expect(
        await admit(db, FIRST, {
          ...overrides,
          placement: { ...input.placement, params: { ...input.placement.params, kinds: [] } },
        }),
      ).toMatchObject({ _tag: "Concluded" });
      expect(outbox(db)).toEqual([]);
    },
  );

  it("[FD-GH-005] [FD-GH-027] supersession concludes an already opened check through a durable outcome row", async () => {
    const db = await migratedD1();
    const gh = fakeGithub();
    const group = "acme/app:12:check:ci";
    for (const id of [FIRST, SECOND])
      await Effect.runPromise(
        IntakeStore.use((s) => s.put(record(id))).pipe(Effect.provide(d1IntakeStore(db))),
      );
    await admit(db, FIRST, { supersessionKey: group });
    await drain(db, gh, NOW + 1_000);
    expect(gh.runs.find((r) => r.external_id === FIRST)?.status).toBe("queued");

    const next = {
      supersessionKey: group,
      enqueuedAtMs: NOW + 1,
      dedup: { ...admitInput(SECOND).dedup, sha256: "2".repeat(64), canonical: "next-head" },
    };
    await admit(db, SECOND, next);
    expect(outbox(db)).toContainEqual(
      expect.objectContaining({
        execution_id: FIRST,
        kind: "check.conclude",
        intent_key: "outcome",
        state: "pending",
      }),
    );
    await drain(db, gh, NOW + 2_000);
    expect(gh.runs.find((r) => r.external_id === FIRST)).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
    const before = outbox(db);
    expect(await admit(db, SECOND, next)).toEqual({ _tag: "Duplicate", executionId: SECOND });
    expect(outbox(db)).toEqual(before);
  });

  it("[FD-GH-027] [FD-GH-052] an unplaceable checked request creates a completed check from its admission outcome", async () => {
    const db = await migratedD1();
    const gh = fakeGithub();
    await Effect.runPromise(
      IntakeStore.use((s) => s.put(record(FIRST))).pipe(Effect.provide(d1IntakeStore(db))),
    );
    const input = admitInput(FIRST);
    const answer = await admit(db, FIRST, {
      placement: { ...input.placement, params: { ...input.placement.params, kinds: [] } },
    });
    expect(answer).toMatchObject({ _tag: "Concluded" });
    await drain(db, gh, NOW + 1_000);
    expect(gh.runs).toEqual([
      expect.objectContaining({
        external_id: FIRST,
        status: "completed",
        conclusion: "failure",
      }),
    ]);
  });

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
