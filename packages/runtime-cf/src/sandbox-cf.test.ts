// Unit coverage for the detached-boot reliability surface of
// `makeSandboxCloudflareLive`: the wait-for-port timeout ceiling (A), log
// capture on a failed boot (B), and the `exposePort` reachable-URL capability
// (C).
//
// The Layer imports `@cloudflare/sandbox` for the live `getSandbox` call, which
// Node + Vitest can't resolve outside a `vitest-pool-workers` environment — so
// we `vi.mock` it to return an in-memory fake `box`. That keeps these tests in
// the plain forks pool (no Miniflare, no container runtime) while exercising the
// Effect-layer behavior the SDK's own `timeout` does not reliably enforce. The
// timeout test uses Effect's `TestClock`, so it is instant rather than waiting
// out a real 120s ceiling.
//
// Spec: specs/03-dsl.md § sandbox.

import { it } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Fiber, Option, TestClock } from "effect";
import { describe, expect, vi } from "vitest";
import { type PortNeverOpened, Sandbox as SandboxTag } from "@fractalboxdev/flare-dispatch-core";

// --- The fake `box` the mocked `getSandbox` hands back -----------------------

/** Build a fake `box` whose process/expose behavior the test controls. */
const makeFakeBox = (opts: {
  proc?: {
    waitForPort?: () => Promise<void>;
    logs?: { stdout: string; stderr: string };
    command?: string;
  } | null;
  exposePort?: (
    port: number,
    options: { hostname: string; name?: string },
  ) => Promise<{ url: string; port: number; name: string | undefined }>;
}) => {
  const getLogs = vi.fn(
    async () => opts.proc?.logs ?? { stdout: "boot stdout", stderr: "boot stderr" },
  );
  const waitForPort = vi.fn(opts.proc?.waitForPort ?? (() => Promise.resolve()));
  const proc =
    opts.proc === null
      ? null
      : {
          id: "proc-1",
          command: opts.proc?.command ?? "pnpm dev",
          waitForPort,
          getLogs,
        };
  return {
    // Default `exec` — tests that exercise the exec path override this.
    exec: vi.fn(async () => ({
      exitCode: 0,
      duration: 0,
      stdout: "",
      stderr: "",
    })),
    getProcess: vi.fn(async () => proc),
    exposePort: vi.fn(
      opts.exposePort ??
        (async (port: number) => ({
          url: `https://${port}-fake.example.com`,
          port,
          name: undefined,
        })),
    ),
    _getLogs: getLogs,
    _waitForPort: waitForPort,
  };
};

// A stand-in for the SDK's `SessionTerminatedError` (thrown when a command's
// shell exits). `vi.hoisted` so it exists before the hoisted `vi.mock` factory
// runs and so the tests can construct instances the Layer will `instanceof`.
const { FakeSessionTerminatedError } = vi.hoisted(() => ({
  FakeSessionTerminatedError: class SessionTerminatedError extends Error {
    readonly exitCode?: number;
    constructor(exitCode?: number) {
      super(`session terminated (exit ${exitCode})`);
      this.name = "SessionTerminatedError";
      this.exitCode = exitCode;
    }
  },
}));

// `getSandbox(ns, id)` is the only thing the Layer pulls from the SDK; the mock
// returns whatever the current test installed via `currentBox`. The error class
// is needed for `execToResult`'s `instanceof` recovery path.
let currentBox: ReturnType<typeof makeFakeBox>;
vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => currentBox,
  SessionTerminatedError: FakeSessionTerminatedError,
}));

// Imported AFTER the mock is registered so the Layer binds the mocked SDK.
const { makeSandboxCloudflareLive, isWorkingDirFailure } = await import("./sandbox-cf");

