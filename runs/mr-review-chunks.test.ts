// Unit tests for the mr-review chunk planner (map step of the large-MR review).

import { describe, expect, it } from "vitest";
import { fileSignal, planChunks, splitDiffFiles } from "./mr-review-chunks";

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
    const plan = planChunks(diff, { maxChars: 3_000, maxChunks: 100 });
    for (const c of plan.chunks) expect(c.text.length).toBeLessThanOrEqual(3_000);
    const hunkLines = diff.split("\n").filter((l) => l.startsWith("+x"));
    const covered = plan.chunks.flatMap((c) => c.text.split("\n")).filter((l) => l.startsWith("+x"));
    expect(new Set(covered)).toEqual(new Set(hunkLines));
    expect(plan.notReviewed).toEqual([]);
  });

  it("splits a big file by hunk and repeats the file header in every piece", () => {
    const plan = planChunks(fileDiff("big.ts", 20), { maxChars: 1_500, maxChunks: 100 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    for (const c of plan.chunks) {
      expect(c.text.startsWith("diff --git a/big.ts b/big.ts\n")).toBe(true);
      expect(c.paths).toEqual(["big.ts"]);
    }
  });

  it("splits a single hunk larger than the chunk size by lines", () => {
    const plan = planChunks(fileDiff("one.ts", 1, 200), { maxChars: 2_000, maxChunks: 100 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    for (const c of plan.chunks) expect(c.text.length).toBeLessThanOrEqual(2_000);
  });

  it("beyond the chunk cap reviews the highest-signal files first and lists the rest", () => {
    const diff = fileDiff("docs/big.md", 10) + fileDiff("pnpm-lock.yaml", 10) + fileDiff("src/core.ts", 10);
    const plan = planChunks(diff, { maxChars: 700, maxChunks: 3 });
    expect(plan.chunks).toHaveLength(3);
    expect(plan.chunks[0]!.paths).toEqual(["src/core.ts"]);
    const listed = plan.notReviewed.map((n) => n.path);
    expect(listed).toContain("pnpm-lock.yaml");
    expect(listed).toContain("docs/big.md");
    for (const n of plan.notReviewed) expect(n.reason).toMatch(/chunk cap \(3\)/);
  });

  it("marks a file whose later hunks fell past the cap as partially reviewed", () => {
    const plan = planChunks(fileDiff("src/huge.ts", 30), { maxChars: 800, maxChunks: 2 });
    expect(plan.chunks).toHaveLength(2);
    expect(plan.notReviewed).toEqual([
      { path: "src/huge.ts", reason: expect.stringMatching(/^partially reviewed/) },
    ]);
  });

  it("a big section with no hunk marker still repeats its header line in every piece", () => {
    const text = `diff --git a/bin.dat b/bin.dat\n${Array.from({ length: 200 }, (_, i) => `index line ${i} ${"z".repeat(30)}`).join("\n")}\n`;
    const plan = planChunks(text, { maxChars: 1_000, maxChunks: 100 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    for (const c of plan.chunks) expect(c.text.startsWith("diff --git a/bin.dat b/bin.dat\n")).toBe(true);
  });

  it("an empty diff yields no chunks", () => {
    expect(planChunks("", { maxChars: 1_000, maxChunks: 4 })).toEqual({ chunks: [], notReviewed: [] });
  });
});
