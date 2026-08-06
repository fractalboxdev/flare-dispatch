import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import type {
  ExecInput,
  SandboxKey,
  SubstrateFacade,
  SubstrateRecipe,
} from "@fractalboxdev/flare-dispatch-substrate-contract";
import { Cache, Sandbox as SandboxTag } from "@fractalboxdev/flare-dispatch-core";
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

const exec = (command: string, cwd = "/workspace") =>
  Effect.flatMap(SandboxTag, (s) => s.exec({ command, cwd }));

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
    expect(JSON.stringify(exit.cause)).toContain("no detached-process surface");
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
