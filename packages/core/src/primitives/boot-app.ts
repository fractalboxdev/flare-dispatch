// Primitive: bootApp — start a detached process and wait for its port
//
// The "boot the app under test" preamble of every acceptance-style recipe:
// start a long-running process in a detached container (so the Worker step
// returns immediately) and block until the process is accepting connections.
// `sandbox.runDetached` followed by `sandbox.waitForPort`, as one call.
//
// Rides on the `sandbox` capability. Layer: 03-dsl § Primitives.

import { Effect } from "effect";
import { sandbox, type Container } from "../services/sandbox";

export const bootApp = (opts: {
  container: Container;
  dir: string;
  command: string | readonly string[];
  port: number;
  timeoutSec?: number; // wait-for-port ceiling, default 120
  env?: Record<string, string>; // env for the detached process — e.g. injected secrets
}) =>
  Effect.gen(function* () {
    const handle = yield* sandbox.runDetached({
      cwd: opts.dir,
      container: opts.container,
      command: opts.command,
      env: opts.env,
    });
    yield* sandbox.waitForPort({
      handle,
      port: opts.port,
      timeoutSec: opts.timeoutSec ?? 120,
    });
    return handle;
  });
