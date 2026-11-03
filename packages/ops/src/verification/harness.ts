// The `sim` and `replay` harness runners (specs/verification.md FD-VER-024, FD-VER-025). Each scenario lives in a
// `test/sim/` or `test/replay/` directory of the package that owns it; these runners execute them with the seeds and
// the double run the merge gate requires.

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
    const seeds = [
      ...kept.filter((k) => k.scenario === s.name).map((k) => k.seed),
      ...Array.from({ length: count }, (_, i) => i + 1),
    ];
    for (const seed of new Set(seeds))
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
