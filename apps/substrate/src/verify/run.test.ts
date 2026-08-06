import { describe, expect, it } from "vitest";
import { DENIED_STATUS } from "./probe";
import {
  CANARY_KEY,
  DOGFOOD_KEY,
  DOGFOOD_MARKER,
  isDeferred,
  runCanary,
  runDogfood,
  type ProbeFacade,
} from "./run";
import type {
  AbortOutcome,
  CheckpointOutcome,
  EnsureOutcome,
  ExecInput,
  ExecOutcome,
  SubstrateRecipe,
} from "@fractalboxdev/flare-dispatch-substrate-contract";

type Recorded = { method: string; key: string; input?: ExecInput };

const receipt = (tail: string, over: Partial<ExecOutcome & { ok: true }> = {}) =>
  ({
    ok: true,
    receipt: { exitCode: 0, durationMs: 1, deduped: false, tail, truncated: false },
    ensured: { generation: 1, rebuilt: true },
    granted: ["github.com"],
    killed: 0,
    ...over,
  }) as ExecOutcome;

function fake(
  handlers: {
    ensure?: (recipe: SubstrateRecipe) => EnsureOutcome;
    exec?: (input: ExecInput, nth: number) => ExecOutcome;
    checkpoint?: () => CheckpointOutcome;
  } = {},
): ProbeFacade & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  let execs = 0;
  return {
    calls,
    async ensureSandbox(key, recipe): Promise<EnsureOutcome> {
      calls.push({ method: "ensureSandbox", key });
      return handlers.ensure?.(recipe) ?? { ok: true, generation: 1, rebuilt: true };
    },
    async execUnderGrant(key, input): Promise<ExecOutcome> {
      calls.push({ method: "execUnderGrant", key, input });
      execs += 1;
      return handlers.exec?.(input, execs) ?? receipt("");
    },
    async checkpoint(key): Promise<CheckpointOutcome> {
      calls.push({ method: "checkpoint", key });
      return handlers.checkpoint?.() ?? { ok: true };
    },
    async abort(key): Promise<AbortOutcome> {
      calls.push({ method: "abort", key });
      return { ok: true, killed: 0 };
    },
  };
}

const probeLine = (code: number) => `PROBE|http://example.com/|${code}||`;

describe("runCanary", () => {
  it("runs with no repo, so the container stays in the posture the class ships with", () => {
    // A grant would admit hosts and map handlers — the canary exists to test
    // the state *below* any grant, which is what a repo-less recipe produces.
    const facade = fake({ exec: () => receipt(probeLine(DENIED_STATUS)) });
    return runCanary(facade, { host: "example.com", idempotencyKey: "k" }).then(() => {
      const exec = facade.calls.find((c) => c.method === "execUnderGrant");
      expect(exec?.key).toBe(CANARY_KEY);
      expect(exec?.input?.recipe.repo).toBeUndefined();
    });
  });

  it("reports the probe verdict", async () => {
    const run = await runCanary(fake({ exec: () => receipt(probeLine(DENIED_STATUS)) }), {
      host: "example.com",
      idempotencyKey: "k",
    });
    expect(isDeferred(run)).toBe(false);
    expect(isDeferred(run) ? undefined : run.status).toBe("passed");
  });

  it("defers on a full pool instead of recording a verdict about the floor", async () => {
    const run = await runCanary(
      fake({
        exec: () => ({
          ok: false,
          refusal: { kind: "admission-refused", pool: "lean", poolBusy: 6, cap: 6 },
        }),
      }),
      { host: "example.com", idempotencyKey: "k" },
    );
    expect(isDeferred(run)).toBe(true);
  });

  it("calls a boot refusal inconclusive, never a breach", async () => {
    const run = await runCanary(
      fake({
        exec: () => ({ ok: false, refusal: { kind: "ticket-rejected", reason: "expired" } }),
      }),
      { host: "example.com", idempotencyKey: "k" },
    );
    expect(isDeferred(run) ? undefined : run.status).toBe("inconclusive");
  });

  it("frees the container even when the exec throws", async () => {
    const facade = fake();
    facade.execUnderGrant = async () => {
      throw new Error("container gone");
    };
    await expect(runCanary(facade, { host: "example.com", idempotencyKey: "k" })).rejects.toThrow(
      "container gone",
    );
    expect(facade.calls.some((c) => c.method === "abort" && c.key === CANARY_KEY)).toBe(true);
  });
});

