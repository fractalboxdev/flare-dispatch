// @fractalboxdev/flare-dispatch-core — the `secrets` capability.
//
// Read-only Worker secrets / vars by bare name. Credentials for container
// injection (`loadSecrets`) come from here — never from CONFIG_KV. KV holds
// non-secret config only (commands, feature flags, secret *name* allowlists).
//
// Live Layer reads `env.NAME` string bindings on the Dispatcher Worker
// (`wrangler secret put NAME` or wrangler `vars`). Absent / empty → undefined.

import { Context, Effect } from "effect";

export interface SecretsService {
  /** Look up a Worker secret/var by bare name (e.g. `CLOUDFLARE_API_TOKEN`). */
  readonly get: (name: string) => Effect.Effect<string | undefined>;
}

export class Secrets extends Context.Tag("@fractalboxdev/flare-dispatch-core/Secrets")<
  Secrets,
  SecretsService
>() {}

export const secrets = {
  get: (name: string) => Effect.flatMap(Secrets, (s) => s.get(name)),
} as const;
