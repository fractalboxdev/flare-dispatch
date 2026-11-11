// Intake in front of mameko's admission: the workflow start after the commit, unplaceable requests, the eligible kinds
// the record keeps, the request digest of an idempotent retry inside a cooldown window, and a held request's release.
import { createHash } from "node:crypto";
import {
  executionId as newExecutionId,
  startUnstartedExecutions,
} from "@fractalboxdev/mameko-coordinator";
import { d1ExecutionStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Admission, ExecutionStartFailed } from "./config.ts";
import { canonicalJson } from "./dedup.ts";
import {
  admit,
  authenticated,
  BASE,
  harness,
  HEAD,
  NOW,
  pullRequestPayload,
  refusal,
  signedWebhook,
  type Harness,
  type HarnessOptions,
} from "./harness.test-support.ts";
import { handleIntake } from "./routes.ts";
import { IntakeStore } from "./store.ts";
import { releaseHeld } from "./submit.ts";

/** A dispatch of `run` with the body's commit, inputs, label and class, keyed when `key` is given. */
const dispatchOf = (
  run: string,
  body: { sha?: string; inputs: unknown; label?: string; class?: string },
  key?: string,
) =>
  authenticated({
    run,
    sha: body.sha,
    inputs: body.inputs,
    label: body.label ?? null,
    classInput: body.class ?? null,
    idempotency: key === undefined ? null : { key, body },
  });

const dispatch = (h: Harness, run: string, body: Parameters<typeof dispatchOf>[1], key?: string) =>
  admit(h, dispatchOf(run, body, key));

/** Class resolution that answers a dispatch's `class` input, else the run's default class. */
const requested: HarnessOptions["resolve"] = (r) => ({
  _tag: "Class",
  class: r.classInput ?? r.run.defaultClass,
  labels: r.trigger === "fork-pr" ? ["untrusted-input"] : [],
  alarm: null,
});

const check = (cls?: string) => ({
  inputs: { sha: HEAD },
  label: "ci",
  ...(cls === undefined ? {} : { class: cls }),
});

const executionRow = (h: Harness, id: string) =>
  h.rows("select status, reason, engine_started_at from executions where id = ?", id)[0] as {
    status: string;
    reason: string | null;
    engine_started_at: number | null;
  };

const recordKinds = (h: Harness, id: string) =>
  h.rows("select eligible_kinds from intake_records where execution_id = ?", id)[0]?.eligible_kinds;

const placementKinds = (h: Harness, id: string) =>
  h.rows("select eligible_kinds from placements where execution_id = ?", id)[0]?.eligible_kinds;

describe("the workflow start at admission", () => {
  it.each(["required", "interactive"])(
    "MAMEKO-ADM-029 starts a queued %s execution's workflow once, under its id, after the commit",
    async (cls) => {
      let committed: unknown;
      const h: Harness = await harness({
        resolve: requested,
        startExecution: (payload) =>
          Effect.sync(() => {
            committed = h.rows("select status from executions where id = ?", payload.executionId);
          }),
      });
      const { executionId: id, className } = await dispatch(h, "check", check(cls));
      expect(className).toBe(cls);
      expect(h.recorded.started).toEqual([
        expect.objectContaining({ executionId: id, className: cls }),
      ]);
      expect(committed).toEqual([{ status: "pending" }]);
      expect(executionRow(h, id).engine_started_at).toBe(NOW);
    },
  );

  it("MAMEKO-ADM-031 starts no workflow for a batch execution, whose class defers it", async () => {
    const h = await harness({ resolve: requested });
    const { executionId } = await dispatch(h, "check", check("batch"));
    expect(executionRow(h, executionId)).toMatchObject({
      status: "pending",
      engine_started_at: null,
    });
    expect(h.recorded.started).toEqual([]);
  });

  it("MAMEKO-ADM-030 a start that fails after the commit leaves the execution queued, and the admission sweep starts it", async () => {
    const h = await harness({
      resolve: requested,
      startExecution: (payload) =>
        Effect.fail(
          new ExecutionStartFailed({
            executionId: payload.executionId,
            className: payload.className,
            cause: "engine unreachable",
          }),
        ),
    });
    const { executionId: id, duplicate } = await dispatch(h, "check", check("required"));
    expect(duplicate).toBe(false);
    expect(executionRow(h, id)).toMatchObject({ status: "pending", engine_started_at: null });
    expect((await h.run(IntakeStore.use((s) => s.get(id))))?.inputs).toEqual({ sha: HEAD });
    expect(recordKinds(h, id)).toBe(placementKinds(h, id));

    const swept: string[] = [];
    await Effect.runPromise(
      startUnstartedExecutions(NOW + 60_000, {
        catalogue: h.settings.profile.classes,
        deferredClasses: ["batch"],
        start: (payload) => Effect.sync(() => void swept.push(payload.executionId)),
        wake: () => Effect.void,
      }).pipe(Effect.provide(d1ExecutionStore(h.db))),
    );
    expect(swept).toEqual([id]);
    expect(executionRow(h, id).engine_started_at).toBe(NOW + 60_000);
  });
});

