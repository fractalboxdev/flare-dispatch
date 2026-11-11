import { LocalRegistration } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { memoryD1 } from "./d1.test-support.ts";
import {
  type LocalSubmission,
  LocalSubmit,
  localRegistrationLayer,
  needsRegistration,
} from "./registration.ts";
import {
  appendIntent,
  DECORATION_KINDS,
  type LocalRunContext,
  type WritebackRequest,
} from "./run-context.ts";
import { LocalStore, localStoreD1 } from "./store.ts";

const context = (over: Partial<LocalRunContext> = {}) => {
  const sent: WritebackRequest[] = [];
  const journal: unknown[] = [];
  const ctx: LocalRunContext = {
    executionId: "01J0000000000000000000000X",
    registered: true,
    journal: (e) => journal.push(e),
    send: (r) => Effect.sync(() => void sent.push(r)),
    scheduler: { offline: () => false, grantRejected: () => false },
    ...over,
  };
  return { ctx, sent, journal };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));

describe("local run context", () => {
  it("[FD-LOCAL-018] records exactly check.summary and check.annotations as logged no-ops", async () => {
    expect(DECORATION_KINDS).toEqual(["check.summary", "check.annotations"]);
    for (const registered of [true, false]) {
      const { ctx, sent, journal } = context({ registered });
      await Effect.runPromise(appendIntent(ctx, "report", 0, "check.summary", { markdown: "x" }));
      await Effect.runPromise(appendIntent(ctx, "report", 1, "check.annotations", []));
      expect(sent).toEqual([]);
      expect(journal).toEqual([
        { kind: "check.summary", key: "run:report:0", noOp: true },
        { kind: "check.annotations", key: "run:report:1", noOp: true },
      ]);
    }
  });

  it("[FD-LOCAL-019] [FD-LOCAL-055] turns a registered execution's other appends into local.writeback keyed run:<step>:<index>", async () => {
    const { ctx, sent } = context();
    await Effect.runPromise(appendIntent(ctx, "propose", 0, "pr.propose", { m: 1 }));
    await Effect.runPromise(appendIntent(ctx, "review", 2, "review", { body: "b" }));
    expect(sent).toEqual([
      {
        execution_id: ctx.executionId,
        intents: [{ intent_key: "run:propose:0", kind: "pr.propose", payload: { m: 1 } }],
      },
      {
        execution_id: ctx.executionId,
        intents: [{ intent_key: "run:review:2", kind: "review", payload: { body: "b" } }],
      },
    ]);
  });

  it("[FD-LOCAL-020] fails an unregistered execution's step with RegistrationRequired", async () => {
    const { ctx, sent } = context({ registered: false });
    const result = await run(appendIntent(ctx, "propose", 0, "comment", {}));
    expect(result._tag === "Failure" && result.failure._tag).toBe("RegistrationRequired");
    expect(sent).toEqual([]);
  });

  it("[FD-LOCAL-067] sends no writeback request while offline", async () => {
    const { ctx, sent } = context({
      scheduler: { offline: () => true, grantRejected: () => false },
    });
    const result = await run(appendIntent(ctx, "propose", 0, "pr.propose", {}));
    expect(result._tag === "Failure" && result.failure).toMatchObject({
      _tag: "WritebackHeld",
      reason: "offline",
    });
    expect(sent).toEqual([]);
  });

  it("[FD-LOCAL-071] sends no writeback request for a registered execution a new grant rejected (simulation)", async () => {
    // Each trace interleaves grants that reject or keep in-flight executions with their appends.
    const step = fc.oneof(
      fc.record({ op: fc.constant("grant" as const), rejects: fc.subarray(["a", "b", "c"]) }),
      fc.record({ op: fc.constant("append" as const), execution: fc.constantFrom("a", "b", "c") }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 30 }), async (trace) => {
        const rejected = new Set<string>();
        const sent: WritebackRequest[] = [];
        const expectedSends: string[] = [];
        for (const [i, s] of trace.entries()) {
          if (s.op === "grant") {
            for (const e of s.rejects) rejected.add(e);
            continue;
          }
          if (!rejected.has(s.execution)) expectedSends.push(s.execution);
          await run(
            appendIntent(
              {
                executionId: s.execution,
                registered: true,
                journal: () => {},
                send: (r) => Effect.sync(() => void sent.push(r)),
                scheduler: { offline: () => false, grantRejected: (e) => rejected.has(e) },
              },
              "s",
              i,
              "pr.propose",
              {},
            ),
          );
        }
        return JSON.stringify(sent.map((r) => r.execution_id)) === JSON.stringify(expectedSends);
      }),
      { numRuns: 300 },
    );
  });
});

