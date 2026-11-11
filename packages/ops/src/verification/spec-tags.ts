// The `spec-tags` check over FlareDispatch's requirement lines (specs/verification.md FD-VER-001 to FD-VER-013,
// FD-VER-034 to FD-VER-037). Every function here is pure over the files' text; `scripts/spec-tags.ts` reads the files,
// the base commit's specs and mameko's pinned specs and prints the findings.

/** One requirement line. */
export interface Requirement {
  readonly id: string;
  readonly area: string;
  readonly number: number;
  readonly phase: number;
  readonly tags: readonly string[];
  readonly sentence: string;
  readonly file: string;
  readonly line: number;
}

/** One failure of the check, naming what FD-VER-0NN requires it to name. */
export interface SpecFinding {
  readonly check: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/** The ten verification tags of specs/README.md § Verification tags. */
export const TAGS = [
  "V-UNIT",
  "V-CONF",
  "V-SIM",
  "V-REPLAY",
  "V-E2E-LOCAL",
  "V-DEPLOY",
  "V-LIVE",
  "V-MEASURE",
  "V-PROOF",
  "V-DIFF",
] as const;

const REQUIREMENT = /^- \*\*(FD-([A-Z]+)-(\d{3}))\*\* · phase ([0-4]) · ((?:`[^`]+`\s*)*)— (.+)$/;
const TAG = /`([^`]+)`/g;
const REFERENCE = /\bFD-([A-Z]+)-(\d{3})\b/g;

/** The lines of a Markdown file outside fenced code blocks, with their 1-based numbers (FD-VER-001). */
export const proseLines = (
  text: string,
): readonly { readonly line: number; readonly text: string }[] => {
  const out: { line: number; text: string }[] = [];
  let fenced = false;
  text.split("\n").forEach((t, i) => {
    if (/^\s*(```|~~~)/.test(t)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) out.push({ line: i + 1, text: t });
  });
  return out;
};

/** Every requirement line of one file, and a finding for each `- **FD-` line that is malformed (FD-VER-002). */
export const parseRequirements = (
  file: string,
  text: string,
): { readonly requirements: readonly Requirement[]; readonly findings: readonly SpecFinding[] } => {
  const requirements: Requirement[] = [];
  const findings: SpecFinding[] = [];
  for (const { line, text: t } of proseLines(text)) {
    if (!t.startsWith("- **FD-")) continue;
    const m = REQUIREMENT.exec(t);
    if (m === null) {
      findings.push({ check: "FD-VER-002", file, line, message: "not in the requirement form" });
      continue;
    }
    requirements.push({
      id: m[1]!,
      area: m[2]!,
      number: Number(m[3]),
      phase: Number(m[4]),
      tags: [...m[5]!.matchAll(TAG)].map((x) => x[1]!),
      sentence: m[6]!,
      file,
      line,
    });
  }
  return { requirements, findings };
};

/** The area table of specs/README.md: area to file. */
export const parseAreaTable = (readme: string): ReadonlyMap<string, string> => {
  const areas = new Map<string, string>();
  for (const { text } of proseLines(readme))
    for (const m of text.matchAll(/\|\s*`([A-Z]+)`\s*\|\s*([a-z/-]+\.md)\s*/g))
      areas.set(m[1]!, m[2]!);
  return areas;
};

/** Tag checks, area checks and the `must` rule over parsed requirements (FD-VER-003 to FD-VER-005). */
export const lineChecks = (
  requirements: readonly Requirement[],
  areas: ReadonlyMap<string, string>,
): readonly SpecFinding[] => {
  const out: SpecFinding[] = [];
  for (const r of requirements) {
    if (/\bmust\b/.test(r.sentence) && r.tags.length === 0)
      out.push({ check: "FD-VER-003", file: r.file, line: r.line, message: `${r.id} has no tag` });
    const seen = new Set<string>();
    for (const tag of r.tags) {
      if (!(TAGS as readonly string[]).includes(tag))
        out.push({
          check: "FD-VER-004",
          file: r.file,
          line: r.line,
          message: `${r.id} has unknown tag ${tag}`,
        });
      if (seen.has(tag))
        out.push({
          check: "FD-VER-004",
          file: r.file,
          line: r.line,
          message: `${r.id} has tag ${tag} twice`,
        });
      seen.add(tag);
    }
    const expected = areas.get(r.area);
    if (expected === undefined)
      out.push({
        check: "FD-VER-005",
        file: r.file,
        line: r.line,
        message: `${r.id}: area ${r.area} is not in the area table`,
      });
    else if (expected !== r.file)
      out.push({
        check: "FD-VER-005",
        file: r.file,
        line: r.line,
        message: `${r.id} belongs in ${expected}`,
      });
  }
  return out;
};

/** One row of `specs/ids.moved.tsv`. */
export interface MovedRow {
  readonly id: string;
  readonly disposition: string;
  readonly target: string;
  readonly line: number;
}

const DISPOSITIONS = ["moved", "profile", "merged", "removed"];

/** The moved-ID table's rows and a finding per malformed or repeated row (FD-VER-034). */
export const parseMoved = (
  text: string,
  file = "ids.moved.tsv",
): { readonly rows: readonly MovedRow[]; readonly findings: readonly SpecFinding[] } => {
  const rows: MovedRow[] = [];
  const findings: SpecFinding[] = [];
  const lines = text.split("\n");
  const header = lines[0]?.split("\t");
  if (header?.join("\t") !== "fd_id\tdisposition\ttarget")
    findings.push({
      check: "FD-VER-034",
      file,
      line: 1,
      message: "the header is not fd_id, disposition, target",
    });
  const seen = new Set<string>();
  lines.slice(1).forEach((l, i) => {
    if (l.trim() === "") return;
    const line = i + 2;
    const cols = l.split("\t");
    if (cols.length !== 3) {
      findings.push({ check: "FD-VER-034", file, line, message: `row has ${cols.length} columns` });
      return;
    }
    const [id, disposition, target] = cols as [string, string, string];
    if (!DISPOSITIONS.includes(disposition))
      findings.push({
        check: "FD-VER-034",
        file,
        line,
        message: `${id}: disposition ${disposition}`,
      });
    if (seen.has(id))
      findings.push({ check: "FD-VER-034", file, line, message: `${id} is named twice` });
    seen.add(id);
    rows.push({ id, disposition, target, line });
  });
  return { rows, findings };
};

/** Duplicate IDs, and IDs both on a line and in the moved table (FD-VER-006). */
export const duplicateChecks = (
  requirements: readonly Requirement[],
  moved: readonly MovedRow[],
): readonly SpecFinding[] => {
  const out: SpecFinding[] = [];
  const byId = new Map<string, Requirement[]>();
  for (const r of requirements) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  for (const [id, rs] of byId)
    if (rs.length > 1)
      out.push({
        check: "FD-VER-006",
        file: rs[0]!.file,
        line: rs[0]!.line,
        message: `${id} occurs ${rs.length} times: ${rs.map((r) => `${r.file}:${r.line}`).join(", ")}`,
      });
  for (const m of moved)
    if (byId.has(m.id))
      out.push({
        check: "FD-VER-006",
        file: "ids.moved.tsv",
        line: m.line,
        message: `${m.id} is a requirement line at ${byId.get(m.id)![0]!.file}:${byId.get(m.id)![0]!.line} and a moved row`,
      });
  return out;
};

/** Every `FD-<AREA>-NNN` reference under specs/ resolves to a line or a moved row (FD-VER-008). */
export const referenceChecks = (
  files: ReadonlyMap<string, string>,
  known: ReadonlySet<string>,
): readonly SpecFinding[] => {
  const out: SpecFinding[] = [];
  for (const [file, text] of files)
    text.split("\n").forEach((t, i) => {
      for (const m of t.matchAll(REFERENCE))
        if (!known.has(m[0]))
          out.push({
            check: "FD-VER-008",
            file,
            line: i + 1,
            message: `${m[0]} has no requirement line or moved row`,
          });
    });
  return out;
};

/** IDs on the base commit with no line on the head and no moved row (FD-VER-007). */
export const removalChecks = (
  baseIds: ReadonlySet<string>,
  headIds: ReadonlySet<string>,
  moved: readonly MovedRow[],
): readonly SpecFinding[] => {
  const movedIds = new Set(moved.map((m) => m.id));
  return [...baseIds]
    .filter((id) => !headIds.has(id) && !movedIds.has(id))
    .sort()
    .map((id) => ({
      check: "FD-VER-007",
      file: "specs",
      line: 0,
      message: `${id} was removed with no moved row`,
    }));
};

/**
 * A new ID at or below the highest number its area has used, on the base's lines or in the moved table, reuses a
 * number (FD-VER-037).
 */
export const reuseChecks = (
  base: readonly Requirement[],
  head: readonly Requirement[],
  moved: readonly MovedRow[],
): readonly SpecFinding[] => {
  const baseIds = new Set(base.map((r) => r.id));
  const highest = new Map<string, number>();
  const bump = (area: string, n: number) => highest.set(area, Math.max(highest.get(area) ?? 0, n));
  for (const r of base) bump(r.area, r.number);
  for (const m of moved) {
    const x = /^FD-([A-Z]+)-(\d{3})$/.exec(m.id);
    if (x !== null) bump(x[1]!, Number(x[2]));
  }
  return head
    .filter((r) => !baseIds.has(r.id) && r.number <= (highest.get(r.area) ?? 0))
    .map((r) => ({
      check: "FD-VER-037",
      file: r.file,
      line: r.line,
      message: `${r.id} reuses a number of ${r.area}`,
    }));
};

/** Moved rows whose target has no requirement line: mameko's at the pin, or profile.md's (FD-VER-035). */
export const targetChecks = (
  moved: readonly MovedRow[],
  mamekoIds: ReadonlySet<string>,
  profileIds: ReadonlySet<string>,
): readonly SpecFinding[] => {
  const out: SpecFinding[] = [];
  for (const m of moved) {
    const targets = m.target.split(/[,\s]+/).filter((t) => t !== "");
    if (m.disposition === "moved")
      for (const t of targets)
        if (!mamekoIds.has(t))
          out.push({
            check: "FD-VER-035",
            file: "ids.moved.tsv",
            line: m.line,
            message: `${m.id}: ${t} has no requirement line at the pin`,
          });
    if (m.disposition === "profile")
      for (const t of targets)
        if (!profileIds.has(t))
          out.push({
            check: "FD-VER-035",
            file: "ids.moved.tsv",
            line: m.line,
            message: `${m.id}: ${t} has no line in profile.md`,
          });
  }
  return out;
};

/** The mameko requirement IDs of a set of mameko spec files. */
export const mamekoRequirementIds = (files: Iterable<string>): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const text of files)
    for (const m of text.matchAll(/^- \*\*(MAMEKO-[A-Z]+-\d{3})\*\*/gm)) ids.add(m[1]!);
  return ids;
};

/** The commit specs/README.md § Depends on mameko pins. */
export const pinnedCommit = (readme: string): string | null =>
  /depends on mameko at commit `([0-9a-f]{40})`/.exec(readme)?.[1] ?? null;

/** Every link into mameko's repository that names another commit (FD-VER-036). */
export const pinChecks = (
  files: ReadonlyMap<string, string>,
  pin: string,
): readonly SpecFinding[] => {
  const out: SpecFinding[] = [];
  for (const [file, text] of files)
    text.split("\n").forEach((t, i) => {
      for (const m of t.matchAll(
        /github\.com\/fractalboxdev\/mameko\/(?:blob|tree)\/([0-9a-f]+)\//g,
      ))
        if (m[1] !== pin)
          out.push({
            check: "FD-VER-036",
            file,
            line: i + 1,
            message: `mameko link names ${m[1]}, not ${pin}`,
          });
    });
  return out;
};

/** The requirement count per area, phase and tag. */
export interface Counts {
  readonly byPhase: ReadonlyMap<number, { total: number; tags: Record<string, number> }>;
  readonly byArea: ReadonlyMap<
    string,
    { total: number; phases: number[]; tags: Record<string, number> }
  >;
}

export const countRequirements = (requirements: readonly Requirement[]): Counts => {
  const byPhase = new Map<number, { total: number; tags: Record<string, number> }>();
  const byArea = new Map<
    string,
    { total: number; phases: number[]; tags: Record<string, number> }
  >();
  const empty = () => Object.fromEntries(TAGS.map((t) => [t, 0])) as Record<string, number>;
  for (const r of requirements) {
    const p = byPhase.get(r.phase) ?? { total: 0, tags: empty() };
    const a = byArea.get(r.area) ?? { total: 0, phases: [0, 0, 0, 0, 0], tags: empty() };
    p.total++;
    a.total++;
    a.phases[r.phase]!++;
    for (const t of r.tags) {
      if (t in p.tags) p.tags[t]!++;
      if (t in a.tags) a.tags[t]!++;
    }
    byPhase.set(r.phase, p);
    byArea.set(r.area, a);
  }
  return { byPhase, byArea };
};

const cells = (row: string) =>
  row
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim().replace(/`/g, ""));

/** Expands an ID-range list such as `001–005, 007` into numbers. */
export const expandRanges = (list: string): readonly number[] =>
  list.split(",").flatMap((part) => {
    const [a, b] = part
      .trim()
      .split(/[–-]/)
      .map(Number);
    if (a === undefined || Number.isNaN(a)) return [];
    if (b === undefined || Number.isNaN(b)) return [a];
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });

/** The coverage tables of verification.md and the phase tables of roadmap.md against the computed counts (FD-VER-009). */
export const countChecks = (
  requirements: readonly Requirement[],
  verification: string,
  roadmap: string,
): readonly SpecFinding[] => {
  const out: SpecFinding[] = [];
  const counts = countRequirements(requirements);
  const lines = verification.split("\n");
  const tableAfter = (heading: string, src: readonly string[]) => {
    const at = src.findIndex((l) => l.trim() === heading);
    if (at === -1) return [];
    const rows: { line: number; cells: string[] }[] = [];
    for (let i = at + 1; i < src.length; i++) {
      const l = src[i]!;
      if (l.startsWith("|")) {
        if (!/^\|\s*-/.test(l)) rows.push({ line: i + 1, cells: cells(l) });
      } else if (rows.length > 0) break;
    }
    return rows.slice(1);
  };
  const mismatch = (file: string, line: number, what: string, table: number, computed: number) => {
    if (table !== computed)
      out.push({
        check: "FD-VER-009",
        file,
        line,
        message: `${what}: the table says ${table}, the lines count ${computed}`,
      });
  };
  for (const row of tableAfter("**By phase**", lines)) {
    const [phase, total, ...tags] = row.cells;
    const all = phase === "All";
    const computedTotal = all
      ? requirements.length
      : (counts.byPhase.get(Number(phase))?.total ?? 0);
    mismatch("verification.md", row.line, `phase ${phase} total`, Number(total), computedTotal);
    TAGS.forEach((tag, i) => {
      const computed = all
        ? requirements.filter((r) => r.tags.includes(tag)).length
        : (counts.byPhase.get(Number(phase))?.tags[tag] ?? 0);
      mismatch("verification.md", row.line, `phase ${phase} ${tag}`, Number(tags[i]), computed);
    });
  }
  for (const row of tableAfter("**By area**", lines)) {
    const [area, total, phases, ...tags] = row.cells;
    const a = counts.byArea.get(area!);
    mismatch("verification.md", row.line, `${area} total`, Number(total), a?.total ?? 0);
    phases!
      .split("·")
      .forEach((p, i) =>
        mismatch("verification.md", row.line, `${area} phase ${i}`, Number(p), a?.phases[i] ?? 0),
      );
    TAGS.forEach((tag, i) =>
      mismatch("verification.md", row.line, `${area} ${tag}`, Number(tags[i]), a?.tags[tag] ?? 0),
    );
  }
  const road = roadmap.split("\n");
  road.forEach((l, i) => {
    const phaseRow = /^\| ([0-4]) \|/.exec(l);
    if (phaseRow !== null) {
      const c = cells(l);
      mismatch(
        "roadmap.md",
        i + 1,
        `phase ${phaseRow[1]} requirements`,
        Number(c[2]),
        counts.byPhase.get(Number(phaseRow[1]))?.total ?? 0,
      );
    }
  });
  let phase: number | null = null;
  road.forEach((l, i) => {
    const heading = /^## Phase ([0-4])/.exec(l);
    if (heading !== null) phase = Number(heading[1]);
    const closes = /^\*\*Closes\*\* (\d+) requirements/.exec(l);
    if (closes !== null && phase !== null)
      mismatch(
        "roadmap.md",
        i + 1,
        `phase ${phase} closes`,
        Number(closes[1]),
        counts.byPhase.get(phase)?.total ?? 0,
      );
    const areaRow = /^\| `([A-Z]+)` \| (\d+) \| ([^|]+) \|$/.exec(l);
    if (areaRow !== null && phase !== null) {
      const area = areaRow[1]!;
      const computed = requirements
        .filter((r) => r.area === area && r.phase === phase)
        .map((r) => r.number)
        .sort((a, b) => a - b);
      mismatch("roadmap.md", i + 1, `phase ${phase} ${area}`, Number(areaRow[2]), computed.length);
      const listed = [...expandRanges(areaRow[3]!)].sort((a, b) => a - b);
      if (listed.join(",") !== computed.join(","))
        out.push({
          check: "FD-VER-009",
          file: "roadmap.md",
          line: i + 1,
          message: `phase ${phase} ${area}: the ID list differs from the lines`,
        });
    }
  });
  return out;
};

/** The formal property table's rows: requirements, theorem names with their status, and assumption-test IDs. */
export interface FormalRow {
  readonly property: string;
  readonly requirements: readonly string[];
  readonly theorems: readonly {
    readonly name: string;
    readonly status: "proved" | "planned" | "cited";
  }[];
  readonly assumptions: readonly string[];
  readonly line: number;
}

export const parseFormalTable = (verification: string): readonly FormalRow[] => {
  const lines = verification.split("\n");
  const at = lines.findIndex((l) => l.startsWith("| Property | Statement | Requirements"));
  const rows: FormalRow[] = [];
  for (let i = at + 2; at !== -1 && i < lines.length && lines[i]!.startsWith("|"); i++) {
    const raw = lines[i]!.split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const ids = (s: string) => [...s.matchAll(REFERENCE)].map((m) => m[0]);
    const theorems = [
      ...raw[3]!.matchAll(/`([^`]+)`(?:\s*\([^)]*\))?\s*(?:\*(proved|planned)\*)?/g),
    ].map((m): FormalRow["theorems"][number] => ({
      name: m[1]!,
      status: (m[2] as "proved" | "planned" | undefined) ?? "cited",
    }));
    rows.push({
      property: raw[0]!,
      requirements: ids(raw[2]!),
      theorems,
      assumptions: ids(raw[4]!),
      line: i + 1,
    });
  }
  return rows;
};

/** V-PROOF IDs against the table, and assumption tests carrying V-CONF or V-SIM (FD-VER-010, FD-VER-011). */
export const formalTableChecks = (
  requirements: readonly Requirement[],
  rows: readonly FormalRow[],
): readonly SpecFinding[] => {
  const out: SpecFinding[] = [];
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const listed = new Set(rows.flatMap((r) => r.requirements));
  for (const r of requirements)
    if (r.tags.includes("V-PROOF") && !listed.has(r.id))
      out.push({
        check: "FD-VER-010",
        file: r.file,
        line: r.line,
        message: `${r.id} carries V-PROOF and is in no formal property row`,
      });
  for (const row of rows) {
    for (const id of row.requirements)
      if (byId.get(id)?.tags.includes("V-PROOF") !== true)
        out.push({
          check: "FD-VER-010",
          file: "verification.md",
          line: row.line,
          message: `${id} in ${row.property} does not carry V-PROOF`,
        });
    for (const id of row.assumptions) {
      const tags = byId.get(id)?.tags ?? [];
      if (!tags.includes("V-CONF") && !tags.includes("V-SIM"))
        out.push({
          check: "FD-VER-011",
          file: "verification.md",
          line: row.line,
          message: `assumption test ${id} carries neither V-CONF nor V-SIM`,
        });
    }
  }
  return out;
};

/** One harness entry: an ID a test title, Lean docstring or Tamarin comment names, under its harness's tag. */
export interface HarnessEntry {
  readonly id: string;
  readonly tag: string;
  readonly file: string;
}

/** The harness tag of a file by the directory it lives in (specs/verification.md § Harness catalog). */
export const harnessTagOf = (path: string): string | null => {
  if (path.startsWith("formal/")) return "V-PROOF";
  if (/(^|\/)test\/sim\//.test(path)) return "V-SIM";
  if (/(^|\/)test\/replay\//.test(path)) return "V-REPLAY";
  if (/(^|\/)test\/e2e-local\//.test(path)) return "V-E2E-LOCAL";
  if (/(^|\/)test\/diff\//.test(path)) return "V-DIFF";
  if (/(^|\/)test\/deploy\//.test(path)) return "V-DEPLOY";
  if (path.startsWith("packages/conformance/")) return "V-CONF";
  if (path.endsWith(".test.ts")) return "V-UNIT";
  return null;
};

const BRACKETED = /\[(FD-[A-Z]+-\d{3})\]/g;

/** The entries one file holds: bracketed IDs in test titles, Lean docstrings or Tamarin comments (FD-VER-012). */
export const harnessEntries = (path: string, text: string): readonly HarnessEntry[] => {
  const tag = harnessTagOf(path);
  if (tag === null) return [];
  const sources: string[] = [];
  if (path.endsWith(".ts"))
    for (const m of text.matchAll(/\b(?:it|test)(?:\.\w+)?\(\s*(["'`])((?:(?!\1).)*)\1/g))
      sources.push(m[2]!);
  else if (path.endsWith(".lean"))
    for (const m of text.matchAll(/\/--([\s\S]*?)-\//g)) sources.push(m[1]!);
  else if (path.endsWith(".spthy"))
    for (const m of text.matchAll(/\/\*([\s\S]*?)\*\/|\/\/(.*)/g)) sources.push(m[1] ?? m[2] ?? "");
  const out: HarnessEntry[] = [];
  for (const s of sources)
    for (const m of s.matchAll(path.endsWith(".ts") ? BRACKETED : REFERENCE))
      out.push({ id: path.endsWith(".ts") ? m[1]! : m[0], tag, file: path });
  return out;
};

/** Per tag, each requirement of the current phase or lower with no entry under that tag (FD-VER-012). */
export const coverageReport = (
  requirements: readonly Requirement[],
  entries: readonly HarnessEntry[],
  phase: number,
): ReadonlyMap<string, readonly string[]> => {
  const have = new Set(entries.map((e) => `${e.tag} ${e.id}`));
  const report = new Map<string, string[]>();
  for (const tag of TAGS) report.set(tag, []);
  for (const r of requirements)
    if (r.phase <= phase)
      for (const t of r.tags) if (!have.has(`${t} ${r.id}`)) report.get(t)?.push(r.id);
  return report;
};

/** A theorem the table marks proved that `formal/` lacks, or whose docstring misses an ID of its row (FD-VER-013). */
export const provedChecks = (
  rows: readonly FormalRow[],
  formal: ReadonlyMap<string, string>,
): readonly SpecFinding[] => {
  const out: SpecFinding[] = [];
  for (const row of rows)
    for (const t of row.theorems.filter((x) => x.status === "proved")) {
      const short = t.name.split(".").at(-1)!;
      const doc = [...formal.values()]
        .flatMap((text) => [
          ...text.matchAll(
            new RegExp(`/--([\\s\\S]*?)-/\\s*(?:theorem|lemma)\\s+(?:[\\w.]*\\.)?${short}\\b`, "g"),
          ),
        ])
        .map((m) => m[1]!)[0];
      const missing =
        doc === undefined ? row.requirements : row.requirements.filter((id) => !doc.includes(id));
      if (doc === undefined || missing.length > 0)
        out.push({
          check: "FD-VER-013",
          file: "verification.md",
          line: row.line,
          message:
            doc === undefined
              ? `${t.name} is marked proved and formal/ holds no such theorem`
              : `${t.name}'s docstring lacks ${missing.join(", ")}`,
        });
    }
  return out;
};

/** The inputs of one run of the check. */
export interface SpecTagsInput {
  /** Every `.md` under specs/ by its path relative to specs/, ADRs included. */
  readonly specs: ReadonlyMap<string, string>;
  readonly moved: string;
  /** The base commit's spec files, for FD-VER-007 and FD-VER-037; null on a push with no base. */
  readonly baseSpecs: ReadonlyMap<string, string> | null;
  /** mameko's spec files at the pinned commit. */
  readonly mamekoSpecs: Iterable<string>;
  /** `formal/` files by path. */
  readonly formal: ReadonlyMap<string, string>;
}

const requirementFiles = (specs: ReadonlyMap<string, string>) =>
  [...specs].filter(([f]) => f.endsWith(".md") && !f.startsWith("adr/"));

/** Every finding of the check; empty means it passes. */
export const specTags = (input: SpecTagsInput): readonly SpecFinding[] => {
  const findings: SpecFinding[] = [];
  const parsed = requirementFiles(input.specs).map(([f, text]) => parseRequirements(f, text));
  const requirements = parsed.flatMap((p) => p.requirements).filter((r) => r.file !== "README.md");
  findings.push(...parsed.flatMap((p) => p.findings).filter((f) => f.file !== "README.md"));
  const readme = input.specs.get("README.md") ?? "";
  findings.push(...lineChecks(requirements, parseAreaTable(readme)));
  const moved = parseMoved(input.moved);
  findings.push(...moved.findings, ...duplicateChecks(requirements, moved.rows));
  const known = new Set([...requirements.map((r) => r.id), ...moved.rows.map((m) => m.id)]);
  findings.push(...referenceChecks(input.specs, known));
  const profileIds = new Set(requirements.filter((r) => r.area === "PROF").map((r) => r.id));
  findings.push(...targetChecks(moved.rows, mamekoRequirementIds(input.mamekoSpecs), profileIds));
  const pin = pinnedCommit(readme);
  if (pin === null)
    findings.push({
      check: "FD-VER-036",
      file: "README.md",
      line: 0,
      message: "README.md pins no mameko commit",
    });
  else findings.push(...pinChecks(input.specs, pin));
  if (input.baseSpecs !== null) {
    const base = requirementFiles(input.baseSpecs)
      .flatMap(([f, text]) => parseRequirements(f, text).requirements)
      .filter((r) => r.file !== "README.md");
    findings.push(
      ...removalChecks(
        new Set(base.map((r) => r.id)),
        new Set(requirements.map((r) => r.id)),
        moved.rows,
      ),
      ...reuseChecks(base, requirements, moved.rows),
    );
  }
  findings.push(
    ...countChecks(
      requirements,
      input.specs.get("verification.md") ?? "",
      input.specs.get("roadmap.md") ?? "",
    ),
  );
  const rows = parseFormalTable(input.specs.get("verification.md") ?? "");
  findings.push(...formalTableChecks(requirements, rows), ...provedChecks(rows, input.formal));
  return findings;
};

/** The requirement lines of a spec set, for the coverage report and the phase gate. */
export const allRequirements = (specs: ReadonlyMap<string, string>): readonly Requirement[] =>
  requirementFiles(specs)
    .flatMap(([f, text]) => parseRequirements(f, text).requirements)
    .filter((r) => r.file !== "README.md");
