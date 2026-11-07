// `improve-pr`: per dimension of the repo manifest, a measurement, an edit loop that sees only the measurement, a
// materiality floor and a verified staged write (specs/runs/agentic.md § `improve-pr`, FD-AGT-060 to FD-AGT-062).
import type { RunResult } from "@fractalboxdev/mameko-run";
import { Effect, Schema } from "effect";
import { EditLoop, Shell, StagedWrites } from "./services.ts";

export const Dimension = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/)),
  /** Prints the dimension's score; its first number is the measurement. */
  measure: Schema.NonEmptyString,
  /** Whether a lower or a higher score is better. */
  better: Schema.Literals(["lower", "higher"]),
  /** The smallest gain, in score units, worth a pull request. */
  materialityFloor: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  verify: Schema.NonEmptyString,
});
export type Dimension = typeof Dimension.Type;

export const ImprovePrInput = Schema.Struct({
  baseBranch: Schema.String,
  dimension: Dimension,
});
export type ImprovePrInput = typeof ImprovePrInput.Type;

export class MeasureFailed extends Schema.TaggedError<MeasureFailed>()("MeasureFailed", {
  dimension: Schema.String,
  detail: Schema.String,
}) {}

const MEASURE_TIMEOUT_MS = 600_000;

/** The first number a measurement command prints. */
export const scoreOf = (output: string): number | null => {
  const m = /-?\d+(?:\.\d+)?/.exec(output);
  return m === null ? null : Number(m[0]);
};

const measure = (d: Dimension) =>
  Effect.gen(function* () {
    const shell = yield* Shell;
    const r = yield* shell.run(d.measure, { timeoutMs: MEASURE_TIMEOUT_MS });
    const score = r.exitCode === 0 ? scoreOf(r.stdout) : null;
    if (score === null)
      return yield* new MeasureFailed({ dimension: d.name, detail: `exit ${r.exitCode}` });
    return { score, output: r.stdout.slice(0, 20_000) };
  });

/** The edit loop's prompt: the dimension and its measurement output, and nothing else (FD-AGT-060). */
export const improvePrompt = (d: Dimension, measurementOutput: string) =>
  [
    `Improve the repository on the dimension "${d.name}", where a ${d.better} score is better.`,
    "The measurement command's output follows. Edit the checkout to improve the score; change nothing unrelated.",
    "<measurement>",
    measurementOutput,
    "</measurement>",
  ].join("\n");

/** The gain from `before` to `after`, positive when the score moved the better way. */
export const gainOf = (d: Dimension, before: number, after: number) =>
  d.better === "lower" ? before - after : after - before;

/** The `improve-pr` body for one dimension. */
export const runImprovePr = (input: ImprovePrInput) =>
  Effect.gen(function* () {
    const d = input.dimension;
    const before = yield* measure(d);
    const edit = yield* EditLoop;
    const loop = yield* edit.run(improvePrompt(d, before.output));
    if (loop.exitCode === null || loop.exitCode === 126 || loop.exitCode === 127)
      return { _tag: "failure", reason: "infra: edit loop unavailable" } satisfies RunResult;
    const after = yield* measure(d);
    const gain = gainOf(d, before.score, after.score);
    if (gain < d.materialityFloor) return { _tag: "success" } satisfies RunResult;

    const shell = yield* Shell;
    const verified = yield* shell.run(d.verify, { timeoutMs: MEASURE_TIMEOUT_MS });
    if (verified.exitCode !== 0) return { _tag: "success" } satisfies RunResult;

    const stage = yield* StagedWrites;
    yield* stage.stage({
      branch: `flare-dispatch/improve-${d.name}`,
      baseBranch: input.baseBranch,
      message: `chore: improve ${d.name}`,
      pr: {
        title: `Improve ${d.name}`,
        body: [
          `The \`${d.name}\` score moved from ${before.score} to ${after.score} (gain ${gain}, floor ${d.materialityFloor}).`,
          "",
          `Measured with \`${d.measure.replaceAll("`", "'")}\`; \`${d.verify.replaceAll("`", "'")}\` exits 0 on the edited checkout.`,
        ].join("\n"),
        draft: true,
        labels: ["improve-pr"],
      },
    });
    return { _tag: "success" } satisfies RunResult;
  }).pipe(
    Effect.catchTags({
      MeasureFailed: (e) =>
        Effect.succeed({
          _tag: "failure",
          reason: `finding: measure ${e.dimension}: ${e.detail}`,
        } satisfies RunResult),
      StageFailed: (e) =>
        Effect.succeed({
          _tag: "failure",
          reason: `infra: stage: ${e.detail}`,
        } satisfies RunResult),
    }),
  );
