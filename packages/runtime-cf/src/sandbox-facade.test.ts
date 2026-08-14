import { describe, expect, it } from "vitest";
import { Effect, Exit, Logger } from "effect";
import type {
  ExecInput,
  SandboxKey,
  SubstrateFacade,
  SubstrateRecipe,
} from "@fractalboxdev/flare-dispatch-substrate-contract";
import { Cache, CurrentStep, Sandbox as SandboxTag } from "@fractalboxdev/flare-dispatch-core";
import { CacheOnFacade, makeSandboxFacadeLive, SUBSTRATE_WORKSPACE } from "./sandbox-facade";

const EXECUTION = "01JQZ8Y2A0";
const REPO = "acme/widget";
const SHA = "9f2c1ab8b0c14e3f9a7d5b1c2e4f6a8d0b3c5e7f";

/** An R2 stand-in that records what the layer persisted. */
function bucket() {
  const puts: { key: string; body: string }[] = [];
  return {
    puts,
    binding: {
      put: async (key: string, body: string) => void puts.push({ key, body }),
    } as unknown as R2Bucket,
  };
}

/** A facade fake that records every call and answers from a script. */
function facade(over: Partial<SubstrateFacade> = {}): {
  calls: { ensure: SubstrateRecipe[]; exec: ExecInput[]; abort: SandboxKey[] };
  api: SubstrateFacade;
} {
  const calls = {
    ensure: [] as SubstrateRecipe[],
    exec: [] as ExecInput[],
    abort: [] as SandboxKey[],
  };
  const api: SubstrateFacade = {
    ensureSandbox: async (_key, recipe) => {
      calls.ensure.push(recipe);
      return { ok: true, generation: 1, rebuilt: false };
    },
    execUnderGrant: async (_key, input) => {
      calls.exec.push(input);
      return {
        ok: true,
        receipt: {
          exitCode: 0,
          durationMs: 12,
          deduped: false,
          tail: "all good",
          truncated: false,
        },
        ensured: { generation: 1, rebuilt: false },
        granted: ["registry.npmjs.org"],
        killed: 0,
      };
    },
    readFile: async () => ({ ok: true, content: "diff --git a/x b/x" }),
    denials: async () => [],
    // The layer does not drive detached processes yet (ADR-0012 landed the
    // facade surface; the `sandbox` capability's `runDetached` still runs on
    // the dispatcher's own fleet), so these only exist to satisfy the contract.
    startDetached: async () => ({ ok: true, process: { id: "sub-detached-1", startedAt: 0 } }),
    detachedStatus: async () => ({ ok: true, status: { state: "running" } }),
    stopDetached: async () => ({ ok: true, stopped: true }),
    checkpoint: async () => ({ ok: true }),
    abort: async (key) => {
      calls.abort.push(key);
      return { ok: true, killed: 1 };
    },
    admissionEnqueue: async () => ({ pool: "lean", position: 0, poolBusy: 0, cap: 6 }),
    admissionAttempt: async () => ({ admitted: true, expiresAt: 0 }),
    admissionRelease: async () => {},
    poolStatus: async () => ({ pools: [] }),
    ...over,
  };
  return { calls, api };
}

const layerFor = (api: SubstrateFacade, r2: R2Bucket, over: Record<string, unknown> = {}) =>
  makeSandboxFacadeLive({
    facade: api,
    bucket: r2,
    executionId: EXECUTION,
    run: "offload-test",
    repo: REPO,
    sha: SHA,
    profiles: ["public-repo-read", "js-install"],
    enforcement: "enforce",
    ...over,
  });

const run = <A, E>(
  effect: Effect.Effect<A, E, SandboxTag>,
  api: SubstrateFacade,
  r2: R2Bucket,
  over: Record<string, unknown> = {},
) => Effect.runPromiseExit(Effect.provide(effect, layerFor(api, r2, over)));

/**
 * `run`, plus every log line the effect emitted. `waitForPort` names its reason
 * on a log line and nowhere else — `PortNeverOpened` carries no free-text cause
 * — so the only way to pin that message is to capture what was logged.
 */
const runCapturingLogs = <A, E>(
  effect: Effect.Effect<A, E, SandboxTag>,
  api: SubstrateFacade,
  r2: R2Bucket,
) => {
  const lines: string[] = [];
  const capture = Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ message }) => void lines.push(String(message))),
  );
  return Effect.runPromiseExit(
    Effect.provide(Effect.provide(effect, layerFor(api, r2)), capture),
  ).then((exit) => ({ exit, lines }));
};

const exec = (command: string, cwd = "/workspace") =>
  Effect.flatMap(SandboxTag, (s) => s.exec({ command, cwd }));

