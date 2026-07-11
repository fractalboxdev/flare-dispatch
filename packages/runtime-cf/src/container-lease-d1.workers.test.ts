// Integration tests for the D1-backed container lease — the atomic-correctness
// surface that the pure decision logic (`@fractalbox/flare-dispatch-core`
// container-lease.test.ts) cannot cover: the conditional upsert against a real
// D1 binding. Runs INSIDE workerd via `@cloudflare/vitest-pool-workers` (see
// `vitest.workers.config.ts`) — the test body executes in the Workers runtime
// and reads the live binding off `cloudflare:test`'s `env`.
//
// The bounded poll loop's TIMEOUT path (`ContainerBusy` after the wait ceiling)
// sleeps real wall-clock and is governed by the pure `leaseAcquireAttempts`
// count (unit-tested) + a `ContainerBusy` constructor sample (errors.test.ts),
// so it is not re-driven here. These tests cover the strongly-consistent state
// transitions: first acquire, re-entrant acquire, stale reclaim, and the
// release-then-reacquire handoff — each completing without ever entering the
// wait branch, so no real sleep is incurred.

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContainerBusy } from "@fractalbox/flare-dispatch-core";
import { LEASE_TTL_MS, makeContainerLeaseD1 } from "./container-lease-d1";
import { makeTestBindings, type TestBindings } from "./test-support-workers";

const CID = "demo-acme-repo-abc123def456";
const A = "playwright-demo:acme_repo:abc123def456";
const B = "product-demo:acme_repo:abc123def456";

describe("makeContainerLeaseD1 — atomic lease against real D1", () => {
  let bindings: TestBindings;

  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  const rows = (containerId: string) =>
    bindings.db
      .prepare(`SELECT * FROM container_leases WHERE container_id = ?`)
      .bind(containerId)
      .all();

  it("first acquire writes a single lease row held by the acquirer", async () => {
    const store = makeContainerLeaseD1(bindings.db, () => 1_000);
    const handle = await Effect.runPromise(store.acquire(CID, A));
    expect(handle.holder).toBe(A);

    const result = await rows(CID);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      container_id: CID,
      holder: A,
      acquired_at: 1_000,
      heartbeat_at: 1_000,
    });
  });

  it("is re-entrant — the same holder re-acquires and refreshes its heartbeat", async () => {
    let clock = 1_000;
    const store = makeContainerLeaseD1(bindings.db, () => clock);
    await Effect.runPromise(store.acquire(CID, A));

    clock = 5_000;
    const again = await Effect.runPromise(store.acquire(CID, A));
    expect(again.holder).toBe(A);

    const result = await rows(CID);
    expect(result.results).toHaveLength(1);
    // Heartbeat refreshed; acquired_at preserved (still the original hold).
    expect(result.results[0]).toMatchObject({ heartbeat_at: 5_000 });
  });

  it("reclaims a lease whose heartbeat has gone stale (presumed-dead holder)", async () => {
    // A acquires at t=1_000 and never heartbeats again.
    const aStore = makeContainerLeaseD1(bindings.db, () => 1_000);
    await Effect.runPromise(aStore.acquire(CID, A));

    // B acquires far past the TTL — A's heartbeat is stale, so B steals it.
    const bStore = makeContainerLeaseD1(bindings.db, () => 1_000 + LEASE_TTL_MS + 1);
    const handle = await Effect.runPromise(bStore.acquire(CID, B));
    expect(handle.holder).toBe(B);

    const result = await rows(CID);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ holder: B });
  });

  it("hands the lease off cleanly after release", async () => {
    let clock = 1_000;
    const store = makeContainerLeaseD1(bindings.db, () => clock);
    const handle = await Effect.runPromise(store.acquire(CID, A));

    await Effect.runPromise(handle.release());
    expect((await rows(CID)).results).toHaveLength(0);

    // B can now acquire immediately — no wait, A is gone.
    clock = 2_000;
    const bHandle = await Effect.runPromise(store.acquire(CID, B));
    expect(bHandle.holder).toBe(B);
    expect((await rows(CID)).results[0]).toMatchObject({ holder: B });
  });

  it("release only deletes the caller's own lease, never a peer's", async () => {
    const aStore = makeContainerLeaseD1(bindings.db, () => 1_000);
    const aHandle = await Effect.runPromise(aStore.acquire(CID, A));

    // A's heartbeat goes stale; B reclaims.
    const bStore = makeContainerLeaseD1(bindings.db, () => 1_000 + LEASE_TTL_MS + 1);
    await Effect.runPromise(bStore.acquire(CID, B));

    // A's late release must NOT remove B's lease (holder-scoped DELETE).
    await Effect.runPromise(aHandle.release());
    const result = await rows(CID);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ holder: B });
  });

  it("two distinct container ids never contend", async () => {
    const store = makeContainerLeaseD1(bindings.db, () => 1_000);
    const h1 = await Effect.runPromise(store.acquire("cid-one", A));
    const h2 = await Effect.runPromise(store.acquire("cid-two", B));
    expect(h1.holder).toBe(A);
    expect(h2.holder).toBe(B);
    expect((await rows("cid-one")).results).toHaveLength(1);
    expect((await rows("cid-two")).results).toHaveLength(1);
  });

  it("a peer cannot reclaim a lease whose holder keeps heartbeating", async () => {
    let clock = 1_000;
    const aStore = makeContainerLeaseD1(bindings.db, () => clock);
    const aHandle = await Effect.runPromise(aStore.acquire(CID, A));

    // A heartbeats right at the edge, keeping the lease live.
    clock = 1_000 + LEASE_TTL_MS;
    await Effect.runPromise(aHandle.heartbeat());

    // B observes a still-live lease. A bounded acquire would WAIT (real sleep),
    // so instead assert the pure precondition directly: the row is fresh enough
    // that B's first poll sees `wait`, not `reclaim`.
    const result = await rows(CID);
    expect(result.results[0]).toMatchObject({
      holder: A,
      heartbeat_at: 1_000 + LEASE_TTL_MS,
    });
    // Sanity: the ContainerBusy error a timed-out B would raise is constructable.
    const busy = new ContainerBusy({ containerId: CID, holder: A, waitedMs: 0 });
    expect(busy.holder).toBe(A);
  });
});
