// Unit coverage for the container-stop record.
//
// A run whose container dies reports `exec failed (exit -1): internal error`
// and nothing about the container. The platform does say why, one layer down:
// `@cloudflare/containers` parses the runtime's own `runtime signalled the
// container to exit: <n>` into the `exitCode` it hands `onStop`. These pin that
// the number is kept, and that keeping it cannot make a stop worse.

import { describe, expect, it, vi } from "vitest";

import {
  containerStopKey,
  containerStopRecord,
  isStopWorthRecording,
  recordContainerStop,
  stopRecordsEnabled,
  takeRequested,
} from "./container-stop";

/** An R2 stub that records `put` calls. */
const makeBucket = () => {
  const puts: { key: string; body: unknown }[] = [];
  const bucket = {
    put: async (key: string, body: unknown) => {
      puts.push({ key, body });
      return {} as R2Object;
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
};

describe("containerStopRecord", () => {
  it("preserves whatever exit code the platform reported", () => {
    // Preserved, NOT interpreted. The code is evidence to read alongside the
    // rest, not a discriminator — see the module header on why a 0 does not
    // mean a clean exit.
    const rec = containerStopRecord("offload-test-abc", { exitCode: 137, reason: "exit" }, 0, false);
    expect(rec.exitCode).toBe(137);
    expect(rec.sandbox).toBe("offload-test-abc");
  });

  it("keeps a zero rather than dropping the field, since a zero is not nothing", () => {
    expect(containerStopRecord("s", { exitCode: 0, reason: "exit" }, 0, false).exitCode).toBe(0);
  });

  it("distinguishes 'the platform said nothing' from 'we did not look'", () => {
    // `null`, not absent — the two must not render the same way to whoever
    // reads these records next.
    const rec = containerStopRecord("s", undefined, 0, false);
    expect(rec.exitCode).toBeNull();
    expect(rec.reason).toBeNull();
    expect(rec.observedAt).toBe(new Date(0).toISOString());
  });

  it("keys one object per stop, under the sandbox that stopped", () => {
    expect(containerStopKey("offload-test-abc", 1_700_000_000)).toBe(
      "container-stops/offload-test-abc/1700000000.json",
    );
  });

  it("cannot be talked into writing outside its own prefix", () => {
    // The name is derived from an execution id today and carries no separators,
    // but the function takes any string, and a `/` would silently nest objects
    // somewhere nobody looks for them.
    expect(containerStopKey("../../artifacts/evil", 1)).toBe(
      "container-stops/.._.._artifacts_evil/1.json",
    );
  });
});

describe("what is worth an object", () => {
  it("stores the stops nobody asked for, and not our own teardowns", () => {
    // NOT keyed on the exit code. `syncPendingStoppedEvents` hardcodes
    // `exitCode: 0` when the container is gone but the state still reads
    // healthy — the unexplained death — so a code-based filter would drop
    // exactly the records this feature exists to produce.
    expect(isStopWorthRecording(true)).toBe(false);
    expect(isStopWorthRecording(false)).toBe(true);
  });

  it("consumes the destroy intent, so it cannot swallow a later real death", () => {
    // `destroy()` does not reach `onStop` inline; the alarm loop delivers it
    // later, so the intent has to cross that gap. Left set, the next stop this
    // instance saw would also read as requested and be dropped — including a
    // genuine death after a `destroy()` that threw.
    const holder = { requested: false };
    holder.requested = true;
    expect(takeRequested(holder)).toBe(true);
    expect(takeRequested(holder)).toBe(false);
  });

  it("reports an unrequested stop when the intent never got set", () => {
    // The eviction case: a fresh instance sees the stop, so our own teardown
    // reads as unrequested. It records more, never less — which is the safe
    // direction for a corpus about deaths.
    expect(takeRequested({ requested: false })).toBe(false);
  });

  it("is switchable from config, because the deploy that carries it rebuilds images", () => {
    expect(stopRecordsEnabled("off")).toBe(false);
    expect(stopRecordsEnabled(undefined)).toBe(true);
    expect(stopRecordsEnabled("on")).toBe(true);
  });
});

describe("recordContainerStop", () => {
  it("persists the record and logs it", async () => {
    const { bucket, puts } = makeBucket();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordContainerStop(bucket, "offload-test-abc", { exitCode: 137 }, 1_700_000_000, false);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.key).toBe("container-stops/offload-test-abc/1700000000.json");
    expect(JSON.parse(String(puts[0]?.body)).exitCode).toBe(137);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("never lets a failed write turn into a failed stop", async () => {
    // This runs while the container is going away. Throwing would replace a
    // stop we can explain with one we cannot.
    const bucket = {
      put: async () => {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2Bucket;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(recordContainerStop(bucket, "s", { exitCode: 137 }, 1, false)).resolves.toBeUndefined();
    // …but it says so. A silent no-op here is indistinguishable from a deploy
    // where the record never worked at all.
    expect(warn).toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });
});
