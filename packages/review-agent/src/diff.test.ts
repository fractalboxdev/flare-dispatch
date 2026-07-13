// Diff noise-stripping unit tests.

import { describe, expect, it } from "vitest";
import { capDiff, MAX_DIFF_CHARS, stripDiffNoise } from "./diff.js";

const section = (path: string, line = "+x"): string =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,1 @@",
    line,
  ].join("\n");

describe("stripDiffNoise", () => {
  it("keeps source sections", () => {
    const diff = section("src/app.ts");
    expect(stripDiffNoise(diff)).toContain("src/app.ts");
  });

  it("drops lockfiles", () => {
    const diff = [section("src/app.ts"), section("pnpm-lock.yaml")].join("\n");
    const out = stripDiffNoise(diff);
    expect(out).toContain("src/app.ts");
    expect(out).not.toContain("pnpm-lock.yaml");
  });

  it("drops minified bundles and generated/vendored trees", () => {
    const diff = [
      section("src/app.ts"),
      section("public/bundle.min.js"),
      section("dist/index.js"),
      section("vendor/lib.ts"),
    ].join("\n");
    const out = stripDiffNoise(diff);
    expect(out).toContain("src/app.ts");
    expect(out).not.toContain("bundle.min.js");
    expect(out).not.toContain("dist/index.js");
    expect(out).not.toContain("vendor/lib.ts");
  });

  it("returns an empty diff unchanged", () => {
    expect(stripDiffNoise("")).toBe("");
  });
});

describe("capDiff", () => {
  it("returns a small diff unchanged", () => {
    const diff = section("src/app.ts");
    expect(capDiff(diff)).toBe(diff);
  });

  it("truncates and marks a diff over the cap", () => {
    const big = "x".repeat(MAX_DIFF_CHARS + 5_000);
    const out = capDiff(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out.startsWith("x".repeat(MAX_DIFF_CHARS))).toBe(true);
    expect(out).toContain("diff truncated");
  });

  it("honours a custom cap and keeps a diff at exactly the cap unchanged", () => {
    expect(capDiff("abcdef", 3)).toContain("diff truncated");
    expect(capDiff("abc", 3)).toBe("abc");
  });
});