/**
 * Run an effect as `step(name, …)` does — the Tag provided around the body.
 * Provided directly rather than through the DSL's `step`, which would drag a
 * `StepRunner` and an `Executions` Layer into a test about one hash.
 */
const inStep = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, CurrentStep, { name });

describe("the recipe is what the substrate derives a grant from", () => {
  it("carries the run's selected profiles, position and pinned sha on every call", async () => {
    const f = facade();
    const r2 = bucket();
    await run(exec("pnpm test"), f.api, r2.binding);

    const recipe = f.calls.exec[0]?.recipe;
    expect(recipe?.repo).toEqual({ owner: "acme", name: "widget", ref: SHA });
    expect(recipe?.profiles).toEqual(["public-repo-read", "js-install"]);
    expect(recipe?.enforcement).toBe("enforce");
    // The command is the one possibly-model-authored value on the path; the
    // repo and the profiles are not derived from it.
    expect(f.calls.exec[0]?.command).toBe("pnpm test");
  });

  it("passes the rollout position straight through — the layer never picks one", async () => {
    const f = facade();
    const r2 = bucket();
    await run(exec("pnpm test"), f.api, r2.binding, { enforcement: "report" });
    expect(f.calls.exec[0]?.recipe.enforcement).toBe("report");
  });

  it("sends declared targets, and omits the field when there are none", async () => {
    const withTargets = facade();
    const r2 = bucket();
    await run(exec("pnpm e2e"), withTargets.api, r2.binding, { targets: ["preview.pages.dev"] });
    expect(withTargets.calls.exec[0]?.recipe.targets).toEqual(["preview.pages.dev"]);

    const without = facade();
    await run(exec("pnpm e2e"), without.api, r2.binding);
    expect(without.calls.exec[0]?.recipe.targets).toBeUndefined();
  });

  it("keys the recipe version to the sha so a new commit is not a stale restore", async () => {
    const a = facade();
    const b = facade();
    const r2 = bucket();
    await run(exec("pnpm test"), a.api, r2.binding);
    await run(exec("pnpm test"), b.api, r2.binding, { sha: `${SHA.slice(0, 39)}0` });
    expect(a.calls.exec[0]?.recipe.version).not.toBe(b.calls.exec[0]?.recipe.version);
  });
});

