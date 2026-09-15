// @fractalboxdev/flare-dispatch-review-agent -- model-output sanitizers for review comments.
//
// The security-relevant helpers that neutralize model-authored text before it
// renders in a PUBLIC review comment (a GitHub PR review, a GitLab MR note). The
// diff is attacker-controllable on a hostile change and feeds the model, so a
// finding's title / message / path could carry @mention pings, raw HTML,
// or markdown break-outs. Control flow is already safe -- the verdict derives
// only from the schema-constrained level -- this is presentation hardening.
//
// Extracted here (from runs/pr-review.ts's private copies) so a second review
// run -- runs/mr-review.ts (GitLab) -- shares ONE audited implementation rather
// than a divergent copy. pr-review and mr-review both import this module
// directly now; the GitHub-specific bit -- the blob-URL fragment shape
// (L10-L12 on GitHub vs L10-12 on GitLab) -- stays at each call site; only
// the provider-agnostic sanitize + path-encode live here.

import type { Finding } from "./schemas.js";

/** Max chars of model text that render in a comment cell/line. */
const SANITIZE_MAX = 500;

/**
 * Max chars for a finding's `message` in the detailed/default layout —
 * bigger than {@link SANITIZE_MAX} (titles, paths, table cells) so a message
 * isn't cut off mid-sentence with no visual marker. Shared by BOTH provider
 * paths (`runs/pr-review.ts`, `runs/mr-review.ts`) so they don't drift — one
 * used to clip at 500, the other at 2000, for no principled reason.
 */
export const SANITIZE_MAX_MESSAGE = 2_000;

/** Build a `[lo-hi]` character-class fragment from code points, via
 *  `String.fromCharCode` rather than a `\u` escape literal — keeps this whole
 *  module's source free of literal Unicode escapes for the very characters it
 *  exists to strip. */
const codeRange = (lo: number, hi: number): string =>
  hi === lo
    ? String.fromCharCode(lo)
    : `${String.fromCharCode(lo)}-${String.fromCharCode(hi)}`;

const codePoint = (cp: number): string => String.fromCharCode(cp);

// U+200B zero-width space -- inserted after @ it breaks GitHub/GitLab @mention
// autolinking without visibly altering the text.
const ZWSP = codePoint(0x200b);

/** The ellipsis {@link clip} appends to a truncated string (U+2026). */
const ELLIPSIS = codePoint(0x2026);

/**
 * Unicode bidi overrides/isolates, zero-width/invisible format controls, the
 * BOM, and C0/C1 control characters (tab kept -- real text can contain one) --
 * stripped FIRST, before any other sanitizing step, so a hidden bidi override
 * (RLO/LRO/LRE/RLE/PDF), an invisible joiner, or a stray control byte can never
 * survive into a public comment. Deliberately excludes CR/LF and the Unicode
 * line/paragraph separators (folded to a single space by the one-line collapse
 * below, not deleted), VT/FF (also folded to a space -- see {@link LINE_BREAKS}
 * -- rather than deleted, so e.g. "a\x0Bb" reads as "a b", never "ab"), and
 * ZWNJ/ZWJ (U+200C/U+200D -- some scripts need them to render correctly; only
 * the SURROUNDING zero-width/direction-mark code points are stripped). The
 * class DOES include the ZWSP (U+200B) this module inserts itself after @ --
 * that insertion happens AFTER this strip runs, so it is never touched by it.
 */
const INVISIBLE_OR_CONTROL = new RegExp(
  "(?:[" +
    codeRange(0x00, 0x08) +
    codeRange(0x0e, 0x1f) +
    codeRange(0x7f, 0x9f) +
    codePoint(0x061c) +
    codePoint(0x200b) +
    codeRange(0x200e, 0x200f) +
    codeRange(0x2060, 0x2064) +
    codeRange(0x202a, 0x202e) +
    codeRange(0x2066, 0x2069) +
    codePoint(0xfeff) +
    "]" +
    // The Tags block (U+E0000-U+E007F) sits outside the BMP -- a single high
    // surrogate (U+DB40) paired with a low surrogate in that range -- so it
    // cannot join the bracket class above (which matches one UTF-16 code
    // unit at a time); matched as its own alternative instead.
    "|\\uDB40[\\uDC00-\\uDC7F])",
  "g",
);

const stripInvisible = (s: string): string => s.replace(INVISIBLE_OR_CONTROL, "");

/** CR, LF, the Unicode line/paragraph separators, and VT/FF (U+0B/U+0C) --
 *  every code point a renderer treats as a line break or vertical whitespace,
 *  folded to one space by {@link sanitizeModelText} (never deleted outright
 *  -- deleting would silently run two words together). */