const cloneRecipe: SubstrateRecipe = {
  version: 1,
  repo: { owner: "octocat", name: "Hello-World" },
};

describe("runDogfood", () => {
  const happy = () =>
    fake({
      exec: (_input, nth) =>
        nth === 1
          ? receipt(`abc123\nREADME\n${DOGFOOD_MARKER}\n`)
          : receipt(`abc123\nREADME\n${DOGFOOD_MARKER}\n`, {
              receipt: { exitCode: 0, durationMs: 1, deduped: true, tail: "", truncated: false },
              ensured: { generation: 1, rebuilt: false },
            }),
    });

  it("walks ensure → exec → exec → checkpoint → abort", async () => {
    const facade = happy();
    const run = await runDogfood(facade, { recipe: cloneRecipe, idempotencyKey: "k" });
    expect(isDeferred(run) ? undefined : run.status).toBe("passed");
    expect(facade.calls.map((c) => c.method)).toEqual([
      "ensureSandbox",
      "execUnderGrant",
      "execUnderGrant",
      "checkpoint",
      "abort",
    ]);
    expect(facade.calls.every((c) => c.key === DOGFOOD_KEY)).toBe(true);
  });

  it("replays one idempotency key across both execs — the retry it is testing", async () => {
    const facade = happy();
    await runDogfood(facade, { recipe: cloneRecipe, idempotencyKey: "step-7" });
    const keys = facade.calls
      .filter((c) => c.method === "execUnderGrant")
      .map((c) => c.input?.idempotencyKey);
    expect(keys).toEqual(["step-7", "step-7"]);
  });

  it("fails when the second exec re-ran the command instead of replaying its receipt", async () => {
    const run = await runDogfood(fake({ exec: () => receipt(`abc123\n${DOGFOOD_MARKER}\n`) }), {
      recipe: cloneRecipe,
      idempotencyKey: "k",
    });
    expect(isDeferred(run) ? undefined : run.status).toBe("failed");
    expect(isDeferred(run) ? "" : run.evidence).toContain("exec-dedupe");
  });

  it("fails when the command ran but the clone never produced a tree", async () => {
    const run = await runDogfood(
      fake({
        exec: (_i, nth) =>
          nth === 1
            ? receipt("fatal: not a git repository\n", {
                receipt: {
                  exitCode: 128,
                  durationMs: 1,
                  deduped: false,
                  tail: "fatal",
                  truncated: false,
                },
              })
            : receipt("", {
                receipt: { exitCode: 0, durationMs: 1, deduped: true, tail: "", truncated: false },
              }),
      }),
      { recipe: cloneRecipe, idempotencyKey: "k" },
    );
    expect(isDeferred(run) ? undefined : run.status).toBe("failed");
  });

  it("defers on a full pool at ensure", async () => {
    const run = await runDogfood(
      fake({
        ensure: () => ({
          ok: false,
          refusal: { kind: "admission-refused", pool: "lean", poolBusy: 6, cap: 6 },
        }),
      }),
      { recipe: cloneRecipe, idempotencyKey: "k" },
    );
    expect(isDeferred(run)).toBe(true);
  });

  it("aborts even when a step refuses", async () => {
    const facade = fake({
      checkpoint: () => ({ ok: false, refusal: { kind: "sandbox-unavailable", reason: "gone" } }),
    });
    await runDogfood(facade, { recipe: cloneRecipe, idempotencyKey: "k" });
    expect(facade.calls.at(-1)?.method).toBe("abort");
  });
});