describe("clone comes from the recipe, never from a command", () => {
  it("ensures and returns the substrate's workspace without sending git", async () => {
    const f = facade();
    const r2 = bucket();
    const exit = await run(
      Effect.flatMap(SandboxTag, (s) => s.gitClone({ repo: REPO, sha: SHA })),
      f.api,
      r2.binding,
    );
    expect(Exit.isSuccess(exit) && exit.value).toBe(SUBSTRATE_WORKSPACE);
    expect(f.calls.ensure).toHaveLength(1);
    expect(f.calls.exec).toEqual([]);
  });

  it("refuses a clone for a repo this execution is not pinned to", async () => {
    // The recipe is frozen from the dispatch; a run body asking for a different
    // repository is asking the substrate to police a repo nobody reviewed.
    const f = facade();
    const r2 = bucket();
    const exit = await run(
      Effect.flatMap(SandboxTag, (s) => s.gitClone({ repo: "attacker/evil", sha: SHA })),
      f.api,
      r2.binding,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(f.calls.ensure).toEqual([]);
  });
});

describe("idempotency", () => {
  it("gives a retried command the same key, so the substrate joins rather than re-runs", async () => {
    const f = facade();
    const r2 = bucket();
    await run(exec("wrangler deploy"), f.api, r2.binding);
    await run(exec("wrangler deploy"), f.api, r2.binding);
    expect(f.calls.exec[0]?.idempotencyKey).toBe(f.calls.exec[1]?.idempotencyKey);
  });

  it("distinguishes commands and working directories", async () => {
    const f = facade();
    const r2 = bucket();
    await run(exec("pnpm test"), f.api, r2.binding);
    await run(exec("pnpm build"), f.api, r2.binding);
    await run(exec("pnpm test", "/workspace/pkg"), f.api, r2.binding);
    const keys = new Set(f.calls.exec.map((e) => e.idempotencyKey));
    expect(keys.size).toBe(3);
  });

  it("distinguishes two STEPS running the identical command", async () => {
    // The defect this closes: without the step scope both stages of a staged
    // suite hash to one key, the substrate answers the second from the first's
    // receipt, and the command never runs. Same command, same cwd, different
    // step — three distinct units of work, three distinct keys.
    const f = facade();
    const r2 = bucket();
    await run(inStep("exec-workspace", exec("pnpm test")), f.api, r2.binding);
    await run(inStep("exec-features", exec("pnpm test")), f.api, r2.binding);
    await run(exec("pnpm test"), f.api, r2.binding);
    const keys = new Set(f.calls.exec.map((e) => e.idempotencyKey));
    expect(keys.size).toBe(3);
  });

  it("gives a retried step the same key — the scope is the step, not the attempt", async () => {
    // A step name is stable across CF's retries of that step, so a retry still
    // joins its own receipt rather than re-running a `wrangler deploy`.
    const f = facade();
    const r2 = bucket();
    await run(inStep("deploy", exec("wrangler deploy")), f.api, r2.binding);
    await run(inStep("deploy", exec("wrangler deploy")), f.api, r2.binding);
    expect(f.calls.exec[0]?.idempotencyKey).toBe(f.calls.exec[1]?.idempotencyKey);
  });

  it("logs under the step-scoped key, so two stages never share an artifact path", async () => {
    const f = facade();
    const r2 = bucket();
    await run(inStep("exec-a", exec("pnpm test")), f.api, r2.binding);
    await run(inStep("exec-b", exec("pnpm test")), f.api, r2.binding);
    expect(f.calls.exec[0]?.logPath).not.toBe(f.calls.exec[1]?.logPath);
  });
});

describe("approval attestations (ADR-0007)", () => {
  it("attaches only what the run's definition minted", async () => {
    const f = facade();
    const r2 = bucket();
    await run(exec("wrangler deploy"), f.api, r2.binding, {
      approvalFor: async (command: string, scope: { taskId: string; ordinal: number }) => ({
        taskId: scope.taskId,
        ordinal: scope.ordinal,
        commandSha256: "abc",
        approvedBy: "run-definition",
        approvedAt: 1,
      }),
    });
    expect(f.calls.exec[0]?.approval?.approvedBy).toBe("run-definition");
    expect(f.calls.exec[0]?.approval?.taskId).toBe(EXECUTION);
  });

  it("omits the field entirely when the definition vouches for nothing", async () => {
    const f = facade();
    const r2 = bucket();
    await run(exec("wrangler deploy"), f.api, r2.binding, { approvalFor: async () => undefined });
    expect(f.calls.exec[0]).not.toHaveProperty("approval");
  });
});

describe("refusals become typed failures, never opaque throws", () => {
  it("renders an admission refusal as ContainerBusy — an infra wait, not a red verdict", async () => {
    const f = facade({
      ensureSandbox: async () => ({
        ok: false,
        refusal: { kind: "admission-refused", pool: "lean", poolBusy: 6, cap: 6, queuedForMs: 900 },
      }),
    });
    const r2 = bucket();
    const exit = await run(
      Effect.flatMap(SandboxTag, (s) => s.acquire({})),
      f.api,
      r2.binding,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    expect(JSON.stringify(exit.cause)).toContain("ContainerBusy");
  });

  it("renders an approval refusal with the rule that matched", async () => {
    const f = facade({
      execUnderGrant: async () => ({
        ok: false,
        refusal: { kind: "approval-required", rule: "git push" },
      }),
    });
    const r2 = bucket();
    const exit = await run(exec("git push"), f.api, r2.binding);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    expect(JSON.stringify(exit.cause)).toContain("does not pre-assert");
  });
});

describe("logs", () => {
  it("writes the returned tail to the dispatcher's R2 log key", async () => {
    const f = facade();
    const r2 = bucket();
    const exit = await run(exec("pnpm test"), f.api, r2.binding);

    expect(r2.puts[0]?.key).toBe(`logs/${EXECUTION}/exec.ndjson`);
    expect(r2.puts[0]?.body).toContain("all good");
    // The run's `logPath` still resolves against the dispatcher's bucket, so
    // artifact.upload (R2-source mode) and the log viewer are unchanged.
    expect(Exit.isSuccess(exit) && exit.value.logPath).toBe(`logs/${EXECUTION}/exec.ndjson`);
  });

  it("scrubs injected secret values before anything is persisted", async () => {
    const f = facade({
      execUnderGrant: async () => ({
        ok: true,
        receipt: {
          exitCode: 0,
          durationMs: 1,
          deduped: false,
          tail: "using token cf-tok-secret",
          truncated: false,
        },
        ensured: { generation: 1, rebuilt: false },
        granted: [],
        killed: 0,
      }),
    });
    const r2 = bucket();
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(SandboxTag, (s) =>
          s.exec({ command: "wrangler deploy", redactValues: ["cf-tok-secret"] }),
        ),
        layerFor(f.api, r2.binding),
      ),
    );
    expect(r2.puts[0]?.body).not.toContain("cf-tok-secret");
    expect(Exit.isSuccess(exit) && exit.value.stdout).toContain("***");
  });

  it("scrubs them from a structured substrate refusal too", async () => {
    const f = facade({
      execUnderGrant: async () => {
        throw {
          kind: "attestation-rejected",
          reason: "bad attestation for token cf-tok-secret",
        };
      },
    });
    const r2 = bucket();
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(SandboxTag, (s) =>
          s.exec({ command: "wrangler deploy", redactValues: ["cf-tok-secret"] }),
        ),
        layerFor(f.api, r2.binding),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const rendered = JSON.stringify(exit);
    expect(rendered).toContain("attestation");
    expect(rendered).not.toContain("cf-tok-secret");
    expect(rendered).toContain("***");
  });

  it("scrubs them from a thrown error's diagnostic as well", async () => {
    const f = facade({
      execUnderGrant: async () => {
        throw new Error("deploy failed: token cf-tok-secret rejected");
      },
    });
    const r2 = bucket();
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(SandboxTag, (s) =>
          s.exec({ command: "wrangler deploy", redactValues: ["cf-tok-secret"] }),
        ),
        layerFor(f.api, r2.binding),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const rendered = JSON.stringify(exit);
    expect(rendered).not.toContain("cf-tok-secret");
    expect(rendered).toContain("***");
  });
});

