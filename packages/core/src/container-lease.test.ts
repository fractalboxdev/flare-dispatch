// Unit coverage for the pure container-lease decision logic. No I/O, no clock
// read — every transition is exercised by feeding `decideLease` a hand-built
// lease row + a fixed `now`, mirroring `artifact-tar-path.test.ts`. The
// strongly-consistent storage + poll loop that drive these decisions live in
// `@fractalboxdev/flare-dispatch-runtime-cf` and cannot run under plain Node, so the logic is
// isolated here for full coverage.

import { describe, expect, it } from "vitest";
import {
  decideLease,
  isLeaseStale,
  leaseAcquireAttempts,
  type LeaseRecord,
} from "./container-lease";

const TTL = 60_000; // 60s heartbeat staleness ceiling
const lease = (over: Partial<LeaseRecord> = {}): LeaseRecord => ({
  containerId: "demo-acme-repo-abc123def456",
  holder: "playwright-demo:acme_repo:abc123def456",
  acquiredAt: 1_000,
  heartbeatAt: 1_000,
  ...over,
});

describe("decideLease", () => {
  it("acquires when no lease exists", () => {
    expect(decideLease(undefined, "me", 5_000, TTL)).toEqual({
      _kind: "acquire",
    });
  });

  it("reports held (re-entrant) when WE already hold it", () => {
    const mine = lease({ holder: "me" });
    expect(decideLease(mine, "me", 5_000, TTL)).toEqual({ _kind: "held" });
  });

  it("waits when another live execution holds it", () => {
    const other = lease({
      holder: "product-demo:acme_repo:abc123def456",
      acquiredAt: 2_000,
      heartbeatAt: 4_000,
    });
    // now=5_000, heartbeat 4_000 → 1s old, well within the 60s TTL.
    expect(decideLease(other, "me", 5_000, TTL)).toEqual({
      _kind: "wait",
      holder: "product-demo:acme_repo:abc123def456",
      heldForMs: 3_000,
    });
  });

  it("reclaims a lease whose heartbeat has gone stale", () => {
    const dead = lease({ holder: "crashed", heartbeatAt: 1_000 });
    // now far beyond heartbeat + TTL → the holder is presumed dead.
    expect(decideLease(dead, "me", 1_000 + TTL + 1, TTL)).toEqual({
      _kind: "reclaim",
      staleHolder: "crashed",
    });
  });

  it("does NOT reclaim at exactly the TTL boundary (still live)", () => {
    const edge = lease({ holder: "other", heartbeatAt: 1_000 });
    // now - heartbeatAt === TTL exactly → not yet stale (strict `>`), so wait.
    const decision = decideLease(edge, "me", 1_000 + TTL, TTL);
    expect(decision._kind).toBe("wait");
  });

  it("clamps heldForMs to zero when the clock appears to move backwards", () => {
    const other = lease({ holder: "other", acquiredAt: 9_000 });
    const decision = decideLease(other, "me", 5_000, TTL);
    expect(decision).toEqual({ _kind: "wait", holder: "other", heldForMs: 0 });
  });
});

describe("isLeaseStale", () => {
  it("is false within the TTL window", () => {
    expect(isLeaseStale(lease({ heartbeatAt: 1_000 }), 1_000 + TTL, TTL)).toBe(
      false,
    );
  });

  it("is true once the heartbeat predates now - ttl", () => {
    expect(
      isLeaseStale(lease({ heartbeatAt: 1_000 }), 1_000 + TTL + 1, TTL),
    ).toBe(true);
  });
});

describe("leaseAcquireAttempts", () => {
  it("derives one attempt per poll interval up to the ceiling", () => {
    expect(leaseAcquireAttempts(60_000, 5_000)).toBe(12);
  });

  it("rounds a partial final interval up to a whole attempt", () => {
    expect(leaseAcquireAttempts(61_000, 5_000)).toBe(13);
  });

  it("always makes at least one attempt", () => {
    expect(leaseAcquireAttempts(0, 5_000)).toBe(1);
    expect(leaseAcquireAttempts(1_000, 0)).toBeGreaterThanOrEqual(1);
  });
});
