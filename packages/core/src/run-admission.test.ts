// Unit coverage for the pure run-admission decision logic. No I/O, no clock
// read — every transition is exercised by feeding `decideAdmission` a
// hand-built observation + a fixed `now`, mirroring `container-lease.test.ts`.
// The strongly-consistent storage + durable-step poll loop that drive these
// decisions live in `@fractalboxdev/flare-dispatch-runtime-cf` / the dispatcher and cannot
// run under plain Node, so the logic is isolated here for full coverage.

import { describe, expect, it } from "vitest";
import {
  admissionAcquireAttempts,
  type AdmissionObservation,
  decideAdmission,
} from "./run-admission";

const MAX_QUEUE_AGE = 1_200_000; // 20 min dispatch-age ceiling
const ENQUEUED_AT = 10_000;

const observed = (
  over: Partial<AdmissionObservation> = {},
): AdmissionObservation => ({
  admitted: false,
  position: 0,
  poolBusy: 16,
  ...over,
});

describe("decideAdmission", () => {
  it("admits when the atomic claim landed (a slot under the cap was free)", () => {
    expect(
      decideAdmission(
        observed({ admitted: true, poolBusy: 3 }),
        ENQUEUED_AT,
        ENQUEUED_AT + 1,
        MAX_QUEUE_AGE,
      ),
    ).toEqual({ _kind: "admit" });
  });

  it("admit wins even at the deadline — a slot taken at the boundary is kept", () => {
    expect(
      decideAdmission(
        observed({ admitted: true }),
        ENQUEUED_AT,
        ENQUEUED_AT + MAX_QUEUE_AGE + 1,
        MAX_QUEUE_AGE,
      ),
    ).toEqual({ _kind: "admit" });
  });

  it("waits when the pool is at the cap, carrying position + busy count", () => {
    expect(
      decideAdmission(
        observed({ position: 3, poolBusy: 16 }),
        ENQUEUED_AT,
        ENQUEUED_AT + 60_000,
        MAX_QUEUE_AGE,
      ),
    ).toEqual({ _kind: "wait", position: 3, poolBusy: 16 });
  });

  it("times out once queued for exactly the dispatch-age ceiling", () => {
    expect(
      decideAdmission(
        observed({ position: 2, poolBusy: 16 }),
        ENQUEUED_AT,
        ENQUEUED_AT + MAX_QUEUE_AGE,
        MAX_QUEUE_AGE,
      ),
    ).toEqual({
      _kind: "timeout",
      queuedForMs: MAX_QUEUE_AGE,
      position: 2,
      poolBusy: 16,
    });
  });

  it("still waits one tick before the ceiling", () => {
    const decision = decideAdmission(
      observed(),
      ENQUEUED_AT,
      ENQUEUED_AT + MAX_QUEUE_AGE - 1,
      MAX_QUEUE_AGE,
    );
    expect(decision._kind).toBe("wait");
  });

  it("clamps queuedForMs to zero when the clock appears to move backwards", () => {
    // A backwards clock must never produce a negative age (nor a spurious
    // timeout with a tiny ceiling) — clamp to 0 and keep waiting.
    const decision = decideAdmission(
      observed(),
      ENQUEUED_AT,
      ENQUEUED_AT - 5_000,
      MAX_QUEUE_AGE,
    );
    expect(decision._kind).toBe("wait");
  });
});

describe("admissionAcquireAttempts", () => {
  it("derives one attempt per poll interval up to the ceiling (defaults: 60)", () => {
    expect(admissionAcquireAttempts(1_200_000, 20_000)).toBe(60);
  });

  it("rounds a partial final interval up to a whole attempt", () => {
    expect(admissionAcquireAttempts(1_210_000, 20_000)).toBe(61);
  });

  it("always makes at least one attempt", () => {
    expect(admissionAcquireAttempts(0, 20_000)).toBe(1);
    expect(admissionAcquireAttempts(1_000, 0)).toBeGreaterThanOrEqual(1);
  });
});