const LINE_BREAKS = new RegExp(
  "[" +
    codeRange(0x0b, 0x0c) +
    codeRange(0x0d, 0x0d) +
    codeRange(0x0a, 0x0a) +
    codeRange(0x2028, 0x2029) +
    "]+",
  "g",
);

/**
 * Clip at a word boundary and mark the cut with an ellipsis, so truncated text
 * reads as truncated. Falls back to a hard cut when the tail has no space near
 * the limit (a long URL, a minified line). Counts Unicode CODE POINTS
 * (Array.from), not UTF-16 code units, so a 2-unit surrogate pair (an emoji,
 * an astral character) is never sliced in half at the boundary.
 */
const clip = (s: string, max: number): string => {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const cutChars = chars.slice(0, max - 1);
  const cut = cutChars.join("");
  // The space search must count CODE POINTS too, matching `max` — searching
  // the joined STRING with `.lastIndexOf` would count UTF-16 units instead,
  // so a cut containing an astral character (a surrogate pair) would compare
  // a UTF-16 index against a code-point threshold and mis-place the boundary.
  const spaceIdx = cutChars.lastIndexOf(" ");
  const trimmed = spaceIdx > max * 0.6 ? cutChars.slice(0, spaceIdx).join("") : cut;
  return `${trimmed.trimEnd()}${ELLIPSIS}`;
};

/**
 * Neutralize model-authored text before it renders in a public review comment:
 * strip invisible/bidi/control characters, collapse to one line, drop angle
 * brackets, defang backticks + @, defuse markdown link/image syntax, and
 * bound the length. Byte-parity with runs/pr-review.ts's private
 * sanitizeModelText (now folded onto this shared implementation).
 */
export const sanitizeModelText = (s: string, max: number = SANITIZE_MAX): string =>
  clip(
    stripInvisible(s)
      .replace(LINE_BREAKS, " ")
      .replace(/[<>]/g, "")
      .replace(/`/g, "'")
      // Defuse markdown link/image syntax [text](url) / ![](url). Both
      // require the square brackets, so stripping [ and ] neutralises a
      // disguised link (a leaked-token phishing anchor) AND an auto-loading
      // image beacon (a zero-click tracking pixel) -- model text is steerable by
      // a hostile fork PR's diff, and this text is posted under the App's
      // identity. A bare URL survives as visible, un-disguised text (GitHub /
      // GitLab autolinks it, but the destination is no longer hidden behind
      // anchor text).
      .replace(/[[\]]/g, "")
      .replace(/@(?=[\w-])/g, `@${ZWSP}`),
    max,
  );

/** Replace an unpaired ("lone") surrogate code unit with U+FFFD before
 *  URL-encoding -- `encodeURIComponent` THROWS a `URIError` on a lone
 *  surrogate (malformed model output can contain one), which would crash the
 *  whole render instead of degrading a single finding's link. Iterating BY
 *  CODE POINT (`Array.from`'s per-element callback) is what makes this safe:
 *  a valid surrogate PAIR combines into one code point outside the surrogate
 *  range and passes through untouched; only a code point that IS a surrogate
 *  (only possible when it had no pair) gets replaced. */
const replaceLoneSurrogates = (s: string): string =>
  Array.from(s, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp >= 0xd800 && cp <= 0xdfff ? "�" : ch;
  }).join("");

/**
 * The URL-encoded path of a finding -- the PROVIDER-AGNOSTIC core of a blob URL.
 * Its OWN encoding, deliberately NOT built on sanitizeModelText: the
 * display sanitizer clips length, deletes <, >, [, ], and inserts a
 * zero-width space after @ -- all wrong for a URL path, which should be
 * PERCENT-ENCODED rather than mangled (deleting a character can turn one path
 * into another; encodeURIComponent hides every unsafe/invisible byte,
 * bidi controls included, behind %XX without losing or colliding path
 * segments). Each segment is encodeURIComponent'd (plus manual
 * paren-encoding -- encodeURIComponent leaves () alone, and a bare )
 * would terminate the markdown link). The caller prepends the provider's
 * blob-URL base and appends the provider's line fragment.
 */
export const encodeFindingPath = (path: string): string =>
  replaceLoneSurrogates(path)
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");

/**
 * path:line display text for a finding's location. Square brackets are stripped
 * on top of sanitizeModelText -- the text renders inside [...](url) link
 * syntax, where a ] would break out of the link.
 */
export const findingLoc = (f: Finding): string => {
  const path = sanitizeModelText(f.path).replace(/[[\]]/g, "");
  return f.startLine === f.endLine
    ? `${path}:${f.startLine}`
    : `${path}:${f.startLine}-${f.endLine}`;
};

/** Sanitized text safe inside a markdown table cell -- an unescaped | would
 *  split the row. */
export const tableCell = (s: string): string =>
  sanitizeModelText(s).replace(/\|/g, "\\|");
