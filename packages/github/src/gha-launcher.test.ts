import { describe, expect, it } from "vitest";
import { dispatchInputs } from "./gha-launcher.ts";
import {
  INSTALLATION_TOKEN,
  launcherHarness,
  makeActionsSigner,
  RUNNER_CONFIG,
  runnerClaims,
} from "./gha.test-support.ts";

const MINUTE = 60_000;
const lease = (executionId: string, epoch: number, minutesLeft: number) => ({
  executionId,
  epoch,
  scopeId: "scope-1",
  deadlineAt: Date.now() + minutesLeft * MINUTE + 30_000,
});

/** Starts a launch and answers the workflow run id GitHub gave it. */
const launched = async (
  h: Awaited<ReturnType<typeof launcherHarness>>,
  executionId: string,
  epoch: number,
) => {
  await h.start(lease(executionId, epoch, 30));
  return h.api.runIds.at(-1)!;
};

describe("gha launcher start", () => {
  it("[FD-EXEC-086] the workflow_dispatch inputs carry only the execution id, the epoch and the minutes until deadline_at, and no credential", async () => {
    const h = await launcherHarness();
    await h.start(lease("exec-1", 3, 42));
    expect(h.api.requests).toHaveLength(1);
    const body = h.api.requests[0]!.body as { inputs: Record<string, string> };
    expect(body.inputs).toEqual({ execution_id: "exec-1", epoch: "3", deadline_minutes: "42" });
    // The installation token authenticates the call; it never reaches the inputs the runner job reads.
    expect(h.api.requests[0]!.authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    expect(JSON.stringify(body)).not.toContain(INSTALLATION_TOKEN);
    expect(Object.keys(body).sort()).toEqual(["inputs", "ref", "return_run_details"]);
  });

  it("[FD-EXEC-086] the minutes input counts whole minutes left, and a lease under a minute from deadline_at dispatches nothing", async () => {
    const now = 1_700_000_000_000;
    const ref = { executionId: "e", epoch: 1, scopeId: "s", deadlineAt: now + 10 * MINUTE - 1 };
    expect(dispatchInputs(ref, now)).toEqual({
      execution_id: "e",
      epoch: "1",
      deadline_minutes: "9",
    });
    expect(dispatchInputs({ ...ref, deadlineAt: now + MINUTE - 1 }, now)).toBeUndefined();
    const h = await launcherHarness();
    await h.start({ ...ref, deadlineAt: Date.now() + 30_000 });
    expect(h.api.requests).toEqual([]);
  });

  it("a dispatch GitHub refuses records no launch, so no runner job can claim it", async () => {
    const h = await launcherHarness();
    h.api.refuseWith = 422;
    await h.start(lease("exec-r", 1, 30));
    h.api.refuseWith = undefined;
    const token = await h.signer.sign(runnerClaims(9_000));
    expect(await h.verify({ executionId: "exec-r", epoch: 1, token })).toBe(false);
  });

  it("[FD-EXEC-092] cancel cancels the workflow run of that (execution, epoch) through the Actions API", async () => {
    const h = await launcherHarness();
    const runId = await launched(h, "exec-c", 2);
    await h.cancel("exec-c", 2);
    const last = h.api.requests.at(-1)!;
    expect(last.method).toBe("POST");
    expect(last.url).toBe(
      `https://api.github.com/repos/${RUNNER_CONFIG.runnerRepo}/actions/runs/${runId}/cancel`,
    );
    await h.cancel("exec-unknown", 1);
    expect(h.api.requests.at(-1)).toBe(last);
  });
});

describe("gha launcher verify", () => {
  it("[FD-EXEC-088] verify accepts the runner job's Actions OIDC token only when its audience is the control plane", async () => {
    const h = await launcherHarness();
    const runId = await launched(h, "exec-a", 1);
    const foreign = await h.signer.sign(
      runnerClaims(runId, { aud: "https://elsewhere.example.com" }),
    );
    expect(await h.verify({ executionId: "exec-a", epoch: 1, token: foreign })).toBe(false);
    const sts = await h.signer.sign(runnerClaims(runId, { aud: "sts.amazonaws.com" }));
    expect(await h.verify({ executionId: "exec-a", epoch: 1, token: sts })).toBe(false);
    const token = await h.signer.sign(runnerClaims(runId));
    expect(await h.verify({ executionId: "exec-a", epoch: 1, token })).toBe(true);
  });

  it("[FD-EXEC-088] verify refuses a token GitHub's Actions issuer did not sign, an expired one and a malformed claim", async () => {
    const h = await launcherHarness();
    const runId = await launched(h, "exec-s", 1);
    const other = await makeActionsSigner("actions-key");
    const forged = await other.sign(runnerClaims(runId));
    expect(await h.verify({ executionId: "exec-s", epoch: 1, token: forged })).toBe(false);
    const wrongIssuer = await h.signer.sign(
      runnerClaims(runId, { iss: "https://issuer.example.com" }),
    );
    expect(await h.verify({ executionId: "exec-s", epoch: 1, token: wrongIssuer })).toBe(false);
    const past = Math.floor(Date.now() / 1000) - 600;
    const expired = await h.signer.sign(runnerClaims(runId, { iat: past - 300, exp: past }));
    expect(await h.verify({ executionId: "exec-s", epoch: 1, token: expired })).toBe(false);
    expect(await h.verify({ executionId: "exec-s", epoch: "1", token: forged })).toBe(false);
    expect(await h.verify("not a claim")).toBe(false);
    expect(
      await h.verify({
        executionId: "exec-s",
        epoch: 1,
        token: await h.signer.sign(runnerClaims(runId)),
      }),
    ).toBe(true);
  });

  it("[FD-EXEC-089] verify rejects a token whose repository or workflow ref differs from the runner repository and workflow the overlay names", async () => {
    const h = await launcherHarness();
    const runId = await launched(h, "exec-w", 1);
    const repo = RUNNER_CONFIG.runnerRepo;
    const mismatches = [
      {
        repository: "acme/other",
        workflow_ref: `acme/other/.github/workflows/runner.yml@refs/heads/main`,
      },
      { workflow_ref: `${repo}/.github/workflows/ci.yml@refs/heads/main` },
      { workflow_ref: `${repo}/.github/workflows/runner.yml@refs/heads/attacker` },
      { workflow_ref: `acme/other/.github/workflows/runner.yml@refs/heads/main` },
      { repository: "acme/other" },
      { workflow_ref: undefined },
    ];
    for (const overrides of mismatches) {
      const token = await h.signer.sign(runnerClaims(runId, overrides));
      expect(
        await h.verify({ executionId: "exec-w", epoch: 1, token }),
        JSON.stringify(overrides),
      ).toBe(false);
    }
    // GitHub resolves repository names without case; the same repository in other case still matches.
    const token = await h.signer.sign(
      runnerClaims(runId, {
        repository: "Acme/FD-Runners",
        workflow_ref: "Acme/FD-Runners/.github/workflows/runner.yml@refs/heads/main",
      }),
    );
    expect(await h.verify({ executionId: "exec-w", epoch: 1, token })).toBe(true);
  });

  it("[FD-EXEC-090] once a claim for an (execution, epoch) is accepted, verify rejects every later claim for it, from any isolate", async () => {
    const h = await launcherHarness();
    const runId = await launched(h, "exec-x", 4);
    const token = await h.signer.sign(runnerClaims(runId));
    expect(await h.verify({ executionId: "exec-x", epoch: 4, token })).toBe(true);
    expect(await h.verify({ executionId: "exec-x", epoch: 4, token })).toBe(false);
    const rerun = await h.signer.sign(runnerClaims(runId, { run_attempt: "2" }));
    expect(await h.verify({ executionId: "exec-x", epoch: 4, token: rerun })).toBe(false);
    // A second isolate's launcher on the same D1 refuses it too.
    expect(await h.verify({ executionId: "exec-x", epoch: 4, token }, h.launcher())).toBe(false);
  });

  it("[FD-EXEC-090] concurrent claims for one (execution, epoch) admit exactly one", async () => {
    const h = await launcherHarness();
    const runId = await launched(h, "exec-y", 1);
    const token = await h.signer.sign(runnerClaims(runId));
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        h.verify(
          { executionId: "exec-y", epoch: 1, token },
          i % 2 === 0 ? undefined : h.launcher(),
        ),
      ),
    );
    expect(answers.filter(Boolean)).toHaveLength(1);
  });

  it("verify admits a token only for the (execution, epoch) its launch named", async () => {
    const h = await launcherHarness();
    const runA = await launched(h, "exec-a", 1);
    await launched(h, "exec-b", 1);
    const tokenA = await h.signer.sign(runnerClaims(runA));
    expect(await h.verify({ executionId: "exec-b", epoch: 1, token: tokenA })).toBe(false);
    expect(await h.verify({ executionId: "exec-a", epoch: 2, token: tokenA })).toBe(false);
    expect(await h.verify({ executionId: "exec-a", epoch: 1, token: tokenA })).toBe(true);
  });
});
