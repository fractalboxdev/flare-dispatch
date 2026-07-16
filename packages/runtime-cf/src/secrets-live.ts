// @fractalboxdev/flare-dispatch-runtime-cf — SecretsLive: Worker-env secrets.
//
// Backs the `secrets` capability with a lookup over Dispatcher Worker string
// bindings (secrets + vars). No KV involvement — credentials never ride
// CONFIG_KV.

import { Effect, Layer } from "effect";
import { Secrets, type SecretsService } from "@fractalboxdev/flare-dispatch-core";

/**
 * Build the live `Secrets` Layer.
 *
 * @param lookup  resolve a bare name to a non-empty string, or undefined.
 *   Callers typically read `env[name]` and accept only `typeof === "string"`.
 */
export const makeSecretsLive = (
  lookup: (name: string) => string | undefined,
): Layer.Layer<Secrets> => {
  const service: SecretsService = {
    get: (name) =>
      Effect.sync(() => {
        const value = lookup(name);
        return value !== undefined && value !== "" ? value : undefined;
      }),
  };
  return Layer.succeed(Secrets, service);
};
