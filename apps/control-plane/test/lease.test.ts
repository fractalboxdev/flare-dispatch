// The image a lease names, from the run's catalogue entry and the claiming executor's kind.
import { lookupRun, type CatalogEntry } from "@fractalboxdev/flare-dispatch-catalog";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { imageDigestOf, NO_IMAGE } from "../src/lease.ts";

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
