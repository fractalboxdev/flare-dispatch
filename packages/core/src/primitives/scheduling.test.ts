// Unit tests for the Schedule-mode trivia primitives.

import { describe, expect, it } from "vitest";
import { isoDate, parseList } from "./scheduling";

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
