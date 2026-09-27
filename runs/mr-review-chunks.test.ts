// Unit tests for the mr-review chunk planner (map step of the large-MR review).

import { describe, expect, it } from "vitest";
import { addedContextFor, buildDiffMap, fileSignal, planChunks, splitDiffFiles } from "./mr-review-chunks";

const fileDiff = (path: string, hunks: number, linesPerHunk = 5, width = 40): string => {
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  for (let h = 0; h < hunks; h++) {
    out.push(`@@ -${h * 100 + 1},${linesPerHunk} +${h * 100 + 1},${linesPerHunk} @@`);
    for (let l = 0; l < linesPerHunk; l++) out.push(`+${"x".repeat(width)} h${h} l${l}`);
  }
  return `${out.join("\n")}\n`;
};

describe("splitDiffFiles", () => {
  it("splits a unified diff into one entry per file, keeping the text byte-for-byte", () => {
    const diff = fileDiff("a.ts", 1) + fileDiff("b.md", 2);
    const files = splitDiffFiles(diff);
    expect(files.map((f) => f.path)).toEqual(["a.ts", "b.md"]);
    expect(files.map((f) => f.text).join("")).toBe(diff);
  });
});

describe("fileSignal", () => {
  it("ranks source above config above docs above generated files", () => {
    expect(fileSignal("src/app.ts")).toBeGreaterThan(fileSignal("config/app.json"));
    expect(fileSignal("config/app.json")).toBeGreaterThan(fileSignal("docs/adr/0001.md"));
    expect(fileSignal("docs/adr/0001.md")).toBeGreaterThan(fileSignal("pnpm-lock.yaml"));
    expect(fileSignal("docs/adr/0001.md")).toBeGreaterThan(fileSignal("web/dist/app.min.js"));
    expect(fileSignal(".gitlab-ci.yml")).toBe(fileSignal("src/app.ts"));
  });
});

