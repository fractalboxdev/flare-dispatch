// The provenance negative-test ledger (specs/provenance.md FD-PROV-072): the conformance suite holds a negative test
// for each acceptance check of the acceptance table and for each verifier rejection of FD-PROV-053 to FD-PROV-061, and
// a Tamarin lemma of `formal/provenance.spthy` counts toward the phase gate only while every check it assumes has that
// test. A negative test is a test in this package whose title cites the check's requirement and whose body asserts the
// check's rejection reason. The suite runs the ledger beside those tests, so a failing negative test fails the run the
// gate reads.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTANCE_REASONS, type AcceptanceReason } from "@fractalboxdev/flare-dispatch-cache";
import type { VerifyRejection } from "@fractalboxdev/flare-dispatch-fd/verify";
import { describe, expect, it } from "vitest";
import { proofCounts, spthyLemmas } from "../../ops/src/verification/formal.ts";
import { parseFormalTable } from "../../ops/src/verification/spec-tags.ts";

const ROOT = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/**
 * Acceptance checks with no negative test yet, each with the requirement that blocks it. Check 12 compares the model
 * list against gateway metering records the control plane does not keep yet, so no world can make it fail on a
 * mismatch rather than on `metering unavailable`.
 */
const OPEN_GAPS: ReadonlyMap<AcceptanceReason, string> = new Map([
  ["model-mismatch", "FD-PROV-024"],
]);

/** The rejection reason each verifier requirement's negative test asserts. */
const VERIFIER_REJECTIONS: Readonly<Record<string, VerifyRejection>> = {
  "FD-PROV-053": "policy-signature",
  "FD-PROV-054": "inclusion-proof",
  "FD-PROV-055": "witness-cosignature",
  "FD-PROV-056": "key-window",
  "FD-PROV-057": "device-window",
  "FD-PROV-058": "subject-digest",
  "FD-PROV-059": "tier",
  "FD-PROV-060": "tier",
  "FD-PROV-061": "tier",
};

const provenance = read("specs/provenance.md");
const requirementLines = [...provenance.matchAll(/^- \*\*(FD-PROV-(\d{3}))\*\* · (.*)$/gm)].map(
  (m) => ({ id: m[1]!, n: Number(m[2]), text: m[3]! }),
);

/** The acceptance table's reasons, in check order. */
const tableReasons = (() => {
  const section = provenance.slice(
    provenance.indexOf("### Acceptance"),
    provenance.indexOf("### ", provenance.indexOf("### Acceptance") + 1),
  );
  return [...section.matchAll(/^\| (\d+) \| .* \| `([a-z-]+)` \|$/gm)].map((m) => m[2]!);
})();

/** The requirement whose line names `reason` as the statement's rejection, for each acceptance reason. */
const acceptanceIds = new Map(
  ACCEPTANCE_REASONS.map((reason) => [
    reason,
    requirementLines
      .filter((r) => r.text.endsWith(`reject the statement with \`${reason}\`.`))
      .map((r) => r.id),
  ]),
);

const verifierIds = requirementLines.filter((r) => r.n >= 53 && r.n <= 61).map((r) => r.id);

