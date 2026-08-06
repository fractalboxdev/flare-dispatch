// The facade over a real service binding, inside workerd
// (`vitest.workers.config.ts`).
//
// ADR-0003's claim is that a consumer's whole view of the substrate is this one
// hop, speaking plain structural types. Testing it in-isolate would prove the
// method bodies and none of that, so the suite calls the entrypoints through
// miniflare service bindings to the worker under test: the same RPC path a
// consumer's `services: [{ entrypoint: "DispatcherFacade" }]` takes, with
// structured-clone in the middle. A shape that cannot cross it fails here.
//
// Admission runs against the real D1 from `migrations/`, with the pool caps cut
// to `{lean: 2, task: 1}` in the config so the cap-refusal path is reachable
// without admitting seven executions.
//
// The paths that reach a container are not driven here - `ensureSandbox` past
// admission, `execUnderGrant`, and the `abort` / `checkpoint` teardowns, all of
// which call into the SDK's container control plane. No container engine runs
// in the pool, so each of them blocks on a container that never arrives. What
// is covered is every refusal and every admission fact a consumer sees before a
// boot, which is where the whole typed-refusal contract lives; the exec dedupe
// is driven directly against the DO in `exec-dedupe.workers.test.ts`.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isRefusalKind } from "@fractalboxdev/flare-dispatch-substrate-contract";
import { recordDenialD1 } from "./admission/denials-d1";
import { MAX_SANDBOX_ID } from "./engine/policy";
import type { SubstrateSandboxBase } from "./sandbox-do";

const dispatcher = () => env.DISPATCHER_FACADE;
const fractalbot = () => env.FRACTALBOT_FACADE;

const RECIPE = { version: 1, repo: { owner: "acme", name: "widget" } } as const;

let seq = 0;
const freshKey = () => `exec-${++seq}-${crypto.randomUUID().slice(0, 8)}`;

describe("poolStatus - the partition a consumer can see", () => {
  it("reports every pool with the deployed caps", async () => {
    const status = await dispatcher().poolStatus();
    expect(status.pools.map((p) => p.pool)).toEqual(["lean", "browser", "agent", "task"]);
    // From the POOL_CAPS override: the two named pools move, the rest hold the
    // default partition.
    expect(status.pools.map((p) => p.cap)).toEqual([2, 3, 3, 1]);
    expect(status.pools.every((p) => p.busy === 0 && p.queued === 0)).toBe(true);
  });

  it("attributes live occupancy to the consumer that holds it", async () => {
    const key = freshKey();
    expect(await dispatcher().admissionAttempt(key, RECIPE)).toMatchObject({ admitted: true });

    const status = await dispatcher().poolStatus();
    const lean = status.pools.find((p) => p.pool === "lean");
    expect(lean).toMatchObject({ busy: 1, byConsumer: { dispatcher: 1 } });
    // Consumer identity is the entrypoint the binding targets, never a field on
    // the call - so fractalbot's pool is untouched by a dispatcher admission.
    expect(status.pools.find((p) => p.pool === "task")).toMatchObject({ busy: 0 });
  });
});

describe("admission (ADR-0004) - the ceiling is the substrate's to own", () => {
  it("admits, refuses over cap with the facts to act on, then frees on release", async () => {
    const first = freshKey();
    const second = freshKey();
    const third = freshKey();
    expect(await dispatcher().admissionAttempt(first, RECIPE)).toMatchObject({ admitted: true });
    expect(await dispatcher().admissionAttempt(second, RECIPE)).toMatchObject({ admitted: true });

    // Cap 2 is now full. The refusal carries what a consumer needs to decide
    // whether to wait or tell a human - not an opaque throw.
    expect(await dispatcher().admissionAttempt(third, RECIPE)).toEqual({
      admitted: false,
      pool: "lean",
      position: 0,
      poolBusy: 2,
      cap: 2,
    });

    await dispatcher().admissionRelease(first);
    expect(await dispatcher().admissionAttempt(third, RECIPE)).toMatchObject({ admitted: true });
  });

  it("hands back a ticket expiry a consumer can heartbeat against", async () => {
    const before = Date.now();
    const outcome = await dispatcher().admissionAttempt(freshKey(), RECIPE);
    expect(outcome.admitted).toBe(true);
    if (!outcome.admitted) return;
    expect(outcome.expiresAt).toBeGreaterThan(before);
  });

  it("keeps a queue position that a second waiter can read", async () => {
    const held = freshKey();
    await dispatcher().admissionAttempt(held, RECIPE);
    await dispatcher().admissionAttempt(freshKey(), RECIPE);

    const waiting = freshKey();
    await dispatcher().admissionEnqueue(waiting, RECIPE);
    const behind = freshKey();
    const position = await dispatcher().admissionEnqueue(behind, RECIPE);
    expect(position).toMatchObject({ pool: "lean", cap: 2, poolBusy: 2 });
    expect(position.position).toBeGreaterThanOrEqual(1);
  });

  it("refuses ensureSandbox fail-fast when the pool is full, naming the pool", async () => {
    await dispatcher().admissionAttempt(freshKey(), RECIPE);
    await dispatcher().admissionAttempt(freshKey(), RECIPE);

    const outcome = await dispatcher().ensureSandbox(freshKey(), RECIPE, { mode: "refuse" });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { kind: "admission-refused", pool: "lean", cap: 2, poolBusy: 2 },
    });
    if (outcome.ok) return;
    expect(outcome.refusal).toHaveProperty("retryAfterMs");
  });

  it("partitions the pools by consumer policy, never by anything a caller says", async () => {
    // fractalbot lands on `task` (cap 1) and the dispatcher on `lean` (cap 2)
    // from the SAME recipe: the image class is policy-selected from the
    // entrypoint identity, not named by the call (ADR-0010).
    expect(await fractalbot().admissionAttempt(freshKey(), RECIPE)).toMatchObject({
      admitted: true,
    });
    expect(await fractalbot().admissionAttempt(freshKey(), RECIPE)).toMatchObject({
      admitted: false,
      pool: "task",
      cap: 1,
    });
    expect(await dispatcher().admissionAttempt(freshKey(), RECIPE)).toMatchObject({
      admitted: true,
    });
  });
});