describe("planChunks", () => {
  it("packs small files into one chunk and reports nothing unreviewed", () => {
    const diff = fileDiff("a.ts", 1) + fileDiff("b.ts", 1);
    const plan = planChunks(diff, { maxChars: 10_000, maxChunks: 16 });
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]!.paths).toEqual(["a.ts", "b.ts"]);
    expect(plan.notReviewed).toEqual([]);
  });

  it("never truncates: every byte of every file lands in some chunk when under the cap", () => {
    const diff = fileDiff("big.ts", 40) + fileDiff("docs/x.md", 30) + fileDiff("c.ts", 2);
    const plan = planChunks(diff, { maxChars: 3_000, maxChunks: 100, maxHunkChars: 3_000 });
    for (const c of plan.chunks) expect(c.text.length).toBeLessThanOrEqual(3_000);
    const hunkLines = diff.split("\n").filter((l) => l.startsWith("+x"));
    const covered = plan.chunks.flatMap((c) => c.text.split("\n")).filter((l) => l.startsWith("+x"));
    expect(new Set(covered)).toEqual(new Set(hunkLines));
    expect(plan.notReviewed).toEqual([]);
  });

  it("splits a big file by hunk and repeats the file header in every piece", () => {
    const plan = planChunks(fileDiff("big.ts", 20), { maxChars: 1_500, maxChunks: 100, maxHunkChars: 1_500 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    for (const c of plan.chunks) {
      expect(c.text.startsWith("diff --git a/big.ts b/big.ts\n")).toBe(true);
      expect(c.paths).toEqual(["big.ts"]);
    }
  });

  it("splits a single hunk larger than the chunk size by lines", () => {
    const plan = planChunks(fileDiff("one.ts", 1, 200), { maxChars: 2_000, maxChunks: 100, maxHunkChars: 2_000 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    for (const c of plan.chunks) expect(c.text.length).toBeLessThanOrEqual(2_000);
  });

  it("beyond the chunk cap reviews the highest-signal files first and lists the rest", () => {
    const diff = fileDiff("docs/big.md", 10) + fileDiff("pnpm-lock.yaml", 10) + fileDiff("src/core.ts", 10);
    const plan = planChunks(diff, { maxChars: 700, maxChunks: 3, maxHunkChars: 700 });
    expect(plan.chunks).toHaveLength(3);
    expect(plan.chunks[0]!.paths).toEqual(["src/core.ts"]);
    const listed = plan.notReviewed.map((n) => n.path);
    expect(listed).toContain("pnpm-lock.yaml");
    expect(listed).toContain("docs/big.md");
    for (const n of plan.notReviewed) expect(n.reason).toMatch(/chunk cap \(3\)/);
  });

  it("marks a file whose later hunks fell past the cap as partially reviewed", () => {
    const plan = planChunks(fileDiff("src/huge.ts", 30), { maxChars: 800, maxChunks: 2, maxHunkChars: 800 });
    expect(plan.chunks).toHaveLength(2);
    expect(plan.notReviewed).toEqual([
      { path: "src/huge.ts", reason: expect.stringMatching(/^partially reviewed/) },
    ]);
  });

  it("a big section with no hunk marker still repeats its header line in every piece", () => {
    const text = `diff --git a/bin.dat b/bin.dat\n${Array.from({ length: 200 }, (_, i) => `index line ${i} ${"z".repeat(30)}`).join("\n")}\n`;
    const plan = planChunks(text, { maxChars: 1_000, maxChunks: 100, maxHunkChars: 1_000 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    for (const c of plan.chunks) expect(c.text.startsWith("diff --git a/bin.dat b/bin.dat\n")).toBe(true);
  });

  it("an empty diff yields no chunks", () => {
    expect(planChunks("", { maxChars: 1_000, maxChunks: 4 })).toEqual({ chunks: [], notReviewed: [] });
  });
});

// Atomos !304 (2026-09-27): one big `.gitlab-ci.yml` hunk removed eight guard
// jobs and re-added them as `run_check` lines inside a new `checks` job. The
// line split put the removal in one chunk and the replacement in another, so
// a reviewer reported "flare-encrypt-pin guard removed with no replacement".
const splitHunkCi = (): string => {
  const body: string[] = [];
  const guards = Array.from({ length: 8 }, (_, i) => (i === 3 ? "flare-encrypt-pin" : `guard-${i}`));
  for (const g of guards) {
    body.push(`-${g}:`, "-  stage: check", "-  script:", `-    - scripts/verify-${g}.sh`, "-");
  }
  for (let j = 0; j < 100; j++) body.push(` build-${j}:`, "   stage: build", `   script: [make build-${j}, echo ${"y".repeat(60)}]`, " ");
  body.push("+checks:", "+  stage: check", "+  script:");
  for (const g of guards) body.push(`+    - run_check ${g} scripts/verify-${g}.sh`);
  body.push("+", "+checks:code:", "+  stage: check", "+  script: [pnpm lint]");
  return [
    "diff --git a/.gitlab-ci.yml b/.gitlab-ci.yml",
    "--- a/.gitlab-ci.yml",
    "+++ b/.gitlab-ci.yml",
    "@@ -200,300 +200,280 @@ stages:",
    ...body,
    "",
  ].join("\n");
};

describe("planChunks — a big hunk stays whole", () => {
  it("keeps a removal and its replacement in the same chunk when the hunk is under the hunk cap", () => {
    const diff = splitHunkCi();
    expect(diff.length).toBeGreaterThan(10_000);
    const plan = planChunks(diff, { maxChars: 10_000, maxChunks: 16 });
    const removal = plan.chunks.filter((c) => c.text.includes("-flare-encrypt-pin:"));
    expect(removal).toHaveLength(1);
    expect(removal[0]!.text).toContain("+    - run_check flare-encrypt-pin scripts/verify-flare-encrypt-pin.sh");
    expect(removal[0]!.text).toContain("+checks:code:");
  });

  it("keeps a whole file up to the hunk cap in one chunk, even when the removal and the replacement are different hunks", () => {
    const hunks = splitHunkCi().split(/^(?=@@)/m);
    const second = "@@ -900,3 +880,3 @@ deploy:\n-  when: manual\n+  when: on_success\n   stage: deploy\n";
    const diff = hunks[0]! + second + hunks[1]!;
    const plan = planChunks(diff, { maxChars: 10_000, maxChunks: 16 });
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]!.text).toBe(diff);
  });

  it("past the file cap, a hunk under the hunk cap still goes whole into a chunk of its own", () => {
    const big = splitHunkCi();
    const hunk = big.slice(big.search(/^@@/m));
    const extra = "@@ -900,3 +880,3 @@ deploy:\n-  when: manual\n+  when: on_success\n   stage: deploy\n".repeat(20);
    const plan = planChunks(big + extra, { maxChars: 10_000, maxChunks: 16, maxHunkChars: big.length + 100 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.chunks.filter((c) => c.text.includes(hunk))).toHaveLength(1);
  });

  it("splits a hunk above the hunk cap at blank-line / top-level-key boundaries only", () => {
    const diff = splitHunkCi();
    const plan = planChunks(diff, { maxChars: 3_000, maxChunks: 50, maxHunkChars: 4_000 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    for (const c of plan.chunks) {
      expect(c.text.length).toBeLessThanOrEqual(4_000 + 200);
      const lines = c.text.split("\n").slice(3).filter((l) => l !== "");
      // No piece starts mid-block: the first body line is a hunk header, a
      // top-level key or a blank-ish line.
      expect(lines[0]).toMatch(/^(@@|[-+ ]($|[^\s]))/);
    }
  });
});

describe("buildDiffMap", () => {
  it("lists every file with its hunk headers and the removed/added top-level keys, and flags a removed name that reappears", () => {
    const map = buildDiffMap(splitHunkCi() + fileDiff("src/a.ts", 1));
    expect(map).toContain(".gitlab-ci.yml");
    expect(map).toContain("@@ -200,300 +200,280 @@");
    expect(map).toMatch(/removed:.*flare-encrypt-pin/);
    expect(map).toMatch(/added:.*checks:code/);
    expect(map).toMatch(/flare-encrypt-pin.*still in added lines/);
    expect(map).toContain("src/a.ts");
  });

  it("caps its size", () => {
    const many = Array.from({ length: 400 }, (_, i) => fileDiff(`src/f${i}.ts`, 3)).join("");
    expect(buildDiffMap(many, 4_000).length).toBeLessThanOrEqual(4_000);
  });
});

describe("cross-chunk names match whole tokens only", () => {
  it("does not treat a removed `lint` as still present because `prelint` was added", () => {
    const d = [
      "diff --git a/ci.yml b/ci.yml",
      "--- a/ci.yml",
      "+++ b/ci.yml",
      "@@ -1,3 +1,3 @@",
      "-lint:",
      "-  script: [pnpm lint]",
      "+build:",
      "+  script: [pnpm prelint]",
      "",
    ].join("\n");
    expect(buildDiffMap(d)).not.toMatch(/lint still in added lines/);
    expect(addedContextFor("the `lint` job was removed", [d], 2_000)).toBe("");
  });
});

describe("boundary split", () => {
  it("never starts a piece on an indented line (`+    script:` is not a boundary)", () => {
    const body: string[] = [];
    for (let j = 0; j < 80; j++) body.push(`+job-${j}:`, "+  stage: check", "+  script:", ...Array.from({ length: 6 }, (_, k) => `+    - step ${j}.${k} ${"z".repeat(30)}`));
    const diff = ["diff --git a/c.yml b/c.yml", "--- a/c.yml", "+++ b/c.yml", "@@ -0,0 +1,720 @@", ...body, ""].join("\n");
    const plan = planChunks(diff, { maxChars: 2_000, maxChunks: 100, maxHunkChars: 2_000 });
    expect(plan.chunks.length).toBeGreaterThan(5);
    for (const c of plan.chunks.slice(1)) expect(c.text.split("\n")[3]).toMatch(/^\+job-\d+:$/);
  });
});

describe("addedContextFor", () => {
  it("finds the post-change lines for a name the finding says was removed, in any chunk", () => {
    const plan = planChunks(splitHunkCi() + fileDiff("src/a.ts", 1), { maxChars: 10_000, maxChunks: 16 });
    const ctx = addedContextFor(
      "flare-encrypt-pin guard removed with no visible replacement: the `flare-encrypt-pin` job is gone",
      plan.chunks.map((c) => c.text),
      2_000,
    );
    expect(ctx).toContain("run_check flare-encrypt-pin");
    expect(ctx.length).toBeLessThanOrEqual(2_000);
  });

  it("returns nothing for a finding that names no removed or missing thing", () => {
    expect(addedContextFor("SQL injection in handler", ["+x"], 2_000)).toBe("");
  });
});