/** A minimal R2 stub that records `put` calls. */
const makeBucket = () => {
  const puts: { key: string; body: unknown }[] = [];
  const bucket = {
    put: async (key: string, body: unknown) => {
      puts.push({ key, body });
      return {} as R2Object;
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
};

// The Layer only ever passes `ns` to the (mocked) `getSandbox`, so a bare stub
// suffices; the cast satisfies the `DurableObjectNamespace<Sandbox>` parameter.
const ns = {} as Parameters<typeof makeSandboxCloudflareLive>[0];
const handle = { id: "proc-1", container: { id: "exec-1" } };

/** Pull the typed failure value off an Exit, or `undefined` on success. */
const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined;

describe("makeSandboxCloudflareLive — waitForPort timeout (A)", () => {
  it.effect("fails with PortNeverOpened at the ceiling when the SDK wait never resolves", () => {
    // The SDK `waitForPort` never resolves — modelling the ~17-min hang. The
    // Effect-layer ceiling must fail it fast at `timeoutSec`.
    currentBox = makeFakeBox({
      proc: { waitForPort: () => new Promise<void>(() => {}) },
    });
    const { bucket, puts } = makeBucket();
    const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");

    return Effect.gen(function* () {
      const fiber = yield* Effect.flatMap(SandboxTag, (s) =>
        s.waitForPort({ handle, port: 4173, timeoutSec: 120 }),
      ).pipe(Effect.provide(layer), Effect.exit, Effect.fork);

      // Advance virtual time past the 120s ceiling; the wait fails instantly.
      yield* TestClock.adjust(Duration.seconds(121));
      const exit = yield* Fiber.join(fiber);

      const err = failureOf<PortNeverOpened>(exit);
      expect(err?._tag).toBe("PortNeverOpened");
      expect(err?.port).toBe(4173);
      expect(err?.timeoutSec).toBe(120);

      // (B) the detached process's logs were captured to R2 on the failure
      // path, and the logPath is surfaced on the error for diagnosis.
      expect(puts.length).toBe(1);
      expect(err?.logPath).toBe(puts[0]?.key);
    });
  });
});

describe("makeSandboxCloudflareLive — log capture on boot failure (B)", () => {
  it.effect("captures logs and surfaces logPath when the SDK wait rejects", () => {
    // The SDK rejects immediately (not a hang) — still a failed boot; logs
    // must be captured and the logPath surfaced.
    currentBox = makeFakeBox({
      proc: {
        waitForPort: () => Promise.reject(new Error("port closed")),
        logs: { stdout: "starting…", stderr: "EADDRINUSE" },
      },
    });
    const { bucket, puts } = makeBucket();
    const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");

    return Effect.gen(function* () {
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.waitForPort({ handle, port: 4173, timeoutSec: 120 }),
      ).pipe(Effect.provide(layer), Effect.exit);

      const err = failureOf<PortNeverOpened>(exit);
      expect(err?._tag).toBe("PortNeverOpened");
      expect(puts.length).toBe(1);
      expect(err?.logPath).toBe(puts[0]?.key);
      // The NDJSON body carries the detached process's captured stderr.
      expect(String(puts[0]?.body)).toContain("EADDRINUSE");
    });
  });

  it.effect("a log-capture failure does not mask the original PortNeverOpened", () => {
    // The process has vanished by the time we try to capture logs
    // (`getProcess` → null on the second call). The original timeout must
    // still surface — just without a logPath.
    let call = 0;
    currentBox = makeFakeBox({
      proc: {
        waitForPort: () => Promise.reject(new Error("port closed")),
      },
    });
    currentBox.getProcess = vi.fn(async () => {
      call += 1;
      // First call (inside the wait) sees the proc; the capture pass sees
      // none — the process is gone.
      return call === 1
        ? ({
            id: "proc-1",
            command: "pnpm dev",
            waitForPort: () => Promise.reject(new Error("port closed")),
            getLogs: async () => ({ stdout: "", stderr: "" }),
          } as never)
        : null;
    });
    const { bucket, puts } = makeBucket();
    const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");

    return Effect.gen(function* () {
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.waitForPort({ handle, port: 4173, timeoutSec: 120 }),
      ).pipe(Effect.provide(layer), Effect.exit);

      const err = failureOf<PortNeverOpened>(exit);
      expect(err?._tag).toBe("PortNeverOpened");
      expect(err?.logPath).toBeUndefined();
      expect(puts.length).toBe(0);
    });
  });
});

