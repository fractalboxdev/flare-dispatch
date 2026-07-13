// @fractalboxdev/flare-dispatch-core — the `config` capability (read-only dynamic config).
//
// KV-backed model routing, provider switches, feature flags. Edits propagate
// to subsequent executions within seconds, no redeploy. Every failure mode
// degrades gracefully — an unset key is `undefined`, a malformed JSON value is
// `Option.none()` — so a run that reads config MUST carry a sensible default.
//
// Spec: specs/03-dsl.md § config.

import { Context, Effect, type Option, type Schema } from "effect";

export interface ConfigService {
  readonly get: (key: string) => Effect.Effect<string | undefined>;
  // The schema's encoded type `I` is left free: the stored value is JSON
  // parsed from a string, so it is decoded from `unknown` regardless of `I`.
  readonly getJSON: <A, I>(
    key: string,
    schema: Schema.Schema<A, I>,
  ) => Effect.Effect<Option.Option<A>>;
}

export class Config extends Context.Tag("@fractalboxdev/flare-dispatch-core/Config")<
  Config,
  ConfigService
>() {}

export const config = {
  get: (key: string) => Effect.flatMap(Config, (c) => c.get(key)),
  getJSON: <A, I>(key: string, schema: Schema.Schema<A, I>) =>
    Effect.flatMap(Config, (c) => c.getJSON(key, schema)),
} as const;
