// Primitive: loadSecrets — pull named secrets from the `secrets` capability
// into an env record.
//
// The "inject credentials into the container" preamble of any run whose
// command needs them (a Clerk key, a Cloudflare API token, …). Values come
// from Worker secrets/vars (`wrangler secret put`), never CONFIG_KV and never
// the dispatch body. A run names the keys it needs; `loadSecrets` resolves
// them into the `Record<string,string>` that `sandbox.exec({ env })` /
// `bootApp` expect.
//
// By default a missing key (unset or empty) is omitted from the result and
// logged at `warn` — graceful degradation suited to optional values.
// Credentials are usually NOT optional: pass `required: true` and
// `loadSecrets` fails with a `SecretsMissing` tagged error listing the absent
// keys, so a misconfigured deploy fails fast and legibly instead of booting a
// container that breaks deep in the run.
//
// IMPORTANT — do not wrap `loadSecrets` in `step(...)`. CF Workflows persist
// every step's return value to durable storage for replay; a checkpointed
// `Record<string,string>` of plaintext credentials would sit in Workflow
// state at rest. Call `loadSecrets` inline in the run body — it reads
// `secrets` and is cheap + idempotent to re-run on replay.
//
// DEPRECATED by the substrate's credential boundary (ADR-0006). Everything this
// primitive produces ends up in `sandbox.exec({ env })`, and an env var is a
// long-lived credential reachable from inside the container — readable by any
// `postinstall`, `build.rs` or `conftest.py` the workload runs, and kept out of
// the *log* by `redactValues` but not out of the *process*. The two replacement
// shapes both keep the value Worker-side: worker-side writeback (the container
// produces an artifact, the Worker performs the authenticated write), or a
// grant profile whose credential the substrate's egress handler attaches to the
// outbound request (`apps/substrate/src/engine/credentials.ts`). Call sites are
// migrated run by run; this primitive goes away with the `secrets` run input at
// the substrate's stage-2 exit. Details:
// apps/substrate/specs/credential-boundary.md.
//
// Rides on the `secrets` and `io` capabilities. Layer: 03-dsl § Primitives.

import { Effect } from "effect";
import { SecretsMissing } from "../errors";
import { io } from "../services/io";
import { secrets } from "../services/secrets";

export const loadSecrets = (
  keys: readonly string[],
  opts: {
    /**
     * @deprecated Ignored. Secrets are Worker bindings by bare name; KV
     * prefixes (`secret/`, `product-demo.secret/`) no longer apply. Kept so
     * existing call sites / inputs compile without churn.
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
    // prefix intentionally unused — see opts.prefix deprecation.
    void opts.prefix;
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const key of keys) {
      const value = yield* secrets.get(key);
      // Unset AND empty-string count as missing — an empty credential is
      // almost always a misconfiguration, not an intentional value.
      if (value === undefined || value === "") {
        missing.push(key);
        yield* io.log("warn", `loadSecrets: Worker secret "${key}" is unset`);
        continue;
      }
      env[key] = value;
    }
    if (opts.required === true && missing.length > 0) {
      return yield* Effect.fail(new SecretsMissing({ keys: missing }));
    }
    return env;
  });
