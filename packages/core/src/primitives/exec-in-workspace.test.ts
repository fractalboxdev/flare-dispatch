import { it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { describe, expect } from "vitest";
import { ExecFailed } from "../errors";
import { makeSandboxFake } from "../fakes/sandbox-fake";
import { CacheFake } from "../fakes/misc-fakes";
import { IOFake } from "../fakes/io-fake";
import { execInWorkspace } from "./exec-in-workspace";
import { workspace, type Workspace } from "./workspace";

const SPEC = { repo: "owner/repo", sha: "abc123", install: false } as const;

const build = (workspaceLosses: Record<string, number>) =>
  makeSandboxFake({}, {}, {}, workspaceLosses);


describe("execInWorkspace", () => {
  it.effect("re-clones and runs again when the container lost the workspace", () => {
    const { layer, state } = build({ "cargo test": 1 });
    return Effect.gen(function* () {
      const ws = yield* workspace({ ...SPEC });
      expect(state.clones).toHaveLength(1);

      const result = yield* execInWorkspace(ws, { command: "cargo test" });

      expect(result.exitCode).toBe(0);
      // The rebuild is the point: a second clone, into the SAME container.
      expect(state.clones).toHaveLength(2);
      expect(state.clones[1]).toEqual({ repo: SPEC.repo, sha: SPEC.sha });
      expect(state.acquired).toHaveLength(1);
    }).pipe(Effect.provide(Layer.mergeAll(layer, CacheFake, IOFake)));
  });

  it.effect("gives up after one rebuild rather than looping on a dying container", () => {
    const { layer, state } = build({ "cargo test": 5 });
    return Effect.gen(function* () {
      const ws = yield* workspace({ ...SPEC });
      const exit = yield* Effect.exit(execInWorkspace(ws, { command: "cargo test" }));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(state.clones).toHaveLength(2);
    }).pipe(Effect.provide(Layer.mergeAll(layer, CacheFake, IOFake)));
  });

  it.effect("does not re-clone for an ordinary command failure", () => {
    const { layer, state } = makeSandboxFake({
      "cargo test": { fail: "ExecFailed", exitCode: 101, stderrTail: "tests failed" },
    });
    return Effect.gen(function* () {
      const ws = yield* workspace({ ...SPEC });
      const exit = yield* Effect.exit(execInWorkspace(ws, { command: "cargo test" }));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(state.clones).toHaveLength(1);
    }).pipe(Effect.provide(Layer.mergeAll(layer, CacheFake, IOFake)));
  });

  it.effect("a red suite is a result, never a rebuild", () => {
    const { layer, state } = makeSandboxFake({ "cargo test": { exitCode: 1 } });
    return Effect.gen(function* () {
      const ws = yield* workspace({ ...SPEC });
      const result = yield* execInWorkspace(ws, { command: "cargo test" });

      expect(result.exitCode).toBe(1);
      expect(state.clones).toHaveLength(1);
    }).pipe(Effect.provide(Layer.mergeAll(layer, CacheFake, IOFake)));
  });

  it.effect("re-runs the install when the workspace spec asked for one", () => {
    const { layer, state } = build({ "cargo test": 1 });
    return Effect.gen(function* () {
      const ws = yield* workspace({ ...SPEC, install: true });
      const clonesAfterCheckout = state.clones.length;

      yield* execInWorkspace(ws, { command: "cargo test" });

      expect(state.clones).toHaveLength(clonesAfterCheckout + 1);
    }).pipe(Effect.provide(Layer.mergeAll(layer, CacheFake, IOFake)));
  });

  it("carries workspaceMissing on the error the runtime raises", () => {
    const err = new ExecFailed({ exitCode: -1, stderrTail: "gone", workspaceMissing: true });
    expect(err.workspaceMissing).toBe(true);
    expect(new ExecFailed({ exitCode: 1, stderrTail: "x" }).workspaceMissing).toBeUndefined();
  });

  it.effect("threads the command options through to the sandbox", () => {
    const { layer, state } = build({});
    return Effect.gen(function* () {
      const ws: Workspace = yield* workspace({ ...SPEC });
      yield* execInWorkspace(ws, {
        command: "cargo test",
        env: { CI: "1" },
        timeoutSec: 900,
      });

      const exec = state.execs.find((e) => e.command === "cargo test");
      expect(exec?.cwd).toBe(ws.dir);
      expect(exec?.env).toEqual({ CI: "1" });
      expect(exec?.timeoutSec).toBe(900);
    }).pipe(Effect.provide(Layer.mergeAll(layer, CacheFake, IOFake)));
  });
});
