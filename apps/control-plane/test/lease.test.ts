// The image a lease names, from the run's catalogue entry and the claiming executor's kind, and the deadline a gate
// run's input carries.
import { CheckInput, lookupRun, type CatalogEntry } from "@fractalboxdev/flare-dispatch-catalog";
import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { gateInputs, imageDigestOf, NO_IMAGE } from "../src/lease.ts";

const entry = (run: string): CatalogEntry => {
  const found = lookupRun("development", run);
  if (found._tag !== "Available") throw new Error(run);
  return found.entry;
};

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("a lease's image digest", () => {
  it("MAMEKO-EXEC-031 names no image for a host execution on a device", () => {
    expect(Effect.runSync(imageDigestOf(entry("check"), "device", undefined))).toBe(NO_IMAGE);
  });

  it("MAMEKO-EXEC-031 names the gate image by digest for a cloud lease", () => {
    expect(Effect.runSync(imageDigestOf(entry("check"), "cloudflare", DIGEST))).toBe(DIGEST);
    expect(Effect.runSync(imageDigestOf(entry("worker-deploy"), "device", DIGEST))).toBe(DIGEST);
  });

  it("MAMEKO-EXEC-031 fails a lease that needs the gate image on a deploy that pins none", () => {
    const exit = Effect.runSyncExit(imageDigestOf(entry("worker-deploy"), "cloudflare", "latest"));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("a lease's input", () => {
  const recorded = {
    repo: "https://github.com/o/r.git",
    sha: "a".repeat(40),
    ref: "refs/heads/main",
    steps: [{ label: "test", command: "pnpm test" }],
  };
  const deadlineAt = Date.UTC(2026, 10, 4, 13);

  it("[FD-GATE-007] carries the execution's deadline_at as a gate run's GateContext.deadlineAt", () => {
    const input = gateInputs(entry("check"), recorded, deadlineAt);
    expect(input).toEqual({ ...recorded, deadlineAt });
    expect(Schema.decodeUnknownSync(CheckInput)(input).deadlineAt).toBe(deadlineAt);
    expect(recorded).not.toHaveProperty("deadlineAt");
  });

  it("leaves an agentic run's input and a run outside the catalogue as recorded", () => {
    const agentic = lookupRun("development", "pr-review");
    if (agentic._tag !== "Available") throw new Error("pr-review");
    const input = { pr: 7 };
    expect(gateInputs(agentic.entry, input, deadlineAt)).toBe(input);
    expect(gateInputs(null, recorded, deadlineAt)).toBe(recorded);
  });
});
