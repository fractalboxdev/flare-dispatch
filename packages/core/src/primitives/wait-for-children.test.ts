import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { ChildStatusRecord } from "../services/child-runs";
import { IOFake, makeChildRunsFake } from "../testing";
import { waitForChildren } from "./wait-for-children";

/** Run `waitForChildren` against a ChildRuns fake + the (no-op-sleep) IO fake. */
const run = (
  opts: Parameters<typeof waitForChildren>[0],
  fakeOpts: Parameters<typeof makeChildRunsFake>[0],
) => {
  const child = makeChildRunsFake(fakeOpts);
  return {
    child,
    exit: Effect.runPromiseExit(
      waitForChildren(opts).pipe(
        Effect.provide(Layer.merge(child.layer, IOFake)),
      ),
    ),
  };
};

describe("waitForChildren", () => {
  it("returns immediately when every child is already terminal", async () => {
    const { child, exit } = run(
      { ids: ["a", "b"] },
      {
        statuses: {
          a: { status: "success", summaryJson: '{"ok":1}' },
          b: "failure",
        },
      },
    );
    const result = await exit;

    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value).toEqual([
        { executionId: "a", status: "success", summaryJson: '{"ok":1}' },
        { executionId: "b", status: "failure" },
      ]);
    }
    // One poll — no sleep loop needed.
    expect(child.state.polls).toBe(1);
  });

  it("polls until pending children settle, then returns their records", async () => {
    // call 0: both running; call 1: a done; call 2: both done.
    const flip = (ids: readonly string[], call: number): readonly ChildStatusRecord[] =>
      ids.map((id) => {
        if (call >= 2) return { executionId: id, status: "success" };
        if (call === 1 && id === "a") return { executionId: id, status: "success" };
        return { executionId: id, status: "running" };
      });

    const { child, exit } = run(
      { ids: ["a", "b"], pollEvery: "10 millis", timeout: "1 minute" },
      { pollFn: flip },
    );
    const result = await exit;

    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value.map((r) => r.status)).toEqual(["success", "success"]);
    }
    // Polled 3 times (calls 0,1,2) before all terminal.
    expect(child.state.polls).toBe(3);
  });

  it("fails ChildWaitTimeout with the still-pending ids when the ceiling elapses", async () => {
    const { exit } = run(
      // timeout/pollEvery = 30ms/10ms → 3 attempts, none terminal.
      { ids: ["a", "b"], pollEvery: "10 millis", timeout: "30 millis" },
      { statuses: { a: "success", b: "running" } },
    );
    const result = await exit;

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const err = result.cause.toString();
      expect(err).toContain("ChildWaitTimeout");
      // Only the never-terminal child is reported pending.
      expect(err).toContain("b");
    }
  });

  it("is a no-op for an empty id list", async () => {
    const { child, exit } = run({ ids: [] }, {});
    const result = await exit;
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) expect(result.value).toEqual([]);
    // Never polled.
    expect(child.state.polls).toBe(0);
  });
});
