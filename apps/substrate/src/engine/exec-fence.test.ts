import { describe, expect, it } from "vitest";
import type {
  EnsureOutcome,
  ExecReceipt,
  SubstrateRecipe,
} from "@fractalboxdev/flare-dispatch-substrate-contract";
import { sha256Hex } from "./approval";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_TAIL_BYTES,
  runFence,
  type GuardedSandbox,
} from "./exec-fence";

const CONTAINER = "b1946ac92492d2347c6235b4d2611184";

const RECIPE: SubstrateRecipe = {
  version: 1,
  repo: { owner: "acme", name: "widget" },
};

const NO_REPO: SubstrateRecipe = { version: 1 };

const OK: ExecReceipt = {
  exitCode: 0,
  durationMs: 12,
  deduped: false,
  tail: "done",
  truncated: false,
};

type FakeOpts = {
  execReceipt?: ExecReceipt;
  execThrows?: Error;
  killThrows?: Error;
  revokeThrowsFor?: string;
  ensureOutcome?: EnsureOutcome;
};

/**
 * A sandbox that records the exact order of every call the fence makes. The
 * ordering *is* the security property here, so the assertions are on this log
 * rather than on outcomes.
 */
function fakeSandbox(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const execInputs: unknown[] = [];
  const grantParams: unknown[] = [];

  const sandbox: GuardedSandbox = {
    ensure: async () => {
      calls.push("ensure");
      return opts.ensureOutcome ?? { ok: true, generation: 1, rebuilt: false };
    },
    runTaskCommand: async (input) => {
      calls.push("exec");
      execInputs.push(input);
      if (opts.execThrows) throw opts.execThrows;
      return opts.execReceipt ?? OK;
    },
    killAllProcesses: async () => {
      calls.push("kill");
      if (opts.killThrows) throw opts.killThrows;
      return 3;
    },
    allowHost: async (h) => {
      calls.push(`allow:${h}`);
    },
    removeAllowedHost: async (h) => {
      calls.push(`unallow:${h}`);
      if (opts.revokeThrowsFor === h) throw new Error("revoke failed");
    },
    denyHost: async (h) => {
      calls.push(`deny:${h}`);
    },
    removeDeniedHost: async (h) => {
      calls.push(`undeny:${h}`);
    },
    setOutboundByHost: async (h, m, p) => {
      calls.push(`map:${h}:${m}`);
      grantParams.push(p);
    },
    removeOutboundByHost: async (h) => {
      calls.push(`unmap:${h}`);
    },
  };

  return { sandbox, calls, execInputs, grantParams };
}

const base = {
  recipe: RECIPE,
  command: "pnpm test",
  idempotencyKey: "k1",
  logPath: "tasks/7/exec-k1.log",
  containerId: CONTAINER,
};

const idx = (calls: string[], pred: (c: string) => boolean) => calls.findIndex(pred);

