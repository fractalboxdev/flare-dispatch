// Differential testing (specs/verification.md FD-VER-019 to FD-VER-022): `fast-check` traces through a TypeScript
// kernel and through the oracle compiled from its Lean model, compared after every event. The first trace whose outputs
// differ fails the run; `fast-check` shrinks it, and the harness emits it as one `formal/regressions.jsonl` line.
import fc from "fast-check";

/** A kernel under differential test: the TypeScript function, its oracle and the generator of one event's input. */
export interface DiffSubject<I, O> {
  /** The kernel's name, as a regression line records it. */
  readonly kernel: string;
  readonly run: (input: I) => O;
  /** The oracle's answer for one input; a compiled oracle answers over a pipe. */
  readonly oracle: (input: I) => Promise<O>;
  readonly arbitrary: fc.Arbitrary<I>;
}

/** One `formal/regressions.jsonl` line: the kernel, the seed, the shrunk trace and both outputs (FD-VER-021). */
export interface RegressionLine<I = unknown, O = unknown> {
  readonly kernel: string;
  readonly seed: number;
  readonly trace: readonly I[];
  readonly kernelOutput: readonly O[];
  readonly oracleOutput: readonly O[];
}

/** JSON with object keys sorted, so equal values compare equal. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

/** Both outputs of a trace, compared after every event; the index of the first difference, or -1. */
export const runTrace = async <I, O>(subject: DiffSubject<I, O>, trace: readonly I[]) => {
  const kernelOutput: O[] = [];
  const oracleOutput: O[] = [];
  for (const input of trace) {
    kernelOutput.push(subject.run(input));
    oracleOutput.push(await subject.oracle(input));
    if (canonical(kernelOutput.at(-1)) !== canonical(oracleOutput.at(-1)))
      return { differsAt: kernelOutput.length - 1, kernelOutput, oracleOutput };
  }
  return { differsAt: -1, kernelOutput, oracleOutput };
};

/** Replays every regression line of the subject's kernel; the first that still differs, or null (FD-VER-019). */
export const replayRegressions = async <I, O>(
  subject: DiffSubject<I, O>,
  lines: readonly RegressionLine[],
): Promise<RegressionLine<I, O> | null> => {
  for (const line of lines.filter((l) => l.kernel === subject.kernel)) {
    const result = await runTrace(subject, line.trace as I[]);
    if (result.differsAt !== -1)
      return { kernel: subject.kernel, seed: line.seed, trace: line.trace as I[], ...result };
  }
  return null;
};

/** The outcome of one differential run. */
export type DiffOutcome<I, O> =
  | { readonly ok: true; readonly traces: number }
  | { readonly ok: false; readonly line: RegressionLine<I, O> };

/**
 * Runs `traces` generated traces of 1 to 20 events from `seed`, stopping at the first that differs and shrinking it
 * (FD-VER-019, FD-VER-020, FD-VER-021).
 */
export const runDiff = async <I, O>(
  subject: DiffSubject<I, O>,
  options: { readonly traces: number; readonly seed: number },
): Promise<DiffOutcome<I, O>> => {
  const details = await fc.check(
    fc.asyncProperty(
      fc.array(subject.arbitrary, { minLength: 1, maxLength: 20 }),
      async (trace) => (await runTrace(subject, trace)).differsAt === -1,
    ),
    { numRuns: options.traces, seed: options.seed },
  );
  if (!details.failed) return { ok: true, traces: details.numRuns };
  const trace = details.counterexample![0];
  const result = await runTrace(subject, trace);
  return {
    ok: false,
    line: {
      kernel: subject.kernel,
      seed: options.seed,
      trace,
      kernelOutput: result.kernelOutput,
      oracleOutput: result.oracleOutput,
    },
  };
};

/** Parses `formal/regressions.jsonl`. */
export const parseRegressions = (text: string): readonly RegressionLine[] =>
  text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RegressionLine);
