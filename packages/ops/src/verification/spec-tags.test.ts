import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allRequirements,
  countChecks,
  coverageReport,
  expandRanges,
  harnessEntries,
  harnessTagOf,
  parseFormalTable,
  parseMoved,
  parseRequirements,
  pinChecks,
  pinnedCommit,
  proseLines,
  provedChecks,
  repinMameko,
  specTags,
  type SpecTagsInput,
} from "./spec-tags.ts";

const ROOT = join(import.meta.dirname, "../../../..");
const tree = (dir: string): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".md")) out.set(relative(dir, p), readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
};
const specs = tree(join(ROOT, "specs"));
const input: SpecTagsInput = {
  specs,
  moved: readFileSync(join(ROOT, "specs/ids.moved.tsv"), "utf8"),
  baseSpecs: specs,
  mamekoSpecs: [...tree(join(ROOT, "vendor/mameko/specs")).values()],
  formal: new Map(),
};
const withSpec = (file: string, edit: (text: string) => string): SpecTagsInput => ({
  ...input,
  specs: new Map([...specs].map(([f, t]) => [f, f === file ? edit(t) : t])),
});
const checks = (i: SpecTagsInput) => specTags(i).map((f) => f.check);
const LINE = "- **FD-OPS-001** · phase 0 · `V-DEPLOY` `V-UNIT` — ";