describe("runFence — the sequence is the property", () => {
  it("ensures before it applies, and applies before it execs", async () => {
    const { sandbox, calls } = fakeSandbox();
    await runFence(sandbox, base);

    const ensure = calls.indexOf("ensure");
    const firstApply = idx(calls, (c) => c.startsWith("allow:") || c.startsWith("map:"));
    const exec = calls.indexOf("exec");
    expect(ensure).toBeLessThan(firstApply);
    expect(firstApply).toBeLessThan(exec);
  });

  it("reports what the kill and the grant actually did", async () => {
    // `killed` is assigned in `finally`, so a return statement inside the
    // `try` would evaluate it before the kill happened and report 0 forever —
    // the number is the only thing that would surface a change to
    // `killAllProcesses`'s contract.
    const { sandbox } = fakeSandbox();
    const outcome = await runFence(sandbox, base);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.killed).toBe(3);
    // Both hosts a clone needs — an exact pattern is exact, so `github.com`
    // alone does not admit `codeload.github.com`, and a clone that redirects
    // there would be denied if `granted` silently narrowed to one host.
    expect(outcome.granted).toEqual(["github.com", "codeload.github.com"]);
    expect(outcome.receipt).toEqual(OK);
    expect(outcome.ensured).toEqual({ generation: 1, rebuilt: false });
  });

  it("composes a selected profile's hosts onto the repo read, and revokes them", async () => {
    // The recipe selects a NAME; what the name admits is authored in reviewed
    // code (ADR-0005/0006). A profile that never reached the grant would leave
    // the credential injector unreachable and `wrangler deploy` on deny-all.
    const { sandbox, calls } = fakeSandbox();
    const outcome = await runFence(sandbox, {
      ...base,
      recipe: { ...RECIPE, profiles: ["cf-api"] },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.granted).toContain("api.cloudflare.com");
    // A credentialed host left admitted past the command is the leak that
    // matters most, so it has to come back out with everything else.
    expect(calls).toContain("unallow:api.cloudflare.com");
  });

  it("reports no grant for a recipe that named no repository", async () => {
    // Deny-all stays exactly as the class posture ships it, and `granted` is
    // how a reader tells "no repository" from "grant failed to apply".
    const { sandbox } = fakeSandbox();
    const outcome = await runFence(sandbox, { ...base, recipe: NO_REPO });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.granted).toEqual([]);
    expect(outcome.killed).toBe(3);
  });

  it("kills before it revokes", async () => {
    const { sandbox, calls } = fakeSandbox();
    await runFence(sandbox, base);

    // Measured from `exec`, because the stale-grant revoke at the top of the
    // sequence also emits `unallow:` — see the test below.
    const after = calls.slice(calls.indexOf("exec"));
    const kill = after.indexOf("kill");
    const firstRevoke = idx(after, (c) => c.startsWith("unallow:"));
    expect(kill).toBeGreaterThanOrEqual(0);
    expect(firstRevoke).toBeGreaterThanOrEqual(0);
    // A backgrounded process outlives the command; revoking first would close
    // the grant on the foreground command while its children still hold it.
    expect(kill).toBeLessThan(firstRevoke);
  });

  it("revokes a grant left behind by a previous call before ensuring", async () => {
    const { sandbox, calls } = fakeSandbox();
    await runFence(sandbox, base);
    // A caller that died mid-flight leaves its grant on a container that
    // outlives it; the first thing this path does is take it away again.
    expect(idx(calls, (c) => c.startsWith("unallow:"))).toBeLessThan(calls.indexOf("ensure"));
  });

  it("revokes when the command throws", async () => {
    const { sandbox, calls } = fakeSandbox({ execThrows: new Error("container died") });
    await expect(runFence(sandbox, base)).rejects.toThrow("container died");
    expect(calls).toContain("kill");
    expect(calls.filter((c) => c === "unallow:github.com").length).toBeGreaterThanOrEqual(2);
    expect(calls).toContain("unmap:github.com");
  });

  it("still revokes when the kill throws", async () => {
    const { sandbox, calls } = fakeSandbox({ killThrows: new Error("no container") });
    await runFence(sandbox, base);
    // A failing kill must not skip the revoke — a swallowed revoke is a
    // leaked grant, worse than an un-killed process on a dying container.
    const afterExec = calls.slice(calls.indexOf("exec"));
    expect(afterExec).toContain("unallow:github.com");
    expect(afterExec).toContain("unmap:codeload.github.com");
  });

  it("propagates a revoke failure rather than reporting success", async () => {
    const { sandbox } = fakeSandbox({ revokeThrowsFor: "github.com" });
    // The command itself succeeded, but a grant that would not close is not a
    // successful call.
    await expect(runFence(sandbox, base)).rejects.toThrow(/revoke call/);
  });

  it("denies the write sinks and never un-denies them", async () => {
    const { sandbox, calls } = fakeSandbox();
    await runFence(sandbox, base);
    expect(calls).toContain("deny:gist.github.com");
    expect(calls.some((c) => c.startsWith("undeny:"))).toBe(false);
  });

  it("passes an ensure refusal through and never applies or execs", async () => {
    // The ticket gate answers inside ensure (ADR-0004); a lapsed admission
    // must end the fence with the typed refusal and no grant applied.
    const { sandbox, calls } = fakeSandbox({
      ensureOutcome: {
        ok: false,
        refusal: { kind: "ticket-rejected", reason: "admission ticket expired" },
      },
    });
    const outcome = await runFence(sandbox, base);
    expect(outcome).toEqual({
      ok: false,
      refusal: { kind: "ticket-rejected", reason: "admission ticket expired" },
    });
    expect(calls.some((c) => c.startsWith("allow:"))).toBe(false);
    expect(calls).not.toContain("exec");
  });
});

