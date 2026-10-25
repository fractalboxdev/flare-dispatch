import { it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { compileCacheCommand } from "@fractalboxdev/flare-dispatch-core/primitives";
import { contextfulCacheWarm, WARM_CHILDREN, WARM_PART } from "./contextful-cache-warm";
import { lightLabelsKey, stageCommand } from "./contextful-gate";

const REPO = "fractalboxdev/contextful";
const SHA = "a".repeat(40);
const BEFORE = "b".repeat(40);
const DIGEST = "c".repeat(64);
const ENDPOINT = "https://dispatch.example/v1/compile-cache";
const TOKEN = "cc1.1700000000.ZXhlYw.mac";
const PUSHED_AT = "2026-10-23T06:00:00Z";
const input = { repo: REPO, sha: SHA, baseSha: BEFORE, revisedAt: Date.parse(PUSHED_AT) } as const;
const prebuilt = {
  key: `contextful-ci-${DIGEST}`,
  base: "/tmp/flare-dispatch-prebuilt/contextful-ci",
  paths: ["bin"],
  path: "/tmp/flare-dispatch-prebuilt/contextful-ci/bin/contextful-ci",
} as const;
const keyed = {
  "cargo tree": {
    stdout: "contextful-ci v0.16.0 (/workspace/contextful/tools/ci)\n",
    exitCode: 0,
  },
  "sha256sum /tmp/flare-dispatch-prebuilt-key.txt": { stdout: `${DIGEST}  /tmp/flare-dispatch-prebuilt-key.txt\n`, exitCode: 0 },
};
const cacheConfig = { "compile-cache.endpoint": ENDPOINT, "compile-cache.token": TOKEN };
const head = { branchHeads: { [`${REPO}:main`]: SHA } };
/** The compile groups a tree with `stages --parts --compile-groups` lists, per tier. */
const PR_GROUPS = ["workspace.compile", "workspace.cli-1", "workspace.cli-formal", "workspace.foundation", "evaluate.cli"];
const NIGHTLY_GROUPS = ["features.binary-all"];
const FOLDS = "suite.cli workspace.cli-formal evaluate.cli\nsuite.foundation workspace.foundation evaluate.foundation\n";
const listing = {
  "--compile-groups --tier pr": { stdout: `${PR_GROUPS.join("\n")}\n`, exitCode: 0 },
  "--compile-groups --tier nightly": { stdout: `${NIGHTLY_GROUPS.join("\n")}\n`, exitCode: 0 },
  "stages --folds": { stdout: FOLDS, exitCode: 0 },
};
/** A part's compile-only command, as a gate part runs it under the cache wrapper. */
const warmed = (part: string) => compileCacheCommand(stageCommand(part, BEFORE, prebuilt, { compileOnly: true }), REPO);
const push = {
  ref: "refs/heads/main",
  before: BEFORE,
  after: SHA,
  head_commit: { timestamp: PUSHED_AT },
  repository: { full_name: REPO, default_branch: "main" },
};

describe("contextful-cache-warm", () => {
  it("triggers once per default-branch head with no opt-in key", () => {
    const trigger = contextfulCacheWarm.triggers?.[0];
    expect(trigger?.event).toBe("push");
    expect(trigger?.gate?.({ payload: push } as never)).toBe(true);
    expect(trigger?.idempotencyKey({ payload: push } as never)).toBe(`contextful-cache-warm:${SHA}`);
    expect(trigger?.inputs({ payload: push } as never)).toEqual(input);
    for (const other of [
      { ...push, ref: "refs/heads/feature" },
      { ...push, ref: "refs/tags/v1.0.0" },
      { ...push, after: "0".repeat(40) },
      { ...push, repository: { full_name: "other/repo", default_branch: "main" } },
      { ...push, ref: "refs/heads/trunk", repository: { full_name: REPO, default_branch: "trunk" } },
    ]) {
      expect(trigger?.gate?.({ payload: other } as never)).toBe(false);
    }
    expect(contextfulCacheWarm.optIn).toBeUndefined();
  });

  it("writes the default branch's lane, and a newer head supersedes an older warm", () => {
    expect(contextfulCacheWarm.compileCache?.(input)).toBe("base");
    expect(contextfulCacheWarm.supersede?.(input)).toEqual({
      group: `contextful-cache-warm:${REPO}:main`,
      order: Date.parse(PUSHED_AT),
    });
    const { revisedAt: _, ...unranked } = input;
    expect(contextfulCacheWarm.supersede?.(unranked)).toEqual({ group: `contextful-cache-warm:${REPO}:main`, order: 0 });
  });

  it.effect("falls back to the gate's compile part, exactly as a gate part runs it, when the tree lists no compile groups", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { ...keyed, "--compile-groups": { exitCode: 2, stderr: "error: unexpected argument '--compile-groups' found\n\nUsage: contextful-ci stages" } },
      config: cacheConfig,
      github: head,
    });
    return Effect.gen(function* () {
      expect(yield* contextfulCacheWarm.run(input)).toEqual({ parts: [{ part: WARM_PART, exitCode: 0 }], unstarted: [] });
      expect(WARM_PART).toBe("workspace.compile");
      const command = compileCacheCommand(stageCommand(WARM_PART, BEFORE, prebuilt), REPO);
      const warm = handles.sandbox.execs.filter((exec) => exec.command === command);
      expect(warm).toHaveLength(1);
      expect(warm[0]?.env).toEqual({ SCCACHE_WEBDAV_ENDPOINT: ENDPOINT, SCCACHE_WEBDAV_TOKEN: TOKEN });
      expect(handles.sandbox.execs.filter((exec) => exec.command.includes("cargo build"))).toHaveLength(1);
      expect(handles.sandbox.clones).toEqual([{ repo: REPO, sha: SHA }]);
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a failed compile without failing: the gate gives the verdict", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: { ...keyed, [`--stage ${WARM_PART}`]: { exitCode: 101 } },
      config: cacheConfig,
      github: head,
    });
    return Effect.gen(function* () {
      expect(yield* contextfulCacheWarm.run(input)).toEqual({ parts: [{ part: WARM_PART, exitCode: 101 }], unstarted: [] });
    }).pipe(Effect.provide(layer));
  });

  it.effect("spreads the compile groups over at most WARM_CHILDREN children of its own run and joins them", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { ...keyed, ...listing },
      config: cacheConfig,
      github: head,
      childRuns: { statuses: Object.fromEntries([0, 1, 2, 3].map((i) => [`contextful-cache-warm:${i}`, i === 2 ? "failure" : "success"])) },
    });
    return Effect.gen(function* () {
      const groups = [...PR_GROUPS, ...NIGHTLY_GROUPS];
      const out = yield* contextfulCacheWarm.run(input);
      expect(WARM_CHILDREN).toBe(4);
      const spawned = handles.childRuns.spawned;
      expect(spawned).toHaveLength(WARM_CHILDREN);
      expect(spawned.every((child) => child.run === "contextful-cache-warm")).toBe(true);
      const chunks = spawned.map((child) => (child.input as { groups: string[] }).groups);
      expect(chunks.flat().sort()).toEqual([...groups].sort());
      expect(chunks[0]).toEqual([groups[0], groups[4]]);
      expect(spawned.map((child) => child.input)).toEqual(chunks.map((parts) => ({ ...input, groups: parts })));
      expect(out).toEqual({ parts: [], unstarted: [], children: chunks.map((parts, i) => ({ parts, status: i === 2 ? "failure" : "success" })) });
      // The parent compiles nothing itself, and gives its container and slot to the children.
      expect(handles.sandbox.execs.filter((exec) => exec.command.includes("--compile-only"))).toHaveLength(0);
      expect(handles.sandbox.execs.filter((exec) => exec.command.includes("gate --predecessors"))).toHaveLength(0);
      expect(handles.sandbox.destroyed).toHaveLength(1);
      expect(handles.childRuns.admissionHandoffs).toBe(1);
      // A child joins no supersession group: the parent's cancels the whole tree.
      expect(contextfulCacheWarm.supersede?.({ ...input, groups: chunks[0]! })).toBeUndefined();
      expect(contextfulCacheWarm.compileCache?.({ ...input, groups: chunks[0]! })).toBe("base");
      expect(contextfulCacheWarm.joinsChildren).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a child compiles each of its groups in order, compile-only, past a failing one", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { ...keyed, ...listing, "--stage workspace.cli-1 ": { exitCode: 101 } },
      config: cacheConfig,
      github: head,
    });
    return Effect.gen(function* () {
      const groups = ["workspace.compile", "workspace.cli-1", "features.binary-all"];
      const out = yield* contextfulCacheWarm.run({ ...input, groups });
      expect(out).toEqual({
        parts: [
          { part: "workspace.compile", exitCode: 0 },
          { part: "workspace.cli-1", exitCode: 101 },
          { part: "features.binary-all", exitCode: 0 },
        ],
        unstarted: [],
      });
      const commands = handles.sandbox.execs.map((exec) => exec.command).filter((command) => command.includes("--compile-only"));
      expect(commands).toEqual(groups.map(warmed));
      for (const exec of handles.sandbox.execs.filter((e) => e.command.includes("--compile-only"))) {
        expect(exec.env).toEqual({ SCCACHE_WEBDAV_ENDPOINT: ENDPOINT, SCCACHE_WEBDAV_TOKEN: TOKEN });
      }
      expect(handles.sandbox.execs.some((exec) => exec.command.includes("--compile-groups"))).toBe(false);
      expect(handles.childRuns.spawned).toHaveLength(0);
      expect(handles.sandbox.clones).toEqual([{ repo: REPO, sha: SHA }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves out the groups the two-tier gate's heavy tier compiles into base on this push", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { ...keyed, ...listing },
      config: { ...cacheConfig, [lightLabelsKey(REPO)]: "pins,suite.cli" },
      github: head,
      childRuns: { statuses: Object.fromEntries([0, 1, 2].map((i) => [`contextful-cache-warm:${i}`, "success"])) },
    });
    return Effect.gen(function* () {
      yield* contextfulCacheWarm.run(input);
      const chunks = handles.childRuns.spawned.map((child) => (child.input as { groups: string[] }).groups);
      // `suite.cli` is light: its members warm. The heavy pull-request parts do not;
      // the nightly groups, which no heavy tier runs, do.
      expect(chunks.flat().sort()).toEqual(["evaluate.cli", "features.binary-all", "workspace.cli-formal"]);
    }).pipe(Effect.provide(layer));
  });

  const skipsBeforeCheckout = (
    name: string,
    opts: Parameters<typeof makeCFRuntimeTest>[0],
    reason: string,
    extra: { groups?: string[] } = {},
  ) =>
    it.effect(name, () => {
      const { layer, handles } = makeCFRuntimeTest({ sandboxProgram: keyed, ...opts });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(contextfulCacheWarm.run({ ...input, ...extra }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("RunSkipped");
          expect(Cause.pretty(exit.cause)).toContain(reason);
        }
        expect(handles.sandbox.clones).toEqual([]);
        expect(handles.sandbox.execs).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

  skipsBeforeCheckout(
    "skips a head the default branch has moved past",
    { config: cacheConfig, github: { branchHeads: { [`${REPO}:main`]: "d".repeat(40) } } },
    "no longer the head of main",
  );
  skipsBeforeCheckout(
    "skips when the default branch's head cannot be read: only a default-branch head writes base",
    { config: cacheConfig },
    "could not be read",
  );
  skipsBeforeCheckout(
    "skips when the deploy injects no compile-cache access",
    { github: head },
    "compile cache not injected",
  );
  skipsBeforeCheckout(
    "a child skips a head the default branch has moved past",
    { config: cacheConfig, github: { branchHeads: { [`${REPO}:main`]: "d".repeat(40) } } },
    "no longer the head of main",
    { groups: ["workspace.compile"] },
  );

  it.effect("skips when the two-tier gate's heavy tier already compiles every group on this push", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: keyed,
      config: { ...cacheConfig, [lightLabelsKey(REPO)]: "pins,formal" },
      github: head,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(contextfulCacheWarm.run(input));
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause).includes("heavy tier")).toBe(true);
      expect(handles.sandbox.execs.filter((exec) => exec.command.includes("gate --predecessors"))).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("warms when the two-tier gate lists the part as light", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: keyed,
      config: { ...cacheConfig, [lightLabelsKey(REPO)]: `pins,${WARM_PART}` },
      github: head,
    });
    return Effect.gen(function* () {
      expect(yield* contextfulCacheWarm.run(input)).toEqual({ parts: [{ part: WARM_PART, exitCode: 0 }], unstarted: [] });
    }).pipe(Effect.provide(layer));
  });
});
