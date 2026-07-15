// Unit tests for `isNothingToLint` — the classifier that keeps oxlint's one
// non-verdict exit from masquerading as a lint finding.
//
// oxlint exits 1 both when it finds problems AND when it finds no files to
// lint, so the exit code cannot tell a verdict from a no-op. Everything the
// `oxlint` gate and `pr-review`'s grounding block key off lives in this
// predicate, so the cases it must and must NOT match are pinned here.

import { describe, expect, it } from "vitest";
import { isNothingToLint } from "./oxlint";

/** oxlint 1.x's verbatim output when the file set is empty (stdout, exit 1). */
const SENTINEL =
  "No files found to lint. Please check your paths and ignore patterns.";

describe("isNothingToLint", () => {
  it("matches oxlint's empty-file-set output", () => {
    expect(isNothingToLint(SENTINEL)).toBe(true);
    expect(isNothingToLint(`${SENTINEL}\n`)).toBe(true);
  });

  it("matches when the sentinel is embedded in a combined stdout+stderr blob", () => {
    // The run tests the exec result's `${stdout}\n${stderr}`, and sandbox-cf
    // may prepend a truncation breadcrumb to the inlined tail — so the sentinel
    // is matched on its own line, not as the whole string.
    expect(isNothingToLint(`…(log truncated)\n${SENTINEL}\n`)).toBe(true);
  });

  it("does NOT match a clean lint (oxlint prints nothing) or a real report", () => {
    expect(isNothingToLint("")).toBe(false);
    expect(isNothingToLint("Found 0 warnings and 0 errors.")).toBe(false);
    expect(
      isNothingToLint(
        [
          "  x eslint(no-unused-vars): 'foo' is never used",
          "   ╭─[src/x.ts:1:7]",
          " 1 │ const foo = 1;",
          "   ╰────",
          "",
          "Found 1 error.",
        ].join("\n"),
      ),
    ).toBe(false);
  });

  it("does NOT match the sentinel text quoted inside a diagnostic's source snippet", () => {
    // The guard on the anchor: oxlint renders snippets indented behind a `│`
    // gutter, so a source line that happens to contain the sentinel's words
    // never reaches column 0 — and must not be read as a no-op.
    const report = [
      "  x eslint(no-console): unexpected console statement",
      "   ╭─[src/log.ts:2:1]",
      ' 2 │ console.log("No files found to lint. Please check your paths.");',
      "   ╰────",
      "",
      "Found 1 error.",
    ].join("\n");
    expect(isNothingToLint(report)).toBe(false);
  });
});
