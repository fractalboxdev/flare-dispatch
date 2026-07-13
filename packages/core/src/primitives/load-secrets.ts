// Primitive: loadSecrets — pull named secrets from `config` into an env record
//
// The "inject secrets into the container" preamble of any run whose command
// needs credentials (a Clerk key, a Cloudflare API token, …). Rather than
// thread secrets through GHA repo secrets and the dispatch body, the operator
// stores them once in the FlareDispatch config store (KV); a run names the
// keys it needs and `loadSecrets` resolves them into the `Record<string,string>`
// that `sandbox.exec({ env })` / `bootApp` expect.
//
// By default a missing key (unset, empty, or an errored config read) is
// omitted from the result and logged at `warn` — graceful degradation suited
// to optional values. Credentials are usually NOT optional: pass
// `required: true` and `loadSecrets` fails with a `SecretsMissing` tagged
// error listing the absent keys, so a misconfigured deploy fails fast and
// legibly instead of booting a container that breaks deep in the run.
//
// IMPORTANT — do not wrap `loadSecrets` in `step(...)`. CF Workflows persist
// every step's return value to durable storage for replay; a checkpointed
// `Record<string,string>` of plaintext credentials would sit in Workflow
// state at rest. Call `loadSecrets` inline in the run body — it reads `config`
// and is cheap + idempotent to re-run on replay.
//
// Rides on the `config` and `io` capabilities. Layer: 03-dsl § Primitives.

import { Effect } from "effect";
import { SecretsMissing } from "../errors";
import { config } from "../services/config";
import { io } from "../services/io";

export const loadSecrets = (
  keys: readonly string[],
  opts: {
    /**
     * Prefix prepended to each `key` to form the config-store key — lets an
     * operator namespace secrets (e.g. `secret/`) apart from feature flags.
     * The returned record is keyed by the bare `key` (the env var name), so
     * `loadSecrets(["CLERK_SECRET_KEY"], { prefix: "secret/" })` reads
     * `secret/CLERK_SECRET_KEY` and yields `{ CLERK_SECRET_KEY: "..." }`.
     */
    prefix?: string;
    /**
     * When `true`, fail with `SecretsMissing` if any named key resolves to no
     * value. Default `false` — missing keys are omitted + warn-logged.
     */
    required?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const prefix = opts.prefix ?? "";
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const key of keys) {
      const value = yield* config.get(`${prefix}${key}`);
      // Unset AND empty-string count as missing — an empty credential is
      // almost always a misconfiguration, not an intentional value.
      if (value === undefined || value === "") {
        missing.push(key);
        yield* io.log(
          "warn",
          `loadSecrets: config key "${prefix}${key}" is unset`,
        );
        continue;
      }
      env[key] = value;
    }
    if (opts.required === true && missing.length > 0) {
      return yield* Effect.fail(new SecretsMissing({ keys: missing }));
    }
    return env;
  });