describe("runFence — the approval floor at the exec surface (ADR-0007)", () => {
  it("refuses a floor command with no attestation, before touching the container", async () => {
    const { sandbox, calls } = fakeSandbox();
    const outcome = await runFence(sandbox, { ...base, command: "git push origin main" });
    expect(outcome).toEqual({
      ok: false,
      refusal: { kind: "approval-required", rule: "git push" },
    });
    expect(calls).toHaveLength(0);
  });

  it("runs a floor command whose attestation binds to it", async () => {
    const command = "git push origin main";
    const { sandbox, calls } = fakeSandbox();
    const outcome = await runFence(sandbox, {
      ...base,
      command,
      approval: {
        taskId: "7",
        ordinal: 3,
        commandSha256: await sha256Hex(command),
        approvedBy: "U0HUMAN",
        approvedAt: 1_700_000_000_000,
      },
    });
    expect(outcome.ok).toBe(true);
    expect(calls).toContain("exec");
  });

  it("refuses an attestation for a different command, before touching the container", async () => {
    const { sandbox, calls } = fakeSandbox();
    const outcome = await runFence(sandbox, {
      ...base,
      command: "git push origin main --force",
      approval: {
        taskId: "7",
        ordinal: 3,
        commandSha256: await sha256Hex("git push origin main"),
        approvedBy: "U0HUMAN",
        approvedAt: 1_700_000_000_000,
      },
    });
    expect(outcome).toMatchObject({ ok: false, refusal: { kind: "attestation-rejected" } });
    expect(calls).toHaveLength(0);
  });
});

describe("runFence — what reaches the container", () => {
  it("binds the grant to the caller's containerId, not to anything the workload wrote", async () => {
    const { sandbox, grantParams } = fakeSandbox();
    await runFence(sandbox, base);
    expect(grantParams.length).toBeGreaterThan(0);
    for (const p of grantParams)
      expect(p).toMatchObject({ repo: "acme/widget", containerId: CONTAINER });
  });

  it("asserts against the recipe's repo, not a repo named in the command", async () => {
    const { sandbox, grantParams } = fakeSandbox();
    await runFence(sandbox, {
      ...base,
      command: "git clone https://github.com/attacker/sink",
    });
    for (const p of grantParams) expect(p).toMatchObject({ repo: "acme/widget" });
  });

  it("passes the command through with the configured limits", async () => {
    const { sandbox, execInputs } = fakeSandbox();
    await runFence(sandbox, base);
    expect(execInputs[0]).toEqual({
      command: "pnpm test",
      idempotencyKey: "k1",
      logPath: "tasks/7/exec-k1.log",
      timeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
      tailBytes: DEFAULT_TAIL_BYTES,
    });
  });

  it("admits nothing at all when the recipe names no repository", async () => {
    const { sandbox, calls } = fakeSandbox();
    await runFence(sandbox, { ...base, recipe: NO_REPO });
    // "No repo" means "no network", not "no restriction".
    expect(calls.some((c) => c.startsWith("allow:"))).toBe(false);
    expect(calls.some((c) => c.startsWith("map:"))).toBe(false);
    expect(calls).toEqual(["ensure", "exec", "kill"]);
  });

  it("opts the LFS object host in only when asked — via input or recipe", async () => {
    const plain = fakeSandbox();
    await runFence(plain.sandbox, base);
    expect(plain.calls).not.toContain("allow:objects.githubusercontent.com");

    const viaInput = fakeSandbox();
    await runFence(viaInput.sandbox, { ...base, lfs: true });
    expect(viaInput.calls).toContain("allow:objects.githubusercontent.com");
    expect(viaInput.calls).toContain("map:objects.githubusercontent.com:publicRepo");

    const viaRecipe = fakeSandbox();
    await runFence(viaRecipe.sandbox, { ...base, recipe: { ...RECIPE, lfs: true } });
    expect(viaRecipe.calls).toContain("allow:objects.githubusercontent.com");
  });

  it("refuses an empty command before touching the container", async () => {
    const { sandbox, calls } = fakeSandbox();
    const outcome = await runFence(sandbox, { ...base, command: "   " });
    expect(outcome).toMatchObject({ ok: false, refusal: { kind: "recipe-rejected" } });
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed repo as a typed refusal, before touching the container", async () => {
    const { sandbox, calls } = fakeSandbox();
    const outcome = await runFence(sandbox, {
      ...base,
      recipe: { version: 1, repo: { owner: "acme", name: "widget/extra" } },
    });
    expect(outcome).toMatchObject({ ok: false, refusal: { kind: "recipe-rejected" } });
    expect(calls).toHaveLength(0);
  });
});