describe("makeSandboxCloudflareLive — exposePort (C)", () => {
  it.effect("returns the SDK preview URL, passing the preview hostname", () => {
    currentBox = makeFakeBox({
      exposePort: async (port, options) => ({
        url: `https://${port}-${options.hostname}/`,
        port,
        name: options.name,
      }),
    });
    const { bucket } = makeBucket();
    const layer = makeSandboxCloudflareLive(
      ns,
      bucket,
      "exec-1",
      undefined,
      "fd.example.workers.dev",
    );

    return Effect.gen(function* () {
      const result = yield* Effect.flatMap(SandboxTag, (s) => s.exposePort({ port: 4173 })).pipe(
        Effect.provide(layer),
      );

      expect(result.url).toBe("https://4173-fd.example.workers.dev/");
      expect(currentBox.exposePort).toHaveBeenCalledWith(4173, {
        hostname: "fd.example.workers.dev",
        name: undefined,
      });
    });
  });

  it.effect("fails with ExposePortFailed when no preview hostname is configured", () => {
    currentBox = makeFakeBox({});
    const { bucket } = makeBucket();
    // No `previewHostname` — the SDK cannot build a URL, so the run fails
    // loudly rather than handing the suite an unreachable localhost.
    const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");

    return Effect.gen(function* () {
      const exit = yield* Effect.flatMap(SandboxTag, (s) => s.exposePort({ port: 4173 })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      const err = failureOf<{ _tag: string }>(exit);
      expect(err?._tag).toBe("ExposePortFailed");
      expect(currentBox.exposePort).not.toHaveBeenCalled();
    });
  });
});

// (D) exec result folding — a command that RAN (any exit code, even one whose
// shell then exited) is a result the run can report + upload artifacts for;
// only a could-not-launch error is an Effect failure. This is what lets a
// failing `playwright-demo` still surface its videoUri/logUri.
describe("makeSandboxCloudflareLive — exec result folding (D)", () => {
  const execLayer = () => makeSandboxCloudflareLive(ns, makeBucket().bucket, "exec-1");

  it.effect("a non-zero exit is a result, not a failure", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => ({
        exitCode: 1,
        duration: 5,
        stdout: "boom",
        stderr: "e",
      }));
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({ command: "playwright test", cwd: "/w", env: {} }),
      ).pipe(Effect.provide(execLayer()), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) expect(exit.value.exitCode).toBe(1);
    }),
  );

  it.effect("SessionTerminatedError folds into a result with its exitCode", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => {
        throw new FakeSessionTerminatedError(7);
      });
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({ command: "run-test; exit 7", cwd: "/w", env: {} }),
      ).pipe(Effect.provide(execLayer()), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) expect(exit.value.exitCode).toBe(7);
    }),
  );

  it.effect("CommandError folds into a result, preserving stdout/stderr", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => {
        const e = new Error("non-zero") as Error & {
          exitCode: number;
          stdout: string;
          stderr: string;
        };
        e.name = "CommandError";
        e.exitCode = 2;
        e.stdout = "out-tail";
        e.stderr = "err-tail";
        throw e;
      });
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({ command: "false", cwd: "/w", env: {} }),
      ).pipe(Effect.provide(execLayer()), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.exitCode).toBe(2);
        expect(exit.value.stdout).toBe("out-tail");
      }
    }),
  );

  it.effect("a genuine launch error still fails as ExecFailed", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => {
        throw new Error("container vanished");
      });
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({ command: "anything", cwd: "/w", env: {} }),
      ).pipe(Effect.provide(execLayer()), Effect.exit);
      const err = failureOf<{ _tag: string; stderrTail?: string; message?: string }>(exit);
      expect(err?._tag).toBe("ExecFailed");
      expect(err?.stderrTail).toBe("container vanished");
      expect(err?.message).toBe("exec failed (exit -1): container vanished");
    }),
  );

  it.effect("ExecFailed.stderrTail prefers stdout/stderr attached to the thrown error", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => {
        const e = new Error("rpc reset") as Error & {
          stdout: string;
          stderr: string;
        };
        e.stdout = "partial out";
        e.stderr = "partial err";
        throw e;
      });
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({ command: "deploy", cwd: "/w", env: {} }),
      ).pipe(Effect.provide(execLayer()), Effect.exit);
      const err = failureOf<{ _tag: string; stderrTail?: string }>(exit);
      expect(err?._tag).toBe("ExecFailed");
      expect(err?.stderrTail).toBe("partial err\npartial out");
    }),
  );

  it.effect("timeout throws surface as ExecTimeout with a self-diagnosing message", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => {
        throw new Error("command timed out after 900000ms");
      });
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({
          command: "pnpm build && wrangler deploy",
          cwd: "/w",
          env: {},
          timeoutSec: 900,
        }),
      ).pipe(Effect.provide(execLayer()), Effect.exit);
      const err = failureOf<{
        _tag: string;
        timeoutSec?: number;
        command?: string;
        message?: string;
      }>(exit);
      expect(err?._tag).toBe("ExecTimeout");
      expect(err?.timeoutSec).toBe(900);
      expect(err?.command).toBe("pnpm build && wrangler deploy");
      expect(err?.message).toBe("exec timed out after 900s: pnpm build && wrangler deploy");
    }),
  );

  it.effect(
    "a missing working dir (checkout reaped between steps) fails as ExecFailed, not a phantom non-zero result",
    () =>
      Effect.gen(function* () {
        currentBox = makeFakeBox({ proc: null });
        // The shell could not `cd` into the (gone) checkout dir: non-zero exit,
        // no stdout, the directory-change error on stderr. Folding this into a
        // result would let `oxlint` / `offload-test` render a never-ran command
        // as a red lint/test verdict — so it must surface as ExecFailed.
        currentBox.exec = vi.fn(async () => ({
          exitCode: 1,
          duration: 0,
          stdout: "",
          stderr: "Failed to change directory to '/workspace/repo'",
        }));
        const exit = yield* Effect.flatMap(SandboxTag, (s) =>
          s.exec({
            command: "npx --yes oxlint@1",
            cwd: "/workspace/repo",
            env: {},
          }),
        ).pipe(Effect.provide(execLayer()), Effect.exit);
        const err = failureOf<{ _tag: string }>(exit);
        expect(err?._tag).toBe("ExecFailed");
      }),
  );

  it("isWorkingDirFailure — fires only on a cwd-set, non-zero, no-stdout, cd-error result", () => {
    const cd = (over: Record<string, unknown> = {}) => ({
      exitCode: 1,
      stdout: "",
      stderr: "Failed to change directory to '/w'",
      ...over,
    });
    expect(isWorkingDirFailure(cd(), "/w")).toBe(true);
    // a real failing command (has stdout) is NEVER misread as an infra failure
    expect(isWorkingDirFailure(cd({ stdout: "boom" }), "/w")).toBe(false);
    // a clean exit is never an infra failure
    expect(isWorkingDirFailure(cd({ exitCode: 0 }), "/w")).toBe(false);
    // no cwd requested → not applicable
    expect(isWorkingDirFailure(cd(), undefined)).toBe(false);
    // unrelated stderr (a genuine lint finding) is left alone
    expect(isWorkingDirFailure({ exitCode: 1, stdout: "", stderr: "1 error" }, "/w")).toBe(false);
  });

  it.effect("inlines only a bounded stdout tail; full log streams to R2", () =>
    Effect.gen(function* () {
      const big = "x".repeat(200_000);
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => ({
        exitCode: 0,
        duration: 1,
        stdout: big,
        stderr: "",
      }));
      const { bucket, puts } = makeBucket();
      const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({ command: "noisy", cwd: "/w", env: {} }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        // Inline preview is bounded (would otherwise bloat the checkpoint).
        expect(exit.value.stdout.length).toBeLessThan(20_000);
        expect(exit.value.stdout).toContain("truncated");
      }
      // The FULL output is still written to R2 (the durable log).
      const logBody = puts.map((p) => String(p.body)).join("");
      expect(logBody.length).toBeGreaterThan(190_000);
    }),
  );

  it.effect("redactValues scrubs secret values from both the R2 log and the inline tail", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => ({
        exitCode: 0,
        duration: 1,
        stdout: "using token super-secret for install",
        stderr: "auth failed: super-secret",
      }));
      const { bucket, puts } = makeBucket();
      const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({
          command: "pnpm install",
          cwd: "/w",
          env: {},
          redactValues: ["super-secret"],
        }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.stdout).not.toContain("super-secret");
        expect(exit.value.stderr).not.toContain("super-secret");
        expect(exit.value.stdout).toContain("***");
      }
      const logBody = puts.map((p) => String(p.body)).join("");
      expect(logBody).not.toContain("super-secret");
    }),
  );
});
