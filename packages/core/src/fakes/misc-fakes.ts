// @fractalboxdev/flare-dispatch-core — Browser / Cache / Config fakes.
//
// `RunContext` is the union of *all* capability services, so `CFRuntimeTest`
// needs a Layer for `Browser`, `Cache`, and `Config` even when the run under
// test only touches some of them. `Cache` and `Config` are intentionally
// minimal (no inspectable state); `Browser` carries an inspectable state
// handle since `cdp-acceptance` (V2) asserts on its `newCDPSession` calls.
//
// Spec: specs/pm/plan.md § 3 (fakes/), specs/03-dsl.md § Layers.

import { Effect, Layer, Option } from "effect";
import { Browser, type BrowserService } from "../services/browser";
import { Cache, type CacheService } from "../services/cache";
import { Config, type ConfigService } from "../services/config";
import { Secrets, type SecretsService } from "../services/secrets";

/** Inspectable record of every Browser fake call. */
export type BrowserFakeState = {
  /** every `newCDPSession` call, in order. */
  readonly cdpSessions: { targetUrl: string }[];
};

/**
 * Build a Browser fake plus an inspectable state handle. `newCDPSession`
 * returns a canned `wsEndpoint`. A test that needs the browser to be
 * *unavailable* builds its own failing `Browser` Layer.
 */
export const makeBrowserFake = (
  opts: { wsEndpoint?: string } = {},
): { layer: Layer.Layer<Browser>; state: BrowserFakeState } => {
  const state: BrowserFakeState = { cdpSessions: [] };
  const service: BrowserService = {
    newCDPSession: ({ targetUrl }) =>
      Effect.sync(() => {
        state.cdpSessions.push({ targetUrl });
        return {
          wsEndpoint: opts.wsEndpoint ?? "wss://fake-cdp.local/session",
          close: Effect.void,
        };
      }),
  };
  return { layer: Layer.succeed(Browser, service), state };
};

/** A ready-to-use Browser fake Layer — a working no-op browser. */
export const BrowserFake: Layer.Layer<Browser> = makeBrowserFake().layer;

/** Cache fake — `restoreOr` always misses (runs `onMiss`), `save` is a no-op. */
export const CacheFake: Layer.Layer<Cache> = Layer.succeed(
  Cache,
  ((): CacheService => ({
    restoreOr: (opts) => Effect.asVoid(opts.onMiss()),
    save: () => Effect.void,
  }))(),
);

/**
 * Build a Config fake from an in-memory key→value store. `get` reads the
 * store; `getJSON` is always `none` (a run that needs JSON config builds its
 * own fake). With no store every key is unset — a run falls back to defaults.
 */
export const makeConfigFake = (store: Record<string, string> = {}): Layer.Layer<Config> =>
  Layer.succeed(Config, {
    get: (key) => Effect.succeed(store[key]),
    getJSON: () => Effect.succeed(Option.none()),
  } satisfies ConfigService);

/** Config fake — every key is unset, so a run falls back to its defaults. */
export const ConfigFake: Layer.Layer<Config> = makeConfigFake();

/**
 * Build a Secrets fake from an in-memory bare-name→value store. Mirrors Worker
 * secrets/vars for `loadSecrets` in unit tests.
 */
export const makeSecretsFake = (store: Record<string, string> = {}): Layer.Layer<Secrets> =>
  Layer.succeed(Secrets, {
    get: (name) => {
      const value = store[name];
      return Effect.succeed(value !== undefined && value !== "" ? value : undefined);
    },
  } satisfies SecretsService);

/** Secrets fake — every name unset. */
export const SecretsFake: Layer.Layer<Secrets> = makeSecretsFake();