describe("the surfaces the facade does not serve", () => {
  it("fails detached execution with a reason a reader can act on", async () => {
    const f = facade();
    const r2 = bucket();
    const exit = await run(
      Effect.flatMap(SandboxTag, (s) => s.runDetached({ command: "pnpm dev" })),
      f.api,
      r2.binding,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    // Asserted on what a reader can DO with the message, not on one phrase.
    // The old assertion pinned "no detached-process surface", which stopped
    // being true when the facade grew `startDetached` (ADR-0012) — a test that
    // holds a stale explanation in place is worse than no test, because the
    // explanation is the whole product here.
    const cause = JSON.stringify(exit.cause);
    // Where the block is recorded, so the reader can find and clear it.
    expect(cause).toContain("grant-catalog.ts");
    // And that the facade half already exists, so nobody goes and builds it.
    expect(cause).toContain("startDetached");
  });

  // `waitForExit`'s reason changed with `runDetached`'s and was the one of the
  // three carrying a DIFFERENT claim — not "a gap", but "no such method, on
  // purpose". Pinned for the same reason the one above is: the message is the
  // whole product, so an untested one is free to go stale again.
  it("fails waitForExit by pointing at the poll that replaces it", async () => {
    const f = facade();
    const r2 = bucket();
    const exit = await run(
      Effect.flatMap(SandboxTag, (s) =>
        s.waitForExit({ handle: { id: "proc-1", container: { id: EXECUTION } } }),
      ),
      f.api,
      r2.binding,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    const cause = JSON.stringify(exit.cause);
    // What to do instead — the facade serves this, so the reader has a route.
    expect(cause).toContain("detachedStatus");
    // Why it is absent by design, rather than merely unbuilt.
    expect(cause).toContain("ADR-0012");
  });

  // The third rewritten message, and the most fragile: it exists ONLY on a log
  // line, so nothing about the failure value would catch it going stale.
  it("names waitForPort's replacement on the log line, not just a bare timeout", async () => {
    const f = facade();
    const r2 = bucket();
    const { exit, lines } = await runCapturingLogs(
      Effect.flatMap(SandboxTag, (s) =>
        s.waitForPort({ handle: { id: "proc-1", container: { id: EXECUTION } }, port: 4173 }),
      ),
      f.api,
      r2.binding,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const logged = lines.join("\n");
    // The port, so the reader knows which wait died.
    expect(logged).toContain("4173");
    // And where the replacement is recorded, rather than a bare timeout to chase.
    expect(logged).toContain("grant-catalog.ts");
  });

  it("fails exposePort rather than handing back an unreachable localhost", async () => {
    const f = facade();
    const r2 = bucket();
    const exit = await run(
      Effect.flatMap(SandboxTag, (s) => s.exposePort({ port: 4173 })),
      f.api,
      r2.binding,
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("CacheOnFacade", () => {
  it("runs onMiss and never claims a hit", async () => {
    let ran = 0;
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Cache, (c) =>
          c.restoreOr({
            key: "deps-abc",
            paths: ["node_modules"],
            container: { id: EXECUTION },
            onMiss: () => Effect.sync(() => void (ran += 1)),
          }),
        ),
        CacheOnFacade,
      ),
    );
    expect(ran).toBe(1);
  });

  it("skips save without failing the run", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(Cache, (c) =>
          c.save({ key: "deps-abc", paths: ["node_modules"], container: { id: EXECUTION } }),
        ),
        CacheOnFacade,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