/** Every test of this package other than the ledger: its title and the source up to the next test. */
const conformanceTests = (() => {
  const dir = join(import.meta.dirname);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts") && f !== "acceptance-ledger.test.ts")
    .flatMap((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      const starts = [...text.matchAll(/\b(?:it|test)(?:\.\w+)?\(\s*(["'`])((?:(?!\1).)*)\1/g)];
      return starts.map((m, i) => ({
        file,
        ids: new Set([...m[2]!.matchAll(/\[(FD-[A-Z]+-\d{3})\]/g)].map((x) => x[1]!)),
        body: text.slice(m.index, starts[i + 1]?.index ?? text.length),
      }));
    });
})();

/** A test citing `id` whose body asserts `reason` through `assertion`, however the formatter wraps the call. */
const hasNegative = (id: string, assertion: string, reason: string) => {
  const re = new RegExp(`${assertion.replace(/[.()]/g, "\\$&")}\\(\\s*"${reason}"\\s*,?\\s*\\)`);
  return conformanceTests.some((t) => t.ids.has(id) && re.test(t.body));
};
const hasAcceptanceNegative = (id: string, reason: string) => hasNegative(id, "rejected", reason);
const hasVerifierNegative = (id: string, reason: string) =>
  hasNegative(id, ".reason).toBe", reason);

/** The requirement ids of every check in the ledger whose negative test exists. */
const covered = new Set([
  ...ACCEPTANCE_REASONS.flatMap((reason) =>
    (acceptanceIds.get(reason) ?? []).filter((id) => hasAcceptanceNegative(id, reason)),
  ),
  ...verifierIds.filter((id) => hasVerifierNegative(id, VERIFIER_REJECTIONS[id]!)),
]);
const ledgerIds = new Set([...[...acceptanceIds.values()].flat(), ...verifierIds]);

describe("the provenance negative-test ledger", () => {
  it("[FD-PROV-072] enumerates one acceptance check per acceptance reason, in the acceptance table's order", () => {
    expect(tableReasons).toEqual([...ACCEPTANCE_REASONS]);
    for (const reason of ACCEPTANCE_REASONS)
      expect(acceptanceIds.get(reason), reason).toHaveLength(1);
  });

  it("[FD-PROV-072] holds a negative conformance test for each acceptance check, model-mismatch open until FD-PROV-024", () => {
    const missing = ACCEPTANCE_REASONS.filter(
      (reason) => !hasAcceptanceNegative(acceptanceIds.get(reason)![0]!, reason),
    );
    expect(missing).toEqual([...OPEN_GAPS.keys()]);
    for (const [reason, blocker] of OPEN_GAPS)
      expect(acceptanceIds.get(reason), reason).toEqual([blocker]);
  });

  it("[FD-PROV-072] holds a negative conformance test for each verifier rejection of FD-PROV-053 to FD-PROV-061", () => {
    expect(verifierIds).toEqual(Object.keys(VERIFIER_REJECTIONS));
    expect(verifierIds.filter((id) => !hasVerifierNegative(id, VERIFIER_REJECTIONS[id]!))).toEqual(
      [],
    );
  });

  it("[FD-PROV-072] counts a Tamarin lemma toward the phase gate only while every check it assumes has a negative test", () => {
    const model = read("formal/provenance.spthy");
    const rows = parseFormalTable(read("specs/verification.md"));
    const docs = new Map(
      [...model.matchAll(/\/\*((?:(?!\*\/)[\s\S])*)\*\/\s*lemma\s+(\w+)/g)].map((m) => [
        m[2]!,
        m[1]!.replace(/\n\s*\*\s?/g, " "),
      ]),
    );
    const assumed = new Set<string>();
    const lemmas = spthyLemmas(model).filter((l) => l.kind === "all-traces");
    expect(lemmas.length).toBeGreaterThan(0);
    for (const lemma of lemmas) {
      const row = rows.find((r) => r.theorems.some((t) => t.name === lemma.name));
      expect(row, `${lemma.name} has a formal property row`).toBeDefined();
      const checks = row!.assumptions.filter((id) => ledgerIds.has(id));
      // The model cites the same assumed checks the property row lists.
      const cited = /Assumed checks \(FD-PROV-072\): ([^.]*)\./.exec(docs.get(lemma.name) ?? "");
      expect(cited?.[1]?.split(", "), lemma.name).toEqual(checks);
      expect(
        proofCounts({ theoremPassed: true, assumptionTests: checks, passingTests: covered }),
        lemma.name,
      ).toBe(true);
      for (const id of checks) {
        const without = new Set([...covered].filter((c) => c !== id));
        expect(
          proofCounts({ theoremPassed: true, assumptionTests: checks, passingTests: without }),
          `${lemma.name} without ${id}`,
        ).toBe(false);
        assumed.add(id);
      }
    }
    // The gate row lists exactly the checks the lemmas assume, and none of them is an open gap.
    const gate = rows.find((r) => r.requirements.includes("FD-PROV-072"));
    expect(new Set(gate?.assumptions)).toEqual(assumed);
    for (const blocker of OPEN_GAPS.values()) expect(assumed.has(blocker)).toBe(false);
  });
});