describe("placement at admission", () => {
  it("MAMEKO-ADM-035 an unplaceable request concludes placement: no eligible executor, with no placement and no start", async () => {
    const h = await harness({
      resolve: () => ({
        _tag: "Class",
        class: "interactive",
        labels: ["local-only", "cloud-only"],
        alarm: null,
      }),
    });
    const { executionId: id } = await dispatch(h, "check", check());
    expect(executionRow(h, id)).toMatchObject({
      status: "failure",
      reason: "placement: no eligible executor",
    });
    expect(placementKinds(h, id)).toBeUndefined();
    expect(recordKinds(h, id)).toBe("[]");
    expect(h.recorded.started).toEqual([]);
  });

  it("[FD-PROF-037] a fork pull request concludes placement: no eligible executor while no pool open to its class runs separated (MAMEKO-ADM-102)", async () => {
    const h = await harness();
    await h.run(
      handleIntake(
        await signedWebhook("pull_request", pullRequestPayload({ headRepo: "mallory/app" })),
        "webhooks/github",
      ),
    );
    const ids = h.records().map((r) => r.execution_id as string);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(executionRow(h, id)).toMatchObject({
        status: "failure",
        reason: "placement: no eligible executor",
      });
      expect(placementKinds(h, id)).toBeUndefined();
      expect(recordKinds(h, id)).toBe("[]");
    }
    expect(h.recorded.started).toEqual([]);
  });

  it("the record keeps the eligible kinds admission wrote on the placement row", async () => {
    const h = await harness({ resolve: requested });
    const { executionId: id } = await dispatch(h, "check", check("interactive"));
    expect(placementKinds(h, id)).toMatch(/^\[.+\]$/);
    expect(recordKinds(h, id)).toBe(placementKinds(h, id));
  });
});

describe("an idempotent retry inside a cooldown window", () => {
  const lint = { inputs: { sha: HEAD } };

  it("[FD-INT-010] [FD-INT-057] answers the admitted execution for the same body and 409 conflict for another", async () => {
    const h = await harness();
    const first = await dispatch(h, "lint", lint, "lint-7");
    await h.adjust(10_000);
    expect(await dispatch(h, "lint", lint, "lint-7")).toEqual({ ...first, duplicate: true });
    expect(await refusal(h, dispatchOf("lint", { inputs: { sha: BASE } }, "lint-7"))).toEqual({
      status: 409,
      code: "conflict",
      executionId: first.executionId,
    });
    // Admission stores the digest of the body's canonical JSON, the value intake compares on the held path.
    expect(h.rows("select request_digest from dedup_keys")).toEqual([
      { request_digest: createHash("sha256").update(canonicalJson(lint)).digest("hex") },
    ]);
    expect(h.rows("select count(*) as n from intake_held")[0]!.n).toBe(0);
  });
});