describe("spec-tags", () => {
  it("[FD-VER-001] scans every spec file outside specs/adr/, ignoring fenced code blocks; the committed specs pass", () => {
    expect(specTags(input)).toEqual([]);
    expect(allRequirements(specs).length).toBeGreaterThan(700);
    expect(proseLines("a\n```\n- **FD-X-1** inside\n```\nb").map((l) => l.text)).toEqual([
      "a",
      "b",
    ]);
    const adr = new Map([...specs, ["adr/9999-x.md", "- **FD-broken line"]]);
    expect(specTags({ ...input, specs: adr })).toEqual([]);
  });

  it("[FD-VER-002] a `- **FD-` line outside the requirement form fails, naming file and line", () => {
    const r = parseRequirements("operability.md", "x\n- **FD-OPS-999** phase 0 — no separators");
    expect(r.findings).toEqual([
      {
        check: "FD-VER-002",
        file: "operability.md",
        line: 2,
        message: "not in the requirement form",
      },
    ]);
  });

  it("[FD-VER-003] a must sentence with no tag fails", () => {
    const i = withSpec("operability.md", (t) => t.replace(LINE, "- **FD-OPS-001** · phase 0 · — "));
    expect(checks(i)).toContain("FD-VER-003");
  });

  it("[FD-VER-004] an unknown or repeated tag fails", () => {
    expect(
      checks(
        withSpec("operability.md", (t) =>
          t.replace(LINE, "- **FD-OPS-001** · phase 0 · `V-FUZZ` — "),
        ),
      ),
    ).toContain("FD-VER-004");
    expect(
      checks(
        withSpec("operability.md", (t) =>
          t.replace(LINE, "- **FD-OPS-001** · phase 0 · `V-UNIT` `V-UNIT` — "),
        ),
      ),
    ).toContain("FD-VER-004");
  });

  it("[FD-VER-005] a requirement in another area's file fails", () => {
    const i = withSpec(
      "operability.md",
      (t) => `${t}\n- **FD-ARCH-099** · phase 0 · \`V-UNIT\` — The x must y.\n`,
    );
    expect(specTags(i).find((f) => f.check === "FD-VER-005")?.message).toBe(
      "FD-ARCH-099 belongs in architecture.md",
    );
  });

  it("[FD-VER-006] an ID on two lines, or on a line and in the moved table, fails naming every occurrence", () => {
    const dup = withSpec(
      "operability.md",
      (t) => `${t}\n${t.split("\n").find((l) => l.startsWith("- **FD-OPS-001**"))}\n`,
    );
    expect(specTags(dup).find((f) => f.check === "FD-VER-006")?.message).toMatch(
      /FD-OPS-001 occurs 2 times/,
    );
    const moved = { ...input, moved: `${input.moved}FD-OPS-001\tremoved\tno successor\n` };
    expect(checks(moved)).toContain("FD-VER-006");
  });

  it("[FD-VER-007] an ID removed from the head with no moved row fails", () => {
    const i = withSpec("operability.md", (t) =>
      t
        .split("\n")
        .filter((l) => !l.startsWith("- **FD-OPS-001**"))
        .join("\n"),
    );
    const found = specTags(i).filter((f) => f.check === "FD-VER-007");
    expect(found.map((f) => f.message)).toEqual(["FD-OPS-001 was removed with no moved row"]);
  });

  it("[FD-VER-008] a reference to an ID with neither a line nor a moved row fails, naming file and line", () => {
    const i = withSpec("roadmap.md", (t) => `${t}\nSee FD-OPS-998.\n`);
    expect(
      specTags(i)
        .filter((f) => f.check === "FD-VER-008")
        .map((f) => f.message),
    ).toEqual(["FD-OPS-998 has no requirement line or moved row"]);
  });

  it("[FD-VER-009] a coverage or phase count that differs from the lines fails", () => {
    const reqs = allRequirements(specs);
    const verification = specs.get("verification.md")!;
    const roadmap = specs.get("roadmap.md")!;
    expect(countChecks(reqs, verification, roadmap)).toEqual([]);
    const off = verification.replace(
      /^\| `OPS` \| (\d+) \|/m,
      (_m, n) => `| \`OPS\` | ${Number(n) + 1} |`,
    );
    expect(countChecks(reqs, off, roadmap).map((f) => f.message)).toContain(
      "OPS total: the table says 61, the lines count 60",
    );
    const ids = roadmap.replace("| `OPS` | 1 | 071 |", "| `OPS` | 1 | 072 |");
    expect(countChecks(reqs, verification, ids).map((f) => f.message)).toContain(
      "phase 1 OPS: the ID list differs from the lines",
    );
    expect(expandRanges("001–003, 007")).toEqual([1, 2, 3, 7]);
  });

  it("[FD-VER-010] [FD-VER-011] V-PROOF IDs match the formal table, and assumption tests carry V-CONF or V-SIM", () => {
    const rows = parseFormalTable(specs.get("verification.md")!);
    expect(rows.map((r) => r.property)).toContain("S8");
    const unlisted = withSpec("operability.md", (t) =>
      t.replace(
        "**FD-OPS-021** · phase 0 · `V-DEPLOY` `V-PROOF` `V-DIFF`",
        "**FD-OPS-021** · phase 0 · `V-DEPLOY` `V-DIFF`",
      ),
    );
    expect(checks(unlisted)).toContain("FD-VER-010");
    const assumption = withSpec("verification.md", (t) =>
      t.replace("| FD-AGT-009, FD-AGT-012", "| FD-OPS-001, FD-AGT-012"),
    );
    expect(checks(assumption)).toContain("FD-VER-011");
  });

  it("[FD-VER-012] maps bracketed test titles, Lean docstrings and Tamarin comments to IDs under their harness tag", () => {
    expect(harnessTagOf("packages/ops/src/tick.test.ts")).toBe("V-UNIT");
    expect(harnessTagOf("test/sim/fleet.test.ts")).toBe("V-SIM");
    expect(harnessTagOf("formal/FdFormal/Cache.lean")).toBe("V-PROOF");
    expect(harnessTagOf("packages/ops/test/deploy/pipeline.test.ts")).toBe("V-DEPLOY");
    expect(
      harnessEntries("packages/ops/test/deploy/pipeline.test.ts", 'it("[FD-OPS-010] x", () => {})'),
    ).toEqual([
      { id: "FD-OPS-010", tag: "V-DEPLOY", file: "packages/ops/test/deploy/pipeline.test.ts" },
    ]);
    expect(
      harnessEntries("packages/x/src/a.test.ts", 'it("[FD-OPS-053] x FD-OPS-054", () => {})'),
    ).toEqual([{ id: "FD-OPS-053", tag: "V-UNIT", file: "packages/x/src/a.test.ts" }]);
    expect(
      harnessEntries(
        "formal/A.lean",
        "/-- FD-AGT-016 FD-AGT-017 -/\ntheorem t : True := trivial",
      ).map((e) => e.id),
    ).toEqual(["FD-AGT-016", "FD-AGT-017"]);
    const report = coverageReport(
      allRequirements(specs).filter((r) => r.id === "FD-OPS-053" || r.id === "FD-OPS-071"),
      [{ id: "FD-OPS-053", tag: "V-UNIT", file: "x" }],
      0,
    );
    expect(report.get("V-UNIT")).toEqual([]);
  });

  it("[FD-VER-013] a theorem marked proved must exist in formal/ with every ID of its row in its docstring", () => {
    const rows = parseFormalTable(
      specs
        .get("verification.md")!
        .replace(
          "`StagedWrite.model_authored_protected_paths`, `StagedWrite.reject_whole_manifest` *planned*",
          "`StagedWrite.reject_whole_manifest` *proved*",
        ),
    );
    const s8 = rows.filter((r) => r.property === "S8");
    expect(provedChecks(s8, new Map()).map((f) => f.check)).toEqual(["FD-VER-013"]);
    const lean =
      "/-- FD-AGT-016 FD-AGT-017 FD-AGT-020 FD-LOCAL-094 -/\ntheorem reject_whole_manifest : True := trivial";
    expect(provedChecks(s8, new Map([["formal/FdFormal/StagedWrite.lean", lean]]))).toEqual([]);
  });

  it("[FD-VER-034] a moved row with the wrong columns, an unknown disposition or a repeated ID fails", () => {
    const { findings } = parseMoved(
      "fd_id\tdisposition\ttarget\nFD-A-001\tmoved\nFD-A-002\tgone\tx\nFD-A-003\tremoved\tr\nFD-A-003\tremoved\tr\n",
    );
    expect(findings.map((f) => f.line)).toEqual([2, 3, 5]);
  });

  it("[FD-VER-035] a moved row naming a mameko ID absent at the pin, or a profile row naming no profile line, fails", () => {
    const bad = {
      ...input,
      moved: input.moved.replace(/\tmoved\tMAMEKO-ARCH-013/, "\tmoved\tMAMEKO-ARCH-999"),
    };
    expect(checks(bad)).toContain("FD-VER-035");
    const profile = {
      ...input,
      moved: input.moved.replace(
        "FD-AGT-015\tprofile\tFD-PROF-046",
        "FD-AGT-015\tprofile\tFD-PROF-999",
      ),
    };
    expect(checks(profile)).toContain("FD-VER-035");
  });

  it("[FD-VER-036] a mameko link naming a commit other than the pin fails", () => {
    const i = withSpec(
      "roadmap.md",
      (t) =>
        `${t}\n[x](https://github.com/fractalboxdev/mameko/blob/aade0a5bf87e4c975b859b9d627a38e11951525b/specs/hosts.md)\n`,
    );
    expect(specTags(i).filter((f) => f.check === "FD-VER-036")).toHaveLength(1);
  });

  it("the mameko re-pin names one commit in the README pin and every mameko link, so neither pin check finds anything", () => {
    const commit = "c".repeat(40);
    const specs = new Map(
      [...input.specs].map(([file, text]) => [
        file,
        repinMameko(
          `${text}\n[x](https://github.com/fractalboxdev/mameko/tree/aade0a5bf87e4c975b859b9d627a38e11951525b/specs/)\n`,
          commit,
        ),
      ]),
    );
    expect(pinnedCommit(specs.get("README.md")!)).toBe(commit);
    expect(pinChecks(specs, commit)).toEqual([]);
    expect([...specs.values()].join("\n")).toContain(
      `github.com/fractalboxdev/mameko/tree/${commit}/specs/`,
    );
    expect(repinMameko("https://github.com/fractalboxdev/other/blob/abc123/x.md", commit)).toBe(
      "https://github.com/fractalboxdev/other/blob/abc123/x.md",
    );
  });

  it("[FD-VER-037] a new ID at or below its area's highest used number fails", () => {
    const i = withSpec(
      "operability.md",
      (t) => `${t}\n- **FD-OPS-018** · phase 0 · \`V-UNIT\` — The x must y.\n`,
    );
    expect(
      specTags(i)
        .filter((f) => f.check === "FD-VER-037")
        .map((f) => f.message),
    ).toEqual(["FD-OPS-018 reuses a number of OPS"]);
    const fresh = withSpec(
      "operability.md",
      (t) => `${t}\n- **FD-OPS-090** · phase 0 · \`V-UNIT\` — The x must y.\n`,
    );
    expect(checks(fresh)).not.toContain("FD-VER-037");
  });
});
