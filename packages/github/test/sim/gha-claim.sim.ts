// The `gha` launcher's runner claims as a V-SIM scenario (specs/executors.md FD-EXEC-090). A seed fixes a fleet of
// launches spread over several isolates' launchers on one SQLite D1, and a stream of claims against them: the genuine
// runner job's token, its replays and re-run attempts, a token of another launch's run naming the lease, and bursts of
// one token sent at once to several isolates. The scenario checks that every (execution, epoch) admits at most one
// claim, that the claim it admits carries the token of the run its launch started, and that every claim after the
// accepted one is refused.
// `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts): each seed fails on any violation.
import type { Launcher } from "@fractalboxdev/mameko-ports";
import type { Layer } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import {
  launcherHarness,
  makeActionsSigner,
  runnerClaims,
  type ActionsSigner,
} from "../../src/gha.test-support.ts";

const ISOLATES = 3;
const MINUTE = 60_000;

export interface ClaimOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

let signer: Promise<ActionsSigner> | undefined;

export const simulateClaims = async (seed: number): Promise<ClaimOutcome> => {
  const random = seededRandom(seed);
  const pick = <A>(xs: readonly A[]): A => xs[Math.floor(random() * xs.length)]!;
  const h = await launcherHarness({ signer: await (signer ??= makeActionsSigner()) });
  const isolates: Layer.Layer<Launcher>[] = Array.from({ length: ISOLATES }, () => h.launcher());
  const violations: SimViolation[] = [];
  const reached: Record<string, number> = {};
  const trace: string[] = [];
  const reach = (k: string) => (reached[k] = (reached[k] ?? 0) + 1);

  // Launches: each execution starts at epoch 1 and some are reclaimed and launched again at the next epoch.
  const launches: { key: string; executionId: string; epoch: number; runId: number }[] = [];
  const executions = 2 + Math.floor(random() * 4);
  for (let e = 0; e < executions; e++) {
    const epochs = 1 + Math.floor(random() * 2);
    for (let epoch = 1; epoch <= epochs; epoch++) {
      const executionId = `exec-${seed}-${e}`;
      await h.start(
        { executionId, epoch, scopeId: "scope", deadlineAt: Date.now() + 30 * MINUTE },
        pick(isolates),
      );
      launches.push({
        key: `${executionId}#${epoch}`,
        executionId,
        epoch,
        runId: h.api.runIds.at(-1)!,
      });
    }
  }

  const accepted = new Map<string, number>();
  const record = (key: string, runId: number, kind: string, answers: readonly boolean[]) => {
    const yes = answers.filter(Boolean).length;
    trace.push(`${kind} ${key} run ${runId}: ${yes}/${answers.length}`);
    if (yes === 0) return;
    reach(`accepted-${kind}`);
    const launch = launches.find((l) => l.key === key)!;
    if (runId !== launch.runId)
      violations.push({
        id: "FD-EXEC-090",
        message: `${key} admitted run ${runId}, launched ${launch.runId}`,
      });
    if (accepted.has(key) || yes > 1)
      violations.push({
        id: "FD-EXEC-090",
        message: `${key} admitted a claim after one was accepted`,
      });
    accepted.set(key, runId);
  };

  const claims = 10 + Math.floor(random() * 20);
  for (let i = 0; i < claims; i++) {
    const target = pick(launches);
    const draw = random();
    // The genuine runner job, a re-run attempt of it, or a job of another launch naming this lease.
    const kind = draw < 0.5 ? "genuine" : draw < 0.75 ? "rerun" : "foreign";
    const runId = kind === "foreign" ? pick(launches).runId : target.runId;
    const token = await (
      await signer
    ).sign(
      runnerClaims(
        runId,
        kind === "rerun" ? { run_attempt: String(2 + Math.floor(random() * 3)) } : {},
      ),
    );
    const claim = { executionId: target.executionId, epoch: target.epoch, token };
    const burst = random() < 0.3 ? 2 + Math.floor(random() * 3) : 1;
    if (accepted.has(target.key)) reach("after-accepted");
    if (burst > 1) reach("burst");
    const answers = await Promise.all(
      Array.from({ length: burst }, () => h.verify(claim, pick(isolates))),
    );
    record(target.key, runId, kind, answers);
  }
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: "gha-claim",
    ids: ["FD-EXEC-090"],
    run: async (seed) => throwOnViolations((await simulateClaims(seed)).violations),
  },
];
