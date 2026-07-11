// @fractalboxdev/flare-dispatch-runtime-cf — ConfigKvLive: the live `config` capability.
//
// Backs `ConfigService` with a Workers KV namespace. `config.get(key)` is a
// plain KV read; `config.getJSON(key, schema)` reads, JSON-parses, and decodes
// against the caller's Schema. Edits to KV propagate to subsequent executions
// within seconds with no redeploy — the dynamic-config + secret-store the
// `loadSecrets` primitive resolves credentials through.
//
// Graceful degradation is the contract (specs/03-dsl.md § config): an unset
// key is `undefined`, a malformed JSON value or a Schema mismatch is
// `Option.none()`, and a KV read error degrades to the same — never an Effect
// failure. A run that reads config MUST therefore carry a sensible default.
//
// Spec: specs/03-dsl.md § config, specs/pm/plan.md § PR8.

import { Effect, Layer, Option, Schema } from "effect";
import { Config, type ConfigService } from "@fractalboxdev/flare-dispatch-core";

/**
 * Build the live `Config` Layer bound to a KV namespace.
 *
 * @param kv  the `CONFIG_KV` KVNamespace binding.
 * @param overrides  optional per-execution key→value map checked BEFORE KV. The
 *   Worker injects execution-scoped values here (e.g. self-heal's per-execution
 *   model-proxy URL + capability token) that must not live in KV — the run reads
 *   them via `config.get` without the Worker ever exposing the signing key.
 *   specs/08-self-healing.md § 6.3.
 */
export const makeConfigKvLive = (
  kv: KVNamespace,
  overrides?: Readonly<Record<string, string>>,
): Layer.Layer<Config> => {
  const service: ConfigService = {
    get: (key) =>
      overrides !== undefined && key in overrides
        ? Effect.succeed(overrides[key])
        : Effect.tryPromise(() => kv.get(key)).pipe(
            Effect.map((value) => value ?? undefined),
            // A KV read failure degrades to "key unset" — never fails the run.
            Effect.orElseSucceed(() => undefined),
          ),

    getJSON: <A, I>(key: string, schema: Schema.Schema<A, I>) =>
      Effect.tryPromise(() => kv.get(key)).pipe(
        Effect.flatMap((raw) =>
          raw === null
            ? Effect.succeed(Option.none<A>())
            : Effect.try(() => JSON.parse(raw) as unknown).pipe(
                Effect.flatMap((parsed) => Schema.decodeUnknown(schema)(parsed)),
                Effect.map(Option.some),
              ),
        ),
        // Missing key, malformed JSON, Schema mismatch, or a KV error all
        // collapse to `none` — the caller falls back to its default.
        Effect.orElseSucceed(() => Option.none<A>()),
      ),
  };

  return Layer.succeed(Config, service);
};
