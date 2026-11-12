// The `formal` job's checks over `formal/` (specs/verification.md FD-VER-014 to FD-VER-016), the append-only rule of
// `formal/regressions.jsonl` (FD-VER-022) and the Tamarin result check (FD-PROV-073). `scripts/formal-gate.ts` runs
// `lake build`, `#print axioms` and `tamarin-prover --prove`.
import type { SpecFinding } from "./spec-tags.ts";

/** `formal/lean-toolchain` must pin one exact release, `leanprover/lean4:vX.Y.Z` (FD-VER-014). */
export const toolchainPinned = (text: string): boolean =>
  /^leanprover\/lean4:v\d+\.\d+\.\d+\s*$/.test(text);

/** Lean source with its comments blanked, line structure kept. */
export const stripLeanComments = (text: string): string => {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === "/-") {
      depth++;
      i++;
      out += "  ";
      continue;
    }
    if (depth > 0 && two === "-/") {
      depth--;
      i++;
      out += "  ";
      continue;
    }
    if (depth === 0 && two === "--") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      out += text[i] ?? "";
      continue;
    }
    out += depth > 0 && text[i] !== "\n" ? " " : text[i]!;
  }
  return out;
};

const FORBIDDEN = [
  { re: /\bsorry\b/, term: "sorry" },
  { re: /\badmit\b/, term: "admit" },
  { re: /\bnative_decide\b/, term: "native_decide" },
  { re: /^\s*(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+)?axiom\s/, term: "axiom" },
];

/** Each `sorry`, `admit`, `native_decide` or `axiom` declaration outside a comment, by file and line (FD-VER-015). */
export const forbiddenTerms = (file: string, text: string): readonly SpecFinding[] =>
  stripLeanComments(text)
    .split("\n")
    .flatMap((line, i) =>
      FORBIDDEN.filter((f) => f.re.test(line)).map((f) => ({
        check: "FD-VER-015",
        file,
        line: i + 1,
        message: `${f.term} in a formal/ file`,
      })),
    );

/** Every theorem and lemma name a file declares, qualified by its enclosing namespaces. */
export const theoremNames = (text: string): readonly string[] => {
  const names: string[] = [];
  const spaces: string[] = [];
  for (const line of stripLeanComments(text).split("\n")) {
    const ns = /^\s*namespace\s+([\w.]+)/.exec(line);
    if (ns !== null) spaces.push(ns[1]!);
    if (/^\s*end\s+([\w.]+)/.test(line)) spaces.pop();
    const thm =
      /^\s*(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+)?(?:theorem|lemma)\s+([\w.']+)/.exec(line);
    if (thm !== null) names.push([...spaces, thm[1]!].join("."));
  }
  return names;
};

/** The axioms Lean's `#print axioms` may list (FD-VER-016). */
export const ALLOWED_AXIOMS = ["propext", "Classical.choice", "Quot.sound"];

/** A Lean file that prints the axioms of each named theorem. */
export const axiomsProgram = (root: string, names: readonly string[]): string =>
  [`import ${root}`, ...names.map((n) => `#print axioms ${n}`)].join("\n");

/** Each theorem whose `#print axioms` output lists an axiom outside the three allowed (FD-VER-016). */
export const axiomFindings = (output: string): readonly SpecFinding[] => {
  const out: SpecFinding[] = [];
  for (const m of output.matchAll(/'([^']+)' depends on axioms: \[([^\]]*)\]/g)) {
    const axioms = m[2]!
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a !== "");
    for (const a of axioms)
      if (!ALLOWED_AXIOMS.includes(a))
        out.push({
          check: "FD-VER-016",
          file: "formal",
          line: 0,
          message: `${m[1]} depends on axiom ${a}`,
        });
  }
  return out;
};

/** A pull request that removes or changes a line of `formal/regressions.jsonl` fails; appending passes (FD-VER-022). */
export const regressionsAppendOnly = (base: string, head: string): readonly SpecFinding[] => {
  const b = base.split("\n").filter((l) => l !== "");
  const h = head.split("\n").filter((l) => l !== "");
  return b.flatMap((line, i) =>
    h[i] === line
      ? []
      : [
          {
            check: "FD-VER-022",
            file: "formal/regressions.jsonl",
            line: i + 1,
            message: "a regression line was removed or changed",
          },
        ],
  );
};

/**
 * A `V-PROOF` requirement counts toward a phase gate only while its theorem passes the formal gate and every
 * assumption test of its row passes on the same commit (FD-VER-018).
 */
export const proofCounts = (input: {
  readonly theoremPassed: boolean;
  readonly assumptionTests: readonly string[];
  readonly passingTests: ReadonlySet<string>;
}): boolean => input.theoremPassed && input.assumptionTests.every((t) => input.passingTests.has(t));

