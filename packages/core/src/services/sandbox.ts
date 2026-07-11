// @fractalboxdev/flare-dispatch-core — the `sandbox` capability (container execution).
//
// One Context.Tag service; the `sandbox` namespace below is the accessor
// surface runs and primitives import. Backed by a Layer — real CF Containers
// in prod, local Docker under `wrangler dev`, an in-memory fake in tests.
//
// Spec: specs/03-dsl.md § sandbox.

import { Context, type Duration, Effect } from "effect";
import type {
  CheckoutFailed,
  ContainerBusy,
  ContainerLaunchFailed,
  ExecFailed,
  ExecTimeout,
  ExposePortFailed,
  PortNeverOpened,
  ReadFileFailed,
} from "../errors";

/** A handle to an acquired container; auto-released at run end. */
export type Container = { readonly id: string };

/** A handle to a process started in detached mode. */
export type DetachedHandle = {
  readonly id: string;
  readonly container: Container;
};

/**
 * The result of a command that ran to completion. A non-zero `exitCode` is a
 * normal result (a failing test), surfaced to the run — not an Effect failure.
 */
export type ExecResult = {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly logPath: string; // R2 key for the captured stdout/stderr
  readonly stdout: string; // last N KB inlined; full log streamed to R2
  readonly stderr: string;
};

export type ExecOpts = {
  readonly cwd?: string;
  readonly command: string | readonly string[];
  readonly env?: Record<string, string>;
  readonly timeoutSec?: number;
  readonly container?: Container;
};

/**
 * The result of exposing a container port: a publicly-reachable URL. A process
 * bound to the container's `localhost:<port>` is not reachable from outside the
 * container (e.g. a cloud browser dialling it); `exposePort` returns a public
 * preview URL that routes to it.
 */
export type ExposeResult = {
  readonly url: string;
};

/** The service contract a runtime Layer implements. */
export interface SandboxService {
  /**
   * Acquire the execution's container handle. Beyond the SDK's lazy
   * provisioning, the live layer takes a per-container-id LEASE here: two runs
   * whose ids normalise to the same sandbox id (e.g. `playwright-demo` +
   * `product-demo` for one repo+sha) are serialized so they never execute
   * concurrently in one container and contend (interleaved exec sessions,
   * Browser Rendering pool contention). A run waits for a busy peer up to the
   * layer's ceiling, then fails `ContainerBusy`. In-memory / inline fakes that
   * give each execution its own state take the lease as a no-op.
   */
  readonly acquire: (opts: {
    image?: string;
    memMB?: number;
    vCPU?: number;
  }) => Effect.Effect<Container, ContainerLaunchFailed | ContainerBusy>;
  readonly gitClone: (opts: {
    repo: string;
    sha: string;
    container?: Container;
  }) => Effect.Effect<string, CheckoutFailed>;
  readonly exec: (
    opts: ExecOpts,
  ) => Effect.Effect<ExecResult, ExecFailed | ExecTimeout>;
  /**
   * Read a container file's full text content into the Worker. The companion
   * to `exec` for large outputs: `ExecResult.stdout` inlines only a bounded
   * tail (the rest streams to R2), so a run that needs a command's COMPLETE
   * output writes it to a file and reads it back here — e.g. `pr-review`'s
   * `git diff --output=<file>`.
   */
  readonly readFile: (opts: {
    path: string;
    container?: Container;
  }) => Effect.Effect<string, ReadFileFailed>;
  readonly runDetached: (
    opts: ExecOpts,
  ) => Effect.Effect<DetachedHandle, ContainerLaunchFailed>;
  readonly waitForExit: (opts: {
    handle: DetachedHandle;
    pollEvery?: Duration.Duration;
  }) => Effect.Effect<ExecResult, ExecTimeout>;
  readonly waitForPort: (opts: {
    handle: DetachedHandle;
    port: number;
    timeoutSec?: number;
  }) => Effect.Effect<void, PortNeverOpened>;
  /**
   * Expose a container port and return a publicly-reachable URL routing to it.
   * The app under test binds the container's `localhost:<port>`, which a cloud
   * browser cannot reach; this hands back a public preview URL the browser
   * (and the test suite) can navigate to.
   */
  readonly exposePort: (opts: {
    container?: Container;
    port: number;
    name?: string;
  }) => Effect.Effect<ExposeResult, ExposePortFailed>;
}

/** Context.Tag — the dependency a run carries until a Layer provides it. */
export class Sandbox extends Context.Tag("@fractalboxdev/flare-dispatch-core/Sandbox")<
  Sandbox,
  SandboxService
>() {}

/**
 * The `sandbox` accessor namespace. Each function reads the Sandbox service
 * from context and delegates — so a run writes `sandbox.exec(...)` rather than
 * `Effect.flatMap(Sandbox, (s) => s.exec(...))`.
 */
export const sandbox = {
  acquire: (opts: { image?: string; memMB?: number; vCPU?: number } = {}) =>
    Effect.flatMap(Sandbox, (s) => s.acquire(opts)),
  git: {
    clone: (opts: { repo: string; sha: string; container?: Container }) =>
      Effect.flatMap(Sandbox, (s) => s.gitClone(opts)),
  },
  exec: (opts: ExecOpts) => Effect.flatMap(Sandbox, (s) => s.exec(opts)),
  readFile: (opts: { path: string; container?: Container }) =>
    Effect.flatMap(Sandbox, (s) => s.readFile(opts)),
  runDetached: (opts: ExecOpts) =>
    Effect.flatMap(Sandbox, (s) => s.runDetached(opts)),
  waitForExit: (opts: { handle: DetachedHandle; pollEvery?: Duration.Duration }) =>
    Effect.flatMap(Sandbox, (s) => s.waitForExit(opts)),
  waitForPort: (opts: {
    handle: DetachedHandle;
    port: number;
    timeoutSec?: number;
  }) => Effect.flatMap(Sandbox, (s) => s.waitForPort(opts)),
  exposePort: (opts: { container?: Container; port: number; name?: string }) =>
    Effect.flatMap(Sandbox, (s) => s.exposePort(opts)),
} as const;