const registration = {
  treeHash: "t1",
  baseCommit: "c".repeat(40),
  runDigest: "sha256:run",
  imageDigest: "sha256:img",
  platform: "darwin-arm64",
  inputsDigest: "sha256:in",
  reuseKey: "rk1",
  scopeId: "scope",
  executorId: "dev-1",
  repository: "o/r",
  ref: "refs/heads/feature",
  inputs: { sha: "c".repeat(40) },
  environmentNames: ["NODE_ENV", "CI"],
  wants: { reuse: true, writeback: false },
};

interface Submitted {
  readonly lease: { readonly leaseId: string; readonly epoch: number };
  readonly run: string;
  readonly submission: LocalSubmission;
}

/**
 * Intake's local submit as the registration port sees it: `check` is the one catalogue run, and a submit keys on the
 * lease, run, tree hash and inputs digest, so a repeated one answers the same execution.
 */
const fakeSubmit = (submitted: Submitted[]) =>
  Layer.succeed(LocalSubmit, {
    submit: (lease, run, submission) =>
      Effect.sync(() => {
        submitted.push({ lease, run, submission });
        return run === "check"
          ? ({
              _tag: "admitted",
              executionId: `exec:${lease.leaseId}:${run}:${submission.treeHash}:${submission.inputsDigest}`,
            } as const)
          : ({ _tag: "rejected" } as const);
      }),
  });

const harness = () => {
  const db = memoryD1();
  const store = localStoreD1(db);
  const submitted: Submitted[] = [];
  const layer = Layer.merge(
    localRegistrationLayer.pipe(Layer.provide(Layer.merge(store, fakeSubmit(submitted)))),
    store,
  );
  const go = <A, E>(f: Effect.Effect<A, E, LocalRegistration | LocalStore>) =>
    Effect.runPromise(f.pipe(Effect.provide(layer)));
  return { db, go, submitted };
};

const registerVia = (run: string, payload: unknown, lease = { leaseId: "L1", epoch: 1 }) =>
  Effect.gen(function* () {
    const port = yield* LocalRegistration;
    return yield* port.register(lease, run, payload);
  });

