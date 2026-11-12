// The `sim` and `replay` harness runners (specs/verification.md FD-VER-024, FD-VER-025). Each scenario lives in a
// `test/sim/` or `test/replay/` directory of the package that owns it; these runners execute them with the seeds and
// the double run the merge gate requires.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One `V-SIM` scenario: a deterministic run of the fleet for one seed, failing by throwing. */
export interface SimScenario {
  readonly name: string;
  readonly ids: readonly string[];
  readonly run: (seed: number) => Promise<void>;
}

/** One kept failing seed, a `test/sim/seeds.jsonl` line. */
export interface KeptSeed {
  readonly scenario: string;
  readonly seed: number;
}

/** The seeds per scenario a pull request runs, and the nightly count (FD-VER-024). */
export const PR_SEEDS = 100;
export const NIGHTLY_SEEDS = 10_000;

/** The repository's `test/sim/seeds.jsonl`, which the `sim` job reads and the nightly run appends to. */
export const KEPT_SEEDS_FILE = join(import.meta.dirname, "../../../../test/sim/seeds.jsonl");

/** Every kept failing seed in `file`; none when the file does not exist. */
export const readKeptSeeds = (file: string = KEPT_SEEDS_FILE): readonly KeptSeed[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as KeptSeed)
    : [];

/** The seeds one scenario runs: every kept seed of it, then 1 to `count`, each once. */
export const seedsOf = (
  scenario: string,
  count: number,
  kept: readonly KeptSeed[],
): readonly number[] => [
  ...new Set([
    ...kept.filter((k) => k.scenario === scenario).map((k) => k.seed),
    ...Array.from({ length: count }, (_, i) => i + 1),
  ]),
];

/** A seeded PRNG (mulberry32) answering draws in [0, 1): one seed fixes every draw of a scenario run. */
export const seededRandom = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** A property a scenario run broke: the requirement and what happened. */
export interface SimViolation {
  readonly id: string;
  readonly message: string;
}

/** Fails a scenario run that saw any violation, naming the requirement each one breaks. */
export const throwOnViolations = (violations: readonly SimViolation[]): void => {
  if (violations.length > 0)
    throw new Error(violations.map((v) => `[${v.id}] ${v.message}`).join("; "));
};

/** A failing scenario run: its seed and why. */
export interface SimFailure {
  readonly scenario: string;
  readonly seed: number;
  readonly message: string;
}

/** Runs `count` seeds of every scenario, from 1, plus every kept seed of that scenario; answers every failure. */
export const runSims = async (
  scenarios: readonly SimScenario[],
  count: number,
  kept: readonly KeptSeed[],
): Promise<readonly SimFailure[]> => {
  const failures: SimFailure[] = [];
  for (const s of scenarios) {
    for (const seed of seedsOf(s.name, count, kept))
      try {
        await s.run(seed);
      } catch (e) {
        failures.push({
          scenario: s.name,
          seed,
          message: e instanceof Error ? e.message : String(e),
        });
      }
  }
  return failures;
};

/** The seeds a nightly run appends to `test/sim/seeds.jsonl`: each failure not already kept. */
export const seedsToKeep = (
  failures: readonly SimFailure[],
  kept: readonly KeptSeed[],
): readonly KeptSeed[] =>
  failures
    .filter((f) => !kept.some((k) => k.scenario === f.scenario && k.seed === f.seed))
    .map((f) => ({ scenario: f.scenario, seed: f.seed }));

/** One external effect a workflow run made. */
export interface ReplayEffect {
  readonly kind: "github" | "d1" | "intent";
  readonly key: string;
}

/** One `V-REPLAY` workflow: a run from no journal answers its journal; a run over that journal replays it. */
export interface ReplayWorkflow<J = unknown> {
  readonly name: string;
  readonly ids: readonly string[];
  readonly run: (
    journal: J | null,
  ) => Promise<{ readonly journal: J; readonly effects: readonly ReplayEffect[] }>;
}

/** A second run's effect its first run did not make (FD-VER-025). */
export interface ReplayExtra {
  readonly workflow: string;
  readonly effect: ReplayEffect;
}

/** Runs each workflow twice, the second over the first run's journal, and answers every extra effect. */
export const runReplays = async (
  workflows: readonly ReplayWorkflow[],
): Promise<readonly ReplayExtra[]> => {
  const extras: ReplayExtra[] = [];
  for (const w of workflows) {
    const first = await w.run(null);
    const second = await w.run(first.journal);
    const counts = new Map<string, number>();
    for (const e of first.effects)
      counts.set(`${e.kind} ${e.key}`, (counts.get(`${e.kind} ${e.key}`) ?? 0) + 1);
    for (const e of second.effects) {
      const k = `${e.kind} ${e.key}`;
      const left = counts.get(k) ?? 0;
      if (left === 0) extras.push({ workflow: w.name, effect: e });
      else counts.set(k, left - 1);
    }
  }
  return extras;
};
