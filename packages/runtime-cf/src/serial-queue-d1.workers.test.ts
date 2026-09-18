// Integration tests for the D1-backed serial queue — each guarantee made to
// fire against a real D1 binding inside workerd:
//
//   - two dispatches of one group run one after the other, never together;
//   - of three, the middle one is superseded (skipped, naming the newest) while
//     the first keeps running;
//   - a newer dispatch never touches a running row;
//   - groups are independent, a replayed enqueue supersedes nothing newer, and
//     a holder whose heartbeat stales stops blocking its group;
//   - the gate loop runs, skips, and times out through the caller's steps.

import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideSerial,
  makeSerialQueueD1,
  revisionMatches,
  runSerialGate,
  SERIAL_HOLDER_TTL_MS,
  type SerialQueueStore,
} from "./serial-queue-d1";
import { makeTestBindings, type TestBindings } from "./test-support-workers";

const G = "worker-deploy:owner/name@main";
const A = { id: "exec-a", rev: "aaaaaaaaaaaa1111" };
const B = { id: "exec-b", rev: "bbbbbbbbbbbb2222" };
const C = { id: "exec-c", rev: "cccccccccccc3333" };
const T0 = 1_000_000;

describe("makeSerialQueueD1 — serialization against real D1", () => {
  let bindings: TestBindings;
  let clock: number;
  let store: SerialQueueStore;

  beforeEach(async () => {
    bindings = await makeTestBindings();
    clock = T0;
    store = makeSerialQueueD1(bindings.db, () => clock);
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  const run = <A>(e: Effect.Effect<A, Error>) => Effect.runPromise(e);
  const state = async (id: string) =>
    (
      await bindings.db
        .prepare(`SELECT state FROM serial_queue WHERE execution_id = ?`)
        .bind(id)
        .first<{ state: string }>()
    )?.state;

  it("two dispatches — the second waits on the first, then runs once it releases", async () => {
    await run(store.enqueue(A.id, G, A.rev));
    expect((await run(store.attempt(A.id, G, A.rev))).kind).toBe("run");

    clock += 1;
    await run(store.enqueue(B.id, G, B.rev));
    const waiting = await run(store.attempt(B.id, G, B.rev));
    expect(waiting).toMatchObject({ kind: "wait", holderRevision: A.rev });

    await run(store.release(A.id));
    expect((await run(store.attempt(B.id, G, B.rev))).kind).toBe("run");
  });

  it("three dispatches — the middle waiter is superseded by the newest; the first keeps running", async () => {
    await run(store.enqueue(A.id, G, A.rev));
    await run(store.attempt(A.id, G, A.rev));
    clock += 1;
    await run(store.enqueue(B.id, G, B.rev));
    await run(store.attempt(B.id, G, B.rev));
    clock += 1;
    await run(store.enqueue(C.id, G, C.rev));

    expect(await run(store.attempt(B.id, G, B.rev))).toMatchObject({
      kind: "superseded",
      by: C.rev,
    });
    // In flight, untouched by either newer dispatch.
    expect(await state(A.id)).toBe("running");
    expect(await run(store.attempt(C.id, G, C.rev))).toMatchObject({
      kind: "wait",
      holderRevision: A.rev,
    });

    await run(store.release(A.id));
    expect((await run(store.attempt(C.id, G, C.rev))).kind).toBe("run");
  });

  it("a newer dispatch never supersedes a running execution", async () => {
    await run(store.enqueue(A.id, G, A.rev));
    await run(store.attempt(A.id, G, A.rev));
    clock += 1;
    await run(store.enqueue(B.id, G, B.rev));
    clock += 1;
    await run(store.enqueue(C.id, G, C.rev));
    expect(await state(A.id)).toBe("running");
    // Re-entrant: the holder's own attempt stays `run` (a replayed claim step).
    expect((await run(store.attempt(A.id, G, A.rev))).kind).toBe("run");
  });

  it("a replayed enqueue supersedes nothing that arrived after it", async () => {
    await run(store.enqueue(A.id, G, A.rev));
    clock += 1;
    await run(store.enqueue(B.id, G, B.rev));
    // A replays its enqueue step: its stored `enqueued_at` is the original.
    clock += 1;
    expect(await run(store.enqueue(A.id, G, A.rev))).toEqual({ enqueuedAt: T0 });
    expect(await state(B.id)).toBe("queued");
    expect(await state(A.id)).toBe("superseded");
  });

  it("a known current revision supersedes a waiter that is not it, whenever it arrived", async () => {
    // X carries a later `enqueued_at` than B's — arrival order alone would
    // keep X. B names the current revision, so X, not current, is superseded.
    clock = T0 + 10;
    await run(store.enqueue("exec-x", G, "0ld0ld0ld0ld"));
    clock = T0;
    await run(store.enqueue(B.id, G, B.rev, B.rev));
    expect(await state("exec-x")).toBe("superseded");
    expect(await state(B.id)).toBe("queued");
  });

  it("an abbreviated waiter revision still counts as current", async () => {
    // D arrived later with a short SHA of the head; C then enqueues naming the
    // head. Neither rule may supersede D.
    clock = T0 + 10;
    await run(store.enqueue("exec-d", G, B.rev.slice(0, 10)));
    clock = T0;
    await run(store.enqueue(C.id, G, B.rev, B.rev));
    expect(await state("exec-d")).toBe("queued");
  });

  it("groups are independent — another label or branch runs alongside", async () => {
    await run(store.enqueue(A.id, G, A.rev));
    await run(store.attempt(A.id, G, A.rev));
    await run(store.enqueue(B.id, `${G}:containers`, B.rev));
    expect((await run(store.attempt(B.id, `${G}:containers`, B.rev))).kind).toBe("run");
  });

  it("a holder whose heartbeat stales past the TTL stops blocking the group", async () => {
    await run(store.enqueue(A.id, G, A.rev));
    await run(store.attempt(A.id, G, A.rev));
    await run(store.enqueue(B.id, G, B.rev));
    expect((await run(store.attempt(B.id, G, B.rev))).kind).toBe("wait");
    clock += SERIAL_HOLDER_TTL_MS + 1;
    expect((await run(store.attempt(B.id, G, B.rev))).kind).toBe("run");
  });
});

describe("runSerialGate — the poll loop through durable steps", () => {
  let bindings: TestBindings;
  let clock: number;
  let store: SerialQueueStore;

  beforeEach(async () => {
    bindings = await makeTestBindings();
    clock = T0;
    store = makeSerialQueueD1(bindings.db, () => clock);
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  /** A step runner that records step names and runs each body inline. */
  const steps = () => {
    const names: string[] = [];
    const stepDo = <T>(name: string, body: () => Promise<T>) =>
      Effect.promise(() => {
        names.push(name);
        return body();
      });
    return { names, stepDo };
  };

  const failureOf = (exit: Exit.Exit<void, unknown>) =>
    Exit.match(exit, {
      onSuccess: () => undefined,
      onFailure: (cause) => Option.getOrUndefined(Cause.failureOption(cause)),
    });

  it("waits while the group is held, reports the holder once, then runs", async () => {
    await Effect.runPromise(store.enqueue(A.id, G, A.rev));
    await Effect.runPromise(store.attempt(A.id, G, A.rev));
    const { names, stepDo } = steps();
    const reported: Array<string | undefined> = [];
    let sleeps = 0;

    await Effect.runPromise(
      runSerialGate({
        store,
        executionId: B.id,
        group: G,
        revision: B.rev,
        stepDo,
        onWait: (holder) => Effect.sync(() => reported.push(holder)),
        // The holder finishes during B's second sleep.
        sleep: () =>
          Effect.promise(async () => {
            sleeps++;
            clock += 30_000;
            if (sleeps === 2) await Effect.runPromise(store.release(A.id));
          }),
      }),
    );

    expect(sleeps).toBe(2);
    expect(reported).toEqual([A.rev]);
    expect(names).toEqual(["serial-enqueue", "serial-claim-0", "serial-claim-1", "serial-claim-2"]);
  });

  it("fails RunSkipped naming the newer revision when superseded mid-wait", async () => {
    await Effect.runPromise(store.enqueue(A.id, G, A.rev));
    await Effect.runPromise(store.attempt(A.id, G, A.rev));
    const { stepDo } = steps();

    const exit = await Effect.runPromiseExit(
      runSerialGate({
        store,
        executionId: B.id,
        group: G,
        revision: B.rev,
        stepDo,
        sleep: () =>
          Effect.promise(async () => {
            clock += 30_000;
            await Effect.runPromise(store.enqueue(C.id, G, C.rev));
          }),
      }),
    );

    const failure = failureOf(exit);
    expect(failure).toMatchObject({ _tag: "RunSkipped" });
    expect((failure as { reason: string }).reason).toContain(`superseded by ${C.rev.slice(0, 12)}`);
    expect(await store.attempt(A.id, G, A.rev).pipe(Effect.runPromise)).toMatchObject({
      kind: "run",
    });
  });

  it("a late OLDER dispatch skips before the queue; the newer waiter survives and runs", async () => {
    // A deploys; B (the branch head) waits; then the older commit O arrives —
    // a re-requested check suite. O must not supersede B.
    await Effect.runPromise(store.enqueue(A.id, G, A.rev));
    await Effect.runPromise(store.attempt(A.id, G, A.rev));
    clock += 1;
    await Effect.runPromise(store.enqueue(B.id, G, B.rev, B.rev));
    clock += 1;

    const { names, stepDo } = steps();
    const exit = await Effect.runPromiseExit(
      runSerialGate({
        store,
        executionId: "exec-old",
        group: G,
        revision: "0ld0ld0ld0ld0000",
        stepDo,
        current: async () => B.rev,
        sleep: () => Effect.void,
      }),
    );

    const failure = failureOf(exit);
    expect(failure).toMatchObject({ _tag: "RunSkipped" });
    expect((failure as { reason: string }).reason).toContain(`superseded by ${B.rev.slice(0, 12)}`);
    // It never touched the queue.
    expect(names).toEqual(["serial-current"]);
    expect(
      await bindings.db
        .prepare(`SELECT COUNT(*) AS n FROM serial_queue WHERE execution_id = 'exec-old'`)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });

    // B is intact, and runs once A finishes.
    const b = steps();
    await Effect.runPromise(
      runSerialGate({
        store,
        executionId: B.id,
        group: G,
        revision: B.rev,
        stepDo: b.stepDo,
        current: async () => B.rev,
        sleep: () => Effect.promise(() => Effect.runPromise(store.release(A.id))),
      }),
    );
    expect(b.names).toEqual([
      "serial-current",
      "serial-enqueue",
      "serial-claim-0",
      "serial-claim-1",
    ]);
  });

  it("an unknown current revision falls back to arrival order", async () => {
    await Effect.runPromise(store.enqueue(A.id, G, A.rev));
    await Effect.runPromise(store.attempt(A.id, G, A.rev));
    await Effect.runPromise(store.enqueue(B.id, G, B.rev));
    clock += 1;
    const { stepDo } = steps();
    let sleeps = 0;
    const exit = await Effect.runPromiseExit(
      runSerialGate({
        store,
        executionId: C.id,
        group: G,
        revision: C.rev,
        stepDo,
        current: async () => undefined,
        pollEveryMs: 30_000,
        maxWaitMs: 30_000,
        sleep: () => Effect.sync(() => void sleeps++),
      }),
    );
    // C enqueued and superseded B by arrival; C itself waits behind A.
    expect(failureOf(exit)).toMatchObject({ _tag: "SerialQueueTimedOut" });
    expect(await store.attempt(B.id, G, B.rev).pipe(Effect.runPromise)).toMatchObject({
      kind: "superseded",
      by: C.rev,
    });
  });

  it("fails SerialQueueTimedOut once the wait ceiling passes with the holder alive", async () => {
    await Effect.runPromise(store.enqueue(A.id, G, A.rev));
    await Effect.runPromise(store.attempt(A.id, G, A.rev));
    const { names, stepDo } = steps();

    const exit = await Effect.runPromiseExit(
      runSerialGate({
        store,
        executionId: B.id,
        group: G,
        revision: B.rev,
        stepDo,
        pollEveryMs: 30_000,
        maxWaitMs: 90_000,
        sleep: () =>
          Effect.promise(async () => {
            clock += 30_000;
            await Effect.runPromise(store.heartbeat(A.id));
          }),
      }),
    );

    expect(failureOf(exit)).toMatchObject({
      _tag: "SerialQueueTimedOut",
      group: G,
      holderRevision: A.rev,
    });
    // ceil(90s / 30s) + 1 claims — a count, not a clock read.
    expect(names.filter((n) => n.startsWith("serial-claim-"))).toHaveLength(4);
  });
});

describe("decideSerial (pure)", () => {
  it("a claim or a supersession is final even past the ceiling", () => {
    expect(decideSerial({ kind: "run" }, 0, 10_000, 1)).toEqual({ kind: "run" });
    expect(decideSerial({ kind: "superseded", by: "x" }, 0, 10_000, 1)).toEqual({
      kind: "superseded",
      by: "x",
    });
  });

  it("a wait past the ceiling becomes a timeout", () => {
    expect(decideSerial({ kind: "wait", holderRevision: "h" }, 0, 5, 5)).toEqual({
      kind: "timeout",
      holderRevision: "h",
      waitedMs: 5,
    });
    expect(decideSerial({ kind: "wait", holderRevision: "h" }, 0, 4, 5).kind).toBe("wait");
  });
});

describe("revisionMatches (pure)", () => {
  it("matches equal and ≥7-char abbreviated revisions, case-insensitively", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    expect(revisionMatches(head, head)).toBe(true);
    expect(revisionMatches(head, "0123456789AB")).toBe(true);
    expect(revisionMatches(head, "012345")).toBe(false);
    expect(revisionMatches(head, "fedcba9876543210")).toBe(false);
  });
});