describe("a held request's release", () => {
  const held = async (options: HarnessOptions = {}) => {
    const h = await harness(options);
    await dispatch(h, "lint", { sha: HEAD, inputs: { sha: HEAD } });
    await h.adjust(10_000);
    const { executionId: id } = await dispatch(h, "lint", { sha: BASE, inputs: { sha: BASE } });
    expect(h.rows("select execution_id from intake_held")).toEqual([{ execution_id: id }]);
    const first = h.records()[0]!.execution_id as string;
    // The first `lint` has finished, so the class's per-repository queue bound has room.
    h.db.sqlite.prepare("update executions set status = 'success' where id = ?").run(first);
    await h.adjust(50_000);
    return { h, id };
  };

  it("[FD-INT-057] admits a request whose admission committed before an earlier pass ended, and keeps its record", async () => {
    const { h, id } = await held();
    const [request] = await h.run(IntakeStore.use((s) => s.due(NOW + 60_000, 1)));
    await h.run(Admission.use((a) => a.admit({ ...request!.admit, enqueuedAtMs: NOW + 60_000 })));
    expect(await h.run(releaseHeld())).toMatchObject({ admitted: 1, duplicate: 0 });
    expect(h.rows("select count(*) as n from intake_held")[0]!.n).toBe(0);
    expect(recordKinds(h, id)).toBe(placementKinds(h, id));
    expect(
      h.rows("select execution_id from intake_cooldowns where execution_id = ?", id),
    ).toHaveLength(1);
  });

  it("[FD-INT-057] concludes a request whose admission concluded it before an earlier pass ended, and arms no window", async () => {
    const { h, id } = await held();
    const [request] = await h.run(IntakeStore.use((s) => s.due(NOW + 60_000, 1)));
    // An admission with no executor kind to place on concludes the request and writes its dedup key, so the next pass
    // answers its own id.
    const { placement } = request!.admit;
    await h.run(
      Admission.use((a) =>
        a.admit({
          ...request!.admit,
          placement: { ...placement, params: { ...placement.params, kinds: [] } },
          enqueuedAtMs: NOW + 60_000,
        }),
      ),
    );
    expect(executionRow(h, id)).toMatchObject({
      status: "failure",
      reason: "placement: no eligible executor",
    });
    expect(await h.run(releaseHeld())).toMatchObject({ admitted: 0, concluded: 1, duplicate: 0 });
    expect(h.rows("select count(*) as n from intake_held")[0]!.n).toBe(0);
    expect(recordKinds(h, id)).toBe("[]");
    expect(
      h.rows("select execution_id from intake_cooldowns where execution_id = ?", id),
    ).toHaveLength(0);
  });

  it("[FD-INT-057] MAMEKO-ADM-042 concludes a held batch request released into the class's full global bound deferred, and arms no window", async () => {
    const { h, id } = await held();
    const [request] = await h.run(IntakeStore.use((s) => s.due(NOW + 60_000, 1)));
    expect(request!.admit.className).toBe("batch");
    // Fill `batch`'s global bound with one queued execution per repository, each under its own per-(run, repository)
    // bound.
    const global = (h.settings.profile.classes.find((c) => c.name === "batch")!.bounds as {
      global: number;
    })!.global;
    for (let i = 0; i < global; i++) {
      const answer = await h.run(
        Admission.use((a) =>
          a.admit({
            ...request!.admit,
            executionId: newExecutionId(NOW + i, Math.random),
            scopeId: `acme/filler-${i}`,
            dedup: { ...request!.admit.dedup, canonical: `lint:acme/filler-${i}:${BASE}` },
          }),
        ),
      );
      expect(answer._tag).toBe("Queued");
    }
    expect(await h.run(releaseHeld())).toMatchObject({ admitted: 0, concluded: 1, duplicate: 0 });
    expect(executionRow(h, id)).toMatchObject({ status: "deferred", engine_started_at: null });
    expect(h.rows("select count(*) as n from intake_held")[0]!.n).toBe(0);
    expect(
      h.rows("select execution_id from intake_cooldowns where execution_id = ?", id),
    ).toHaveLength(0);
  });

  it("[FD-INT-057] admits a request whose workflow start fails, and leaves it for the admission sweep", async () => {
    const { h, id } = await held({
      resolve: () => ({ _tag: "Class", class: "required", labels: [], alarm: null }),
      startExecution: (payload) =>
        Effect.fail(
          new ExecutionStartFailed({
            executionId: payload.executionId,
            className: payload.className,
            cause: "engine unreachable",
          }),
        ),
    });
    expect(await h.run(releaseHeld())).toMatchObject({ admitted: 1, unavailable: 0 });
    expect(executionRow(h, id)).toMatchObject({ status: "pending", engine_started_at: null });
    expect(h.rows("select count(*) as n from intake_held")[0]!.n).toBe(0);
    expect(recordKinds(h, id)).toBe(placementKinds(h, id));
  });
});
