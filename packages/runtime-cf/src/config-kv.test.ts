// Integration tests for ConfigKvLive — the live `config` capability.
//
// Drives the real KV binding via Miniflare. Asserts `get` reads stored values
// and degrades unset keys to `undefined`, and that `getJSON` decodes against a
// Schema while collapsing every failure mode (unset, malformed JSON, Schema
// mismatch) to `Option.none()`.

import { Effect, Option, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Config } from "@fractalbox/flare-dispatch-core";
import { makeConfigKvLive } from "./config-kv";
import { makeTestBindings, type TestBindings } from "./test-support";

const Flags = Schema.Struct({ beta: Schema.Boolean });

describe("ConfigKvLive", () => {
  let bindings: TestBindings;

  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  /** Run an effect against a live `Config` Layer over the Miniflare KV. */
  const run = <A>(effect: Effect.Effect<A, never, Config>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(Effect.provide(makeConfigKvLive(bindings.kv))),
    );

  it("get returns the stored string value", async () => {
    await bindings.kv.put("model", "claude-opus-4-7");
    const value = await run(Effect.flatMap(Config, (c) => c.get("model")));
    expect(value).toBe("claude-opus-4-7");
  });

  it("get returns undefined for an unset key", async () => {
    const value = await run(Effect.flatMap(Config, (c) => c.get("absent")));
    expect(value).toBeUndefined();
  });

  it("getJSON decodes a stored value against the schema", async () => {
    await bindings.kv.put("flags", JSON.stringify({ beta: true }));
    const value = await run(
      Effect.flatMap(Config, (c) => c.getJSON("flags", Flags)),
    );
    expect(Option.getOrNull(value)).toEqual({ beta: true });
  });

  it("getJSON is none for an unset key", async () => {
    const value = await run(
      Effect.flatMap(Config, (c) => c.getJSON("absent", Flags)),
    );
    expect(Option.isNone(value)).toBe(true);
  });

  it("getJSON is none for malformed JSON", async () => {
    await bindings.kv.put("flags", "{not json");
    const value = await run(
      Effect.flatMap(Config, (c) => c.getJSON("flags", Flags)),
    );
    expect(Option.isNone(value)).toBe(true);
  });

  it("getJSON is none when the value fails schema validation", async () => {
    await bindings.kv.put("flags", JSON.stringify({ beta: "yes" }));
    const value = await run(
      Effect.flatMap(Config, (c) => c.getJSON("flags", Flags)),
    );
    expect(Option.isNone(value)).toBe(true);
  });

  // --- KV-read-error degradation -------------------------------------------
  // A KV binding whose `.get` rejects — exercises the `orElseSucceed` branch
  // both `get` and `getJSON` carry. No Miniflare needed for these.
  const brokenKv = {
    get: () => Promise.reject(new Error("KV unavailable")),
  } as unknown as KVNamespace;

  it("get degrades a KV read error to undefined", async () => {
    const value = await Effect.runPromise(
      Effect.flatMap(Config, (c) => c.get("model")).pipe(
        Effect.provide(makeConfigKvLive(brokenKv)),
      ),
    );
    expect(value).toBeUndefined();
  });

  it("getJSON degrades a KV read error to none", async () => {
    const value = await Effect.runPromise(
      Effect.flatMap(Config, (c) => c.getJSON("flags", Flags)).pipe(
        Effect.provide(makeConfigKvLive(brokenKv)),
      ),
    );
    expect(Option.isNone(value)).toBe(true);
  });

  describe("per-execution overrides (self-heal token injection, §6.3)", () => {
    const runWith = <A>(
      overrides: Record<string, string>,
      effect: Effect.Effect<A, never, Config>,
    ): Promise<A> =>
      Effect.runPromise(
        effect.pipe(Effect.provide(makeConfigKvLive(bindings.kv, overrides))),
      );

    it("an override value wins over KV (KV not consulted)", async () => {
      await bindings.kv.put("self-heal.agent-token", "kv-stale-token");
      const value = await runWith(
        { "self-heal.agent-token": "per-exec-token" },
        Effect.flatMap(Config, (c) => c.get("self-heal.agent-token")),
      );
      expect(value).toBe("per-exec-token");
    });

    it("a non-override key still falls through to KV", async () => {
      await bindings.kv.put("ci-triage.repos", "owner/name");
      const value = await runWith(
        { "self-heal.proxy-url": "https://x/v1/agent/e/inference" },
        Effect.flatMap(Config, (c) => c.get("ci-triage.repos")),
      );
      expect(value).toBe("owner/name");
    });

    it("an override even shadows a KV read error (no KV call)", async () => {
      const value = await Effect.runPromise(
        Effect.flatMap(Config, (c) => c.get("self-heal.proxy-url")).pipe(
          Effect.provide(makeConfigKvLive(brokenKv, { "self-heal.proxy-url": "ok" })),
        ),
      );
      expect(value).toBe("ok");
    });
  });
});