/** The prover versions `formal/tamarin-prover.version` pins: one `<tool> <x.y.z>` line per tool (FD-PROV-073). */
export interface TamarinPin {
  readonly tamarin: string;
  readonly maude: string;
}

/** The pin file's versions, or null unless it names exactly one release of each of `tamarin-prover` and `maude`. */
export const parseTamarinPin = (text: string): TamarinPin | null => {
  const versions = new Map<string, string>();
  for (const line of text.split("\n").filter((l) => l.trim() !== "")) {
    const m = /^(tamarin-prover|maude) (\d+\.\d+(?:\.\d+)?)\s*$/.exec(line);
    if (m === null || versions.has(m[1]!)) return null;
    versions.set(m[1]!, m[2]!);
  }
  const tamarin = versions.get("tamarin-prover");
  const maude = versions.get("maude");
  return tamarin === undefined || maude === undefined ? null : { tamarin, maude };
};

const TAMARIN_MODEL = "formal/provenance.spthy";

const proverFinding = (line: number, message: string): SpecFinding => ({
  check: "FD-PROV-073",
  file: TAMARIN_MODEL,
  line,
  message,
});

/** Each way `tamarin-prover --version` (stdout and stderr together) differs from the pin (FD-PROV-073). */
export const tamarinVersionFindings = (pin: TamarinPin, output: string): readonly SpecFinding[] => {
  const tamarin = /^tamarin-prover (\S+),/m.exec(output)?.[1];
  const maude = /checking version: (\S+?)\. OK\./.exec(output)?.[1];
  return [
    ...(tamarin === pin.tamarin
      ? []
      : [proverFinding(0, `tamarin-prover is ${tamarin ?? "missing"}; the pin is ${pin.tamarin}`)]),
    ...(maude === pin.maude
      ? []
      : [proverFinding(0, `maude is ${maude ?? "missing or rejected"}; the pin is ${pin.maude}`)]),
    ...(/checking installation: OK\./.test(output)
      ? []
      : [proverFinding(0, "the prover's installation check failed")]),
  ];
};

/** One lemma a `.spthy` theory declares: its name, its trace quantifier and its line. */
export interface SpthyLemma {
  readonly name: string;
  readonly kind: "all-traces" | "exists-trace";
  readonly line: number;
}

/** `.spthy` source with its comments blanked, line structure kept. */
const stripSpthyComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));

/** Every lemma a theory declares, in order; a lemma that names no quantifier is `all-traces`. */
export const spthyLemmas = (text: string): readonly SpthyLemma[] => {
  const code = stripSpthyComments(text);
  return [
    ...code.matchAll(/\blemma\s+(\w+)\s*(?:\[[^\]]*\])?\s*:\s*(exists-trace|all-traces)?/g),
  ].map((m) => ({
    name: m[1]!,
    kind: (m[2] as SpthyLemma["kind"] | undefined) ?? "all-traces",
    line: code.slice(0, m.index).split("\n").length,
  }));
};

/**
 * The `formal` job's Tamarin check (FD-PROV-073): every declared lemma has a `verified` result in the prover's summary,
 * the summary reports no failed wellformedness check, and an expected attack, a lemma named `*_attack`, is
 * `exists-trace`, so the attack trace the prover finds is the pass.
 */
export const tamarinFindings = (
  lemmas: readonly SpthyLemma[],
  output: string,
): readonly SpecFinding[] => {
  const at = output.lastIndexOf("summary of summaries:");
  if (at === -1) return [proverFinding(0, "the prover printed no summary")];
  const summary = output.slice(at);
  const results = new Map(
    [...summary.matchAll(/^\s+(\w+) \((all-traces|exists-trace)\): (.+)$/gm)].map((m) => [
      m[1]!,
      m[3]!.trim(),
    ]),
  );
  const out: SpecFinding[] = [];
  if (lemmas.length === 0) out.push(proverFinding(0, "the model declares no lemma"));
  const wellformedness = /WARNING: (\d+) wellformedness check/.exec(summary);
  if (wellformedness !== null)
    out.push(proverFinding(0, `${wellformedness[1]} wellformedness check(s) failed`));
  for (const lemma of lemmas) {
    const result = results.get(lemma.name);
    if (result === undefined) out.push(proverFinding(lemma.line, `${lemma.name} has no result`));
    else if (!result.startsWith("verified"))
      out.push(proverFinding(lemma.line, `${lemma.name} is ${result}, not verified`));
    if (lemma.name.endsWith("_attack") && lemma.kind !== "exists-trace")
      out.push(
        proverFinding(
          lemma.line,
          `${lemma.name} states an expected attack and is not exists-trace`,
        ),
      );
  }
  return out;
};
