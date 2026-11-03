// The `formal` job's checks over `formal/` (specs/verification.md FD-VER-014 to FD-VER-016) and the append-only rule
// of `formal/regressions.jsonl` (FD-VER-022). `scripts/formal-gate.ts` runs `lake build` and `#print axioms`.
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
