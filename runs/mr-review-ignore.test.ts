import { describe, expect, it } from "vitest";
import { diffSectionForPath, globToRegExp, parseIgnorePaths, stripIgnoredPaths } from "./mr-review-ignore";

const section = (path: string, body = "+x\n") =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}`;

describe("globToRegExp", () => {
  it("** spans directories, * stops at a slash", () => {
    expect(globToRegExp("infra/flare-dispatch/red-test/**").test("infra/flare-dispatch/red-test/a/b.txt")).toBe(true);
    expect(globToRegExp("infra/*/red-test/**").test("infra/flare-dispatch/red-test/x.txt")).toBe(true);
    expect(globToRegExp("infra/*/red-test/**").test("infra/a/b/red-test/x.txt")).toBe(false);
    expect(globToRegExp("**/*.snap").test("apps/api/__snapshots__/a.snap")).toBe(true);
    expect(globToRegExp("**/*.snap").test("a.snap")).toBe(true);
    expect(globToRegExp("docs/*.md").test("docs/a/b.md")).toBe(false);
  });
  it("escapes regex metacharacters in literal parts", () => {
    expect(globToRegExp("a.b/c+d").test("a.b/c+d")).toBe(true);
    expect(globToRegExp("a.b/c+d").test("axb/c+d")).toBe(false);
  });
});

describe("parseIgnorePaths", () => {
  it("splits on commas and newlines, drops blanks, tolerates null", () => {
    expect(parseIgnorePaths(" a/**, b/*.txt\n\nc ")).toEqual(["a/**", "b/*.txt", "c"]);
    expect(parseIgnorePaths(null)).toEqual([]);
  });
});

describe("stripIgnoredPaths", () => {
  it("drops matching file sections and keeps the rest byte-for-byte", () => {
    const keep = section("apps/api/src/a.ts");
    const drop = section("infra/flare-dispatch/red-test/planted-defects.ts.txt", "+const offset = page * pageSize;\n");
    const out = stripIgnoredPaths(keep + drop + section("docs/x.md"), ["infra/flare-dispatch/red-test/**"]);
    expect(out.dropped).toEqual(["infra/flare-dispatch/red-test/planted-defects.ts.txt"]);
    expect(out.diff).toBe(keep + section("docs/x.md"));
  });
  it("no globs or no headers → unchanged", () => {
    const d = section("a.ts");
    expect(stripIgnoredPaths(d, [])).toEqual({ diff: d, dropped: [] });
    expect(stripIgnoredPaths("+just a line\n", ["**"])).toEqual({ diff: "+just a line\n", dropped: [] });
  });
});

describe("diffSectionForPath", () => {
  it("returns the one section whose new path matches", () => {
    const a = section("src/a.ts", "+a\n");
    const b = section("src/b.ts", "+b\n");
    const out = diffSectionForPath(a + b, "src/b.ts");
    expect(out).toBe(b);
  });
  it("returns null when no section matches the path", () => {
    const a = section("src/a.ts");
    expect(diffSectionForPath(a, "src/nope.ts")).toBeNull();
  });
  it("returns null for a diff with no diff --git headers", () => {
    expect(diffSectionForPath("+just a line\n", "src/a.ts")).toBeNull();
  });
});