describe("typed refusals - every failure a consumer must render", () => {
  it("refuses a recipe whose repo is not an owner/name pair", async () => {
    const outcome = await dispatcher().ensureSandbox(
      freshKey(),
      { version: 1, repo: { owner: "acme", name: "widget/extra" } },
      { mode: "refuse" },
    );
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { kind: "recipe-rejected", reason: "recipe.repo is not an owner/name pair" },
    });
  });

  it("refuses a grant profile the engine does not serve yet", async () => {
    const outcome = await dispatcher().ensureSandbox(
      freshKey(),
      { version: 1, repo: { owner: "acme", name: "widget" }, profiles: ["js-install"] },
      { mode: "refuse" },
    );
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { kind: "recipe-rejected" },
    });
  });

  it("refuses a negative recipe version", async () => {
    const outcome = await dispatcher().ensureSandbox(
      freshKey(),
      { version: -1 },
      { mode: "refuse" },
    );
    expect(outcome).toMatchObject({ ok: false, refusal: { kind: "recipe-rejected" } });
  });

  it("turns the SDK's id-length limit into a refusal instead of a broken boot", async () => {
    // `sanitizeSandboxId` throws above 63 chars at container start, where it
    // would surface as an execution that failed for no visible reason.
    const outcome = await dispatcher().ensureSandbox(
      "k".repeat(MAX_SANDBOX_ID + 1),
      RECIPE,
      { mode: "refuse" },
    );
    expect(outcome).toMatchObject({ ok: false, refusal: { kind: "recipe-rejected" } });
    if (outcome.ok || !isRefusalKind(outcome.refusal, "recipe-rejected")) return;
    expect(outcome.refusal.reason).toContain("over the SDK's 63");
  });

  it("survives structured clone: the refusal a consumer receives is plain data", async () => {
    const outcome = await dispatcher().ensureSandbox(freshKey(), { version: -1 }, { mode: "refuse" });
    // Not a class instance, not a proxy - the same object after a round trip
    // through structuredClone is what makes the boundary framework-free.
    expect(structuredClone(outcome)).toEqual(outcome);
  });
});

describe("denials (ADR-0005) - retrieved with the artifacts", () => {
  it("serves the execution's denial events to the consumer that owns the key", async () => {
    const key = freshKey();
    // Reach the object the facade would address, and record against its own id
    // the way the egress handler and the outbound proxy do.
    const stub = env.SANDBOX_LEAN.get(
      env.SANDBOX_LEAN.idFromName(`dispatcher:${key}`),
    ) as DurableObjectStub<SubstrateSandboxBase>;
    const containerId = await runInDurableObject(stub, (_i, state) => state.id.toString());
    await recordDenialD1(env.ADMISSION_DB, containerId, {
      host: "registry.npmjs.org",
      method: "GET",
      path: "/left-pad",
      reason: "host registry.npmjs.org is not admitted (refused by the container gate)",
    });

    expect(await dispatcher().denials(key)).toEqual([
      {
        host: "registry.npmjs.org",
        method: "GET",
        path: "/left-pad",
        reason: "host registry.npmjs.org is not admitted (refused by the container gate)",
        count: 1,
      },
    ]);
  });

  it("gives one consumer nothing of another's, even for an identical key", async () => {
    const key = freshKey();
    const stub = env.SANDBOX_LEAN.get(
      env.SANDBOX_LEAN.idFromName(`dispatcher:${key}`),
    ) as DurableObjectStub<SubstrateSandboxBase>;
    const containerId = await runInDurableObject(stub, (_i, state) => state.id.toString());
    await recordDenialD1(env.ADMISSION_DB, containerId, {
      host: "evil.example",
      method: "GET",
      path: "/",
      reason: "not admitted",
    });

    // The consumer prefix is baked into the DO name, so the same key under a
    // different entrypoint addresses a different object entirely.
    expect(await fractalbot().denials(key)).toEqual([]);
  });

  it("answers empty rather than throwing for an execution with no denials", async () => {
    expect(await dispatcher().denials(freshKey())).toEqual([]);
  });
});
