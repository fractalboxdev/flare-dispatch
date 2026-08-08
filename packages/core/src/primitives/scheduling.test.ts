// Unit tests for the Schedule-mode trivia primitives.

import { describe, expect, it } from "vitest";
import { isoDate, parseList, parseRepo, parseRepoRelativePath } from "./scheduling";

describe("isoDate", () => {
  it("renders the UTC calendar date", () => {
    expect(isoDate(Date.UTC(2026, 5, 3, 23, 59))).toBe("2026-06-03");
  });
});

describe("parseList", () => {
  it("splits on commas / whitespace / newlines and drops blanks", () => {
    expect(parseList("a/b, c/d\n e/f")).toEqual(["a/b", "c/d", "e/f"]);
  });
  it("returns [] for undefined / empty", () => {
    expect(parseList(undefined)).toEqual([]);
    expect(parseList("  ,  ")).toEqual([]);
  });
});

describe("parseRepo", () => {
  it("accepts an owner/name and trims it", () => {
    expect(parseRepo(" owner/control ")).toBe("owner/control");
    expect(parseRepo("owner-1/repo.name_2")).toBe("owner-1/repo.name_2");
  });

  // Unset and malformed are deliberately the same answer, because both mean
  // "the operator did not name a repository" and neither may be guessed past.
  it("rejects anything that is not exactly one owner/name", () => {
    for (const bad of [undefined, null, "", "   ", "owner", "owner/", "/name", "a/b/c", "o w/n"]) {
      expect(parseRepo(bad)).toBeUndefined();
    }
  });
});

describe("parseRepoRelativePath", () => {
  it("takes the caller's fallback when unset, and strips a trailing slash", () => {
    expect(parseRepoRelativePath(undefined, "maintenance/questions")).toBe("maintenance/questions");
    expect(parseRepoRelativePath("  ", "maintenance/declined.jsonl")).toBe(
      "maintenance/declined.jsonl",
    );
    expect(parseRepoRelativePath("infra/loop/questions/", "fallback")).toBe("infra/loop/questions");
  });

  // The committed path is what a reviewer reads back in the diff. A value that
  // resolves somewhere other than where it reads is the failure, malicious or
  // not — so `..`, absolute, and backslash-bearing values are all refused.
  it("refuses a path that escapes or is not repo-relative", () => {
    for (const bad of ["/etc/passwd", "../up", "a/../../b", "a//b", "a/./b", "a\\b"]) {
      expect(parseRepoRelativePath(bad, "fallback")).toBeUndefined();
    }
  });
});
