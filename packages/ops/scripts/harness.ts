// The `diff`, `sim` and `replay` jobs (specs/verification.md FD-VER-019 to FD-VER-021, FD-VER-024, FD-VER-025):
//
//   node --experimental-strip-types packages/ops/scripts/harness.ts diff [--traces 10000] [--seed n] [--emit file]
//   node --experimental-strip-types packages/ops/scripts/harness.ts sim [--seeds 100] [--emit file]
//   node --experimental-strip-types packages/ops/scripts/harness.ts replay
//
// Each discovers its entries across the workspace: `test/diff/*.diff.ts` exporting `subject`, `test/sim/*.sim.ts`
// exporting `scenarios` and `test/replay/*.replay.ts` exporting `workflows`. `diff` requires a subject for each kernel
// the oracle models (`DIFF_KERNELS`) and runs every subject it discovers; `--emit` writes the regression line or the
// failing seeds a nightly run appends through a pull request.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseRegressions,
  replayRegressions,
  runDiff,
  type DiffSubject,
} from "../src/verification/diff.ts";
import {
  PR_SEEDS,
  readKeptSeeds,
  runReplays,
  runSims,
  seedsToKeep,
  type ReplayWorkflow,
  type SimScenario,
} from "../src/verification/harness.ts";
import { args, readTree, ROOT } from "./repo.ts";

const [job] = process.argv.slice(2);
const opts = args(process.argv.slice(3));

const discover = async <T>(suffix: string, dir: string, name: string): Promise<T[]> => {
  const files = [
    ...readTree(ROOT, (p) => p.endsWith(suffix) && p.includes(`test/${dir}/`)).keys(),
  ].sort();
  const out: T[] = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(join(ROOT, f)).href)) as Record<string, unknown>;
    const value = mod[name];
    if (Array.isArray(value)) out.push(...(value as T[]));
    else if (value !== undefined) out.push(value as T);
  }
  return out;
};

/**
 * The kernels `oracle` answers, each with the Lean model the subject compares against (specs/verification.md § V-DIFF):
 * the `diff` job fails when a subject is missing, so a deleted subject cannot pass the job unnoticed.
 */
const DIFF_KERNELS = {
  stagedWriteGate: "formal/FdFormal/StagedWrite.lean (FD-VER-019)",
  placement: "formal/FdFormal/Placement.lean",
  driftProfile: "formal/FdFormal/Drift.lean (FD-OPS-021)",
} as const;

const emit = (lines: readonly unknown[]) => {
  const file = opts.get("emit");
  if (file !== undefined && lines.length > 0)
    writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
};

if (job === "diff") {
  const subjects = await discover<DiffSubject<unknown, unknown>>(".diff.ts", "diff", "subject");
  const missing = Object.entries(DIFF_KERNELS).filter(
    ([kernel]) => !subjects.some((s) => s.kernel === kernel),
  );
  for (const [kernel, model] of missing)
    console.error(`diff: no test/diff subject for ${kernel} and its compiled oracle over ${model}`);
  if (missing.length > 0) process.exit(1);
  const regressions = parseRegressions(
    readFileSync(join(ROOT, "formal/regressions.jsonl"), "utf8"),
  );
  const traces = Number(opts.get("traces") ?? 10_000);
  const seed = Number(opts.get("seed") ?? Date.now() % 2 ** 31);
  for (const s of subjects) {
    const replayed = await replayRegressions(s, regressions);
    if (replayed !== null) {
      console.error(`diff: ${s.kernel} differs on a kept regression: ${JSON.stringify(replayed)}`);
      process.exit(1);
    }
    const outcome = await runDiff(s, { traces, seed });
    if (!outcome.ok) {
      console.error(`diff: ${s.kernel} differs: ${JSON.stringify(outcome.line)}`);
      emit([outcome.line]);
      process.exit(1);
    }
    console.log(
      `diff: ${s.kernel} agreed on ${regressions.length} kept and ${outcome.traces} generated traces, seed ${seed}`,
    );
    s.close?.();
  }
} else if (job === "sim") {
  const scenarios = await discover<SimScenario>(".sim.ts", "sim", "scenarios");
  const kept = readKeptSeeds();
  const failures = await runSims(scenarios, Number(opts.get("seeds") ?? PR_SEEDS), kept);
  for (const f of failures) console.error(`sim: ${f.scenario} seed ${f.seed}: ${f.message}`);
  emit(seedsToKeep(failures, kept));
  console.log(`sim: ${scenarios.length} scenario(s), ${failures.length} failing seed(s)`);
  process.exit(failures.length === 0 ? 0 : 1);
} else if (job === "replay") {
  const workflows = await discover<ReplayWorkflow>(".replay.ts", "replay", "workflows");
  const extras = await runReplays(workflows);
  for (const e of extras)
    console.error(`replay: ${e.workflow} made an extra ${e.effect.kind} effect ${e.effect.key}`);
  console.log(`replay: ${workflows.length} workflow(s), ${extras.length} extra effect(s)`);
  process.exit(extras.length === 0 ? 0 : 1);
} else {
  console.error("use diff, sim or replay");
  process.exit(2);
}
