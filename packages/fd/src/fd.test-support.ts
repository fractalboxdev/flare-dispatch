// Runs an `fd-<subcommand>` command the way its executable does, against the dispatcher's router in process: the
// client's `fetch` is the router, the credential store is a map, and stdout and stderr are captured.
import { accessClaims, ORIGIN, type Harness } from "@fractalboxdev/flare-dispatch-api/test-support";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { FdFetch } from "./client.ts";
import type { Subcommand } from "./commands.ts";
import { FdConfig } from "./config.ts";
import { CredentialStore } from "./credentials.ts";
import { LocalScheduler, LocalSchedulerSocket } from "./local-scheduler.ts";
import { BrowserLogin } from "./login.ts";
import { Operability, OperabilityNotInstalled } from "./operability.ts";
import { Output } from "./outcome.ts";
import { runSubcommand } from "./main.ts";

export interface Run {
  readonly exit: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

export interface RunOptions {
  readonly store?: Map<string, string>;
  readonly scheduler?: Layer.Layer<LocalScheduler>;
  readonly schedulerSocket?: string;
  readonly operability?: Layer.Layer<Operability>;
  readonly login?: Layer.Layer<BrowserLogin>;
}

export const memoryStore = (store: Map<string, string>) =>
  Layer.succeed(CredentialStore)({
    get: (account) => Effect.succeed(store.get(account)),
    put: (account, secret) => Effect.sync(() => void store.set(account, secret)),
  });

/** A store holding an unexpired Access token of `email` for the test control plane. */
export const signedIn = async (h: Harness, email: string, extra: Record<string, unknown> = {}) =>
  new Map([[ORIGIN, await h.access.sign(accessClaims(email, extra))]]);

export const runFd = async (
  h: Harness,
  name: Subcommand,
  args: readonly string[],
  options: RunOptions = {},
): Promise<Run> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const config = Layer.succeed(FdConfig)({ url: ORIGIN, schedulerSocket: options.schedulerSocket });
  const layers = Layer.mergeAll(
    memoryStore(options.store ?? new Map()),
    Layer.succeed(Output)({
      stdout: (t) => Effect.sync(() => void stdout.push(t)),
      stderr: (t) => Effect.sync(() => void stderr.push(t)),
    }),
    options.scheduler ?? LocalSchedulerSocket.pipe(Layer.provide(config)),
    options.operability ?? OperabilityNotInstalled,
    options.login ??
      Layer.succeed(BrowserLogin)({ token: () => Effect.die("no login in this test") }),
    config,
    NodeServices.layer,
  );
  const exit = await Effect.runPromise(
    runSubcommand(name, args).pipe(
      Effect.provideService(FdFetch, h.asFetch()),
      Effect.provide(layers),
    ) as Effect.Effect<number>,
  );
  return { exit, stdout, stderr };
};