describe("local registration port", () => {
  it("[FD-LOCAL-072] records environment names beside the tree hash, base commit, digests, platform and inputs digest", async () => {
    const { go } = harness();
    const answer = await go(
      Effect.gen(function* () {
        const port = yield* LocalRegistration;
        return yield* port.register({ leaseId: "L1", epoch: 3 }, "check", registration);
      }),
    );
    expect(answer._tag).toBe("accepted");
    const { executionId, nonce } = answer as { executionId: string; nonce: string };
    expect(executionId).toBe("exec:L1:check:t1:sha256:in");
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    const record = await go(
      Effect.gen(function* () {
        return yield* (yield* LocalStore).byExecution(executionId);
      }),
    );
    expect(record).toMatchObject({
      leaseId: "L1",
      epoch: 3,
      treeHash: "t1",
      baseCommit: "c".repeat(40),
      runDigest: "sha256:run",
      imageDigest: "sha256:img",
      platform: "darwin-arm64",
      inputsDigest: "sha256:in",
      environmentNames: ["CI", "NODE_ENV"],
      nonce,
      startedAt: null,
    });
  });

  it("[FD-LOCAL-075] registers exactly when the execution requests reuse or writeback", async () => {
    expect(needsRegistration({ reuse: false, writeback: false })).toBe(false);
    expect(needsRegistration({ reuse: true, writeback: false })).toBe(true);
    expect(needsRegistration({ reuse: false, writeback: true })).toBe(true);
    const { go } = harness();
    const register = (payload: unknown, run = "check") => go(registerVia(run, payload));
    expect(await register({ ...registration, wants: { reuse: false, writeback: false } })).toEqual({
      _tag: "rejected",
    });
    expect(await register(registration, "unknown-run")).toEqual({ _tag: "rejected" });
    expect(await register({ ...registration, treeHash: undefined })).toEqual({ _tag: "rejected" });
  });

  it("a store failure rejects the registration, so the rehearsal runs unregistered", async () => {
    const { db, go } = harness();
    db.fail.on = true;
    const answer = await go(registerVia("check", registration));
    expect(answer).toEqual({ _tag: "rejected" });
  });

  it("[FD-INT-061] an accepted registration is one local submit through intake, under the admitted execution id", async () => {
    const { go, submitted } = harness();
    const answer = await go(registerVia("check", registration, { leaseId: "L7", epoch: 4 }));
    expect(submitted).toEqual([
      {
        lease: { leaseId: "L7", epoch: 4 },
        run: "check",
        submission: {
          repository: "o/r",
          baseCommit: "c".repeat(40),
          ref: "refs/heads/feature",
          treeHash: "t1",
          inputsDigest: "sha256:in",
          inputs: { sha: "c".repeat(40) },
        },
      },
    ]);
    expect(answer).toMatchObject({ _tag: "accepted", executionId: "exec:L7:check:t1:sha256:in" });
    const record = await go(
      Effect.gen(function* () {
        return yield* (yield* LocalStore).byExecution("exec:L7:check:t1:sha256:in");
      }),
    );
    expect(record).toMatchObject({ leaseId: "L7", epoch: 4, run: "check" });
  });

  it("[FD-INT-061] a registration intake refuses is rejected and records no rehearsal", async () => {
    const { go, submitted } = harness();
    expect(await go(registerVia("unknown-run", registration))).toEqual({ _tag: "rejected" });
    expect(submitted.map((s) => s.run)).toEqual(["unknown-run"]);
    const recorded = await go(
      Effect.gen(function* () {
        return yield* (yield* LocalStore).byReuseKey("scope", "rk1");
      }),
    );
    expect(recorded).toEqual([]);
  });

  it("a registration that requests neither reuse nor writeback or fails to decode submits nothing", async () => {
    const { go, submitted } = harness();
    await go(registerVia("check", { ...registration, wants: { reuse: false, writeback: false } }));
    await go(registerVia("check", { ...registration, ref: undefined }));
    expect(submitted).toEqual([]);
  });

  it("a repeated registration that intake deduplicates receives the nonce the first one did", async () => {
    const { go } = harness();
    const first = await go(registerVia("check", registration));
    const again = await go(registerVia("check", registration));
    expect(again).toEqual(first);
  });

  it("[FD-LOCAL-072] a deduplicated repeat that differs from the stored record is rejected and leaves the record unchanged", async () => {
    const { go } = harness();
    const first = await go(registerVia("check", registration));
    const { executionId } = first as { executionId: string };
    const read = () =>
      go(
        Effect.gen(function* () {
          return yield* (yield* LocalStore).byExecution(executionId);
        }),
      );
    const stored = await read();
    const again = await go(registerVia("check", { ...registration, imageDigest: "sha256:other" }));
    expect(again).toEqual({ _tag: "rejected" });
    expect(await read()).toEqual(stored);
  });
});
