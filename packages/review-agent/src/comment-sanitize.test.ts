// Unit tests for the shared review-comment sanitizers.

import { describe, expect, it } from "vitest";
import {
  encodeFindingPath,
  findingLoc,
  SANITIZE_MAX_MESSAGE,
  sanitizeModelText,
  tableCell,
} from "./comment-sanitize.js";
import type { Finding } from "./schemas.js";

const finding = (over: Partial<Finding>): Finding => ({
  path: "src/x.ts",
  startLine: 1,
  endLine: 1,
  level: "notice",
  title: "t",
  message: "m",
  ...over,
});

describe("sanitizeModelText", () => {
  it("collapses newlines, strips angle brackets, defangs backticks", () => {
    expect(sanitizeModelText("a\n<b>`c`")).toBe("a b'c'");
  });
  it("defangs @mentions with a zero-width space", () => {
    const out = sanitizeModelText("@evil");
    expect(out.startsWith("@")).toBe(true);
    expect(out).not.toBe("@evil");
    expect(out.charCodeAt(1)).toBe(0x200b);
  });
  it("bounds length to 500 chars", () => {
    expect(sanitizeModelText("x".repeat(1000))).toHaveLength(500);
  });
  it("strips a bidi override before it can reorder visible text", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE — could make "evil.exe" render as "exe.live".
    const out = sanitizeModelText(`file‮txt.exe`);
    expect(out).not.toContain("‮");
    expect(out).toBe("filetxt.exe");
  });
  it("strips zero-width/invisible format controls (joiners, word joiner, BOM)", () => {
    const out = sanitizeModelText("a​b⁠c﻿d");
    expect(out).toBe("abcd");
  });
  it("strips C0/C1 controls but keeps a literal tab", () => {
    const out = sanitizeModelText("ab\ta");
    expect(out).toBe("ab\ta");
  });
  it("normalises U+2028/U+2029 to a space in the one-line collapse", () => {
    expect(sanitizeModelText("a b c")).toBe("a b c");
  });
  it("clips on code points, never splitting a surrogate pair", () => {
    // 😀 (U+1F600) is a 2-UTF-16-unit surrogate pair placed so that a
    // UTF-16-unit-based cut at index 499 would land INSIDE it (498 "x"s put
    // the pair's high surrogate at unit 498, low surrogate at unit 499).
    const s = "x".repeat(498) + "😀" + "y".repeat(10);
    const out = sanitizeModelText(s);
    // A split pair would leave a lone (invalid) surrogate in the output.
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(out.endsWith("…")).toBe(true);
  });
  it("finds the word-boundary cut by code points, even when astral characters precede it", () => {
    // Ten astral emoji (2 UTF-16 units each) then a space then more text — a
    // UTF-16-unit-based space search would see the space at unit ~21, well
    // past a code-point `max` of 15, and wrongly skip the word boundary.
    const s = "😀".repeat(10) + " " + "x".repeat(50);
    const out = sanitizeModelText(s, 15);
    expect(Array.from(out).length).toBeLessThanOrEqual(15);
    expect(out.endsWith("…")).toBe(true);
    // The cut lands at the space (word-boundary path), not mid-run of emoji.
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  it("strips ALM (U+061C) and the Tags block (U+E0000-U+E007F)", () => {
    const alm = String.fromCodePoint(0x061c);
    const tag = String.fromCodePoint(0xe0020); // TAG SPACE, part of the Tags block
    expect(sanitizeModelText(`a${alm}b${tag}c`)).toBe("abc");
  });
  it("keeps ZWNJ/ZWJ — some scripts need them to render correctly", () => {
    const zwnj = String.fromCodePoint(0x200c);
    const zwj = String.fromCodePoint(0x200d);
    const out = sanitizeModelText(`a${zwnj}b${zwj}c`);
    expect(out).toContain(zwnj);
    expect(out).toContain(zwj);
  });
  it("folds VT/FF to a space instead of deleting them", () => {
    const vt = String.fromCharCode(0x0b);
    const ff = String.fromCharCode(0x0c);
    expect(sanitizeModelText(`a${vt}b${ff}c`)).toBe("a b c");
  });
  it("SANITIZE_MAX_MESSAGE is the shared 2000-char cap both provider paths clip a finding's message to", () => {
    expect(SANITIZE_MAX_MESSAGE).toBe(2000);
    expect(sanitizeModelText("x".repeat(3000), SANITIZE_MAX_MESSAGE)).toHaveLength(2000);
  });
});

describe("encodeFindingPath", () => {
  it("strips leading slashes, encodes segments, encodes parens", () => {
    expect(encodeFindingPath("/a b/c(d).ts")).toBe("a%20b/c%28d%29.ts");
  });
  it("neutralizes a path traversal / markdown break-out attempt", () => {
    // `<`/`>` are percent-encoded (not deleted — this is its own URL encoding,
    // not the display sanitizer); the rest URL-encoded so it can't break out of
    // the markdown link.
    const out = encodeFindingPath("../<script>/x)y.ts");
    expect(out).not.toContain("<");
    expect(out).toContain("%3Cscript%3E");
    expect(out).not.toContain(")");
    expect(out).toContain("%29");
  });
  it("percent-encodes a bidi override hidden in a path segment", () => {
    const out = encodeFindingPath(`a/‮b.ts`);
    expect(out).not.toContain("‮");
    expect(out).toContain("%E2%80%AE");
  });
  it("replaces a lone (unpaired) surrogate with U+FFFD instead of throwing", () => {
    const lone = "a/\uD800b"; // unpaired high surrogate — malformed model output
    expect(() => encodeFindingPath(lone)).not.toThrow();
    expect(encodeFindingPath(lone)).toBe("a/%EF%BF%BDb");
  });
});

describe("findingLoc", () => {
  it("renders path:line for a single line and path:start-end for a range", () => {
    expect(findingLoc(finding({ path: "a.ts", startLine: 3, endLine: 3 }))).toBe("a.ts:3");
    expect(findingLoc(finding({ path: "a.ts", startLine: 3, endLine: 5 }))).toBe("a.ts:3-5");
  });
  it("strips square brackets (link break-out)", () => {
    expect(findingLoc(finding({ path: "a[x].ts", startLine: 1, endLine: 1 }))).toBe("ax.ts:1");
  });
});

describe("tableCell", () => {
  it("escapes pipes on top of sanitize", () => {
    expect(tableCell("a|b")).toBe("a\\|b");
  });
});
