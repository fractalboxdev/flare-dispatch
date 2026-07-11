// Unit tests for composeRestoreOr — the pure cache `restoreOr` orchestration.
//
// Drives composeRestoreOr with fake `restore` / `save` Effects — no container,
// no R2, no Miniflare. Covers the best-effort contract: a hit skips `onMiss`,
// a miss runs `onMiss` then `save`, a restore error degrades to a miss, a
// `save` failure is swallowed, and an `onMiss` failure propagates.

import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { CacheError } from "@fractalboxdev/flare-dispatch-core";
import { composeRestoreOr } from "./cache-restore-or";

const container = { id: "c1" } as const;
const baseOpts = { key: "k", paths: ["node_modules"], container };

describe("composeRestoreOr", () => {
  it("cache hit — onMiss and save are both skipped", async () => {
    let onMissRan = false;
    let saveRan = false;
    const restoreOr = composeRestoreOr(
      () => Effect.succeed(true),
      () =>
        Effect.sync(() => {
          saveRan = true;
        }),
    );
    await Effect.runPromise(
      restoreOr({
        ...baseOpts,
        onMiss: () =>
          Effect.sync(() => {
            onMissRan = true;
          }),
      }),
    );
    expect(onMissRan).toBe(false);
    expect(saveRan).toBe(false);
  });

  it("cache miss — onMiss runs, then save runs", async () => {
    let onMissRan = false;
    let saveRan = false;
    const restoreOr = composeRestoreOr(
      () => Effect.succeed(false),
      () =>
        Effect.sync(() => {
          saveRan = true;
        }),
    );
    await Effect.runPromise(
      restoreOr({
        ...baseOpts,
        onMiss: () =>
          Effect.sync(() => {
            onMissRan = true;
          }),
      }),
    );
    expect(onMissRan).toBe(true);
    expect(saveRan).toBe(true);
  });

  it("a restore error is treated as a miss — onMiss runs", async () => {
    let onMissRan = false;
    const restoreOr = composeRestoreOr(
      () =>
        Effect.fail(
          new CacheError({ phase: "restore", key: "k", cause: "boom" }),
        ),
      () => Effect.void,
    );
    await Effect.runPromise(
      restoreOr({
        ...baseOpts,
        onMiss: () =>
          Effect.sync(() => {
            onMissRan = true;
          }),
      }),
    );
    expect(onMissRan).toBe(true);
  });

  it("a save failure is swallowed — the run still succeeds", async () => {
    const restoreOr = composeRestoreOr(
      () => Effect.succeed(false),
      () =>
        Effect.fail(new CacheError({ phase: "save", key: "k", cause: "boom" })),
    );
    const exit = await Effect.runPromiseExit(
      restoreOr({ ...baseOpts, onMiss: () => Effect.succeed(42) }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("an onMiss failure propagates", async () => {
    const restoreOr = composeRestoreOr(
      () => Effect.succeed(false),
      () => Effect.void,
    );
    const exit = await Effect.runPromiseExit(
      restoreOr({
        ...baseOpts,
        onMiss: () => Effect.fail("install failed" as const),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
