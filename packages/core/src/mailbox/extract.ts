// Pure OTP-code + magic-link extraction from a received verification message.
//
// The run pauses on `waitForOtp`, the `email()` handler signals the buffered
// `InboxMessage`, and THIS module turns the (subject, text) pair into the
// `{ code?, link? }` the run actually consumes — a numeric/alphanumeric one-time
// code, a magic link, or both. It is deliberately PURE: no Effect, no I/O, no
// clock, no network. Given the same message + opts it returns the same result,
// so it is unit-testable in isolation and free to call from any layer.
//
// --- Why not the naive `\b\d{4,8}\b` -----------------------------------------
//
// A first cut grabbed "the first 4–8 digit run" — and promptly mis-fired on the
// chrome that surrounds every real OTP mail: the copyright year (`© 2026`), an
// "expires in 15 minutes" line, an order/total/invoice id, a support phone
// number. Those are all 2–8 digit runs sitting right next to the code. So the
// default path is CONTEXT-ANCHORED: it only trusts a digit run that sits near an
// OTP keyword (`code`, `passcode`, `verification`, `one-time`, …), prefers the
// 6-digit shape most providers use, and — only as a last resort — falls back to
// a standalone group that is whitespace/`>`-bounded and is NOT a 4-digit year,
// a percentage, a currency amount, or a fragment of a longer number / URL.
//
// LINK extraction is the mirror image: collect every `https://` URL, throw away
// the unsubscribe / list-manage / tracking-pixel / asset noise, then pick the
// one that reads like a verification link (`verify|confirm|magic|…`), biased to
// a caller-supplied `linkHost` when given.
//
// Spec: specs/03-dsl.md § mailbox; consumed by primitives/wait-for-otp.ts.

import type { OtpExtraction } from "./contract";

/** Default width window for a bare numeric OTP when no `codeWidth` is given.
 * 4–8 digits spans every provider we target (Clerk/Stytch = 6, some banks = 8,
 * a few legacy flows = 4). */
const DEFAULT_MIN_WIDTH = 4;
const DEFAULT_MAX_WIDTH = 8;

/** The single most common OTP width — used to break ties between equally
 * keyword-adjacent candidates (a 6-digit hit wins over a stray 4-digit one). */
const PREFERRED_WIDTH = 6;

/**
 * Tokens that, when they sit just before a digit run, mark it as the code
 * rather than chrome. Kept broad on purpose (`verify`, `one time`, `security`,
 * `confirm`, …) because providers phrase the same thing a dozen ways:
 * "Your verification code is", "Enter this one-time passcode", "security code".
 */
const OTP_KEYWORD_SOURCE =
  "code|otp|passcode|verification|verify|one[-\\s]?time|security|confirm|pin|token";

/** A 4-digit run that is really a calendar year (`1900`–`2099`) — the single
 * most common false positive (copyright footer, "© 2026 Acme"). Never a code. */
const YEAR_RE = /^(?:19|20)\d{2}$/;

/**
 * Path/keyword tokens that mark a URL as the magic link (vs. a footer link).
 * Matched against the full URL, case-insensitively.
 */
const LINK_KEYWORD_RE = /verify|confirm|magic|activate|login|sign-?in|token|callback/i;

/**
 * URL substrings that mark it as tracking / unsubscribe / asset chrome — dropped
 * before we ever consider a URL as the magic link. Image extensions are matched
 * separately (anchored to the end of the path) so a `verify` link with a `?img`
 * query is not wrongly discarded.
 */
const LINK_NOISE_RE = /unsubscribe|list-manage|\/o\/|\/track|^mailto:/i;
const LINK_ASSET_RE = /\.(?:png|jpe?g|gif|svg|webp|ico)(?:[?#].*)?$/i;

/**
 * Extract the one-time code from a message.
 *
 * Resolution order (first qualifying hit wins):
 *  1. **Caller pattern** (`opts.codePattern`) — if given, its first capture
 *     group is the code. Tried against the subject, then the text. This is the
 *     escape hatch for alphanumeric codes (`ABC-123`) or provider-specific
 *     shapes; the default path is digits-only.
 *  2. **Keyword-anchored** — a `codeWidth`-wide (else 4–8) digit run that sits
 *     within ~40 non-digit chars *after* an OTP keyword. Subject is searched
 *     before text (OTP codes very often live in the subject). A 6-digit hit is
 *     preferred over other widths when several anchored candidates exist.
 *  3. **Standalone fallback** — a whitespace/`>`-bounded digit run that is not a
 *     year, not a `:`/`%`/currency-adjacent number, and not a fragment of a
 *     longer number or URL. The candidate nearest an OTP keyword wins; absent
 *     any keyword, the first qualifying group.
 *
 * Returns `undefined` when nothing qualifies — the caller keeps waiting.
 *
 * @param msg  the received message — `subject` is searched before `text`.
 * @param opts `codePattern` (override), `codeWidth` (exact digit count).
 */
export const extractCode = (
  msg: { readonly subject: string; readonly text: string },
  opts?: { readonly codePattern?: RegExp; readonly codeWidth?: number },
): string | undefined => {
  // (1) Caller-supplied pattern — first capture group, subject then text.
  if (opts?.codePattern) {
    for (const haystack of [msg.subject, msg.text]) {
      const m = matchFirstGroup(opts.codePattern, haystack);
      if (m !== undefined) return m;
    }
    return undefined;
  }

  const width = opts?.codeWidth;
  const digits = width
    ? `\\d{${width}}`
    : `\\d{${DEFAULT_MIN_WIDTH},${DEFAULT_MAX_WIDTH}}`;

  // (2) Keyword-anchored. Subject first, then text. Within each, prefer a
  //     6-digit hit (when no explicit width was pinned) over other widths.
  const anchored = new RegExp(
    `(?:${OTP_KEYWORD_SOURCE})[^0-9\\n]{0,40}(${digits})`,
    "gi",
  );
  for (const haystack of [msg.subject, msg.text]) {
    const hits = collectGroups(anchored, haystack).filter((h) =>
      isStandaloneAt(haystack, h.index, h.value),
    );
    if (hits.length > 0) {
      if (!width) {
        const six = hits.find((h) => h.value.length === PREFERRED_WIDTH);
        if (six) return six.value;
      }
      return hits[0]!.value;
    }
  }

  // (3) Standalone fallback. A digit run bounded by whitespace / start / `>`
  //     (so never inside a longer number or a URL), excluding years and
  //     `:`/`%`/currency-adjacent numbers. Searched across subject + text; the
  //     candidate closest to an OTP keyword wins, else the first one.
  const standalone = new RegExp(`(${digits})`, "g");
  const keywordRe = new RegExp(OTP_KEYWORD_SOURCE, "gi");
  for (const haystack of [msg.subject, msg.text]) {
    const candidates = collectGroups(standalone, haystack).filter(
      (h) =>
        isStandaloneAt(haystack, h.index, h.value) &&
        !isDisqualified(h.value) &&
        !hasQuantityNeighbour(haystack, h.index, h.value),
    );
    if (candidates.length === 0) continue;

    const keywordPositions = collectGroups(keywordRe, haystack).map((h) => h.index);
    if (keywordPositions.length > 0) {
      let best = candidates[0]!;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const c of candidates) {
        const dist = Math.min(...keywordPositions.map((p) => Math.abs(c.index - p)));
        // Prefer the 6-digit shape on ties when no width was pinned.
        const better =
          dist < bestDist ||
          (dist === bestDist &&
            !width &&
            c.value.length === PREFERRED_WIDTH &&
            best.value.length !== PREFERRED_WIDTH);
        if (better) {
          best = c;
          bestDist = dist;
        }
      }
      return best.value;
    }
    return candidates[0]!.value;
  }

  return undefined;
};

/**
 * Extract the magic link from the plain-text body.
 *
 * Steps:
 *  1. Collect every `https://` URL.
 *  2. Drop unsubscribe / list-manage / tracking / `mailto:` / image-asset URLs.
 *  3. If `opts.linkHost` is given, keep only URLs whose host equals it (or is a
 *     subdomain — `endsWith("." + linkHost)`); the winner is chosen from that
 *     subset.
 *  4. Otherwise prefer a URL whose path/query reads like a verification link
 *     (`verify|confirm|magic|…`); failing that, the URL with the longest
 *     path+query (the link carrying the token, not a bare homepage).
 *
 * Returns `undefined` when no usable URL survives.
 */
export const extractLink = (
  text: string,
  opts?: { readonly linkHost?: string },
): string | undefined => {
  // `https://` only — magic links are never plain http, and this drops
  // `http://` tracking beacons for free. Trailing `)`, `]`, `.`, `>`, `"`, `'`,
  // and `,` are stripped (punctuation that hugs a URL in prose / markup).
  const raw = text.match(/https:\/\/[^\s<>"'\])]+/gi) ?? [];
  const urls = raw
    .map((u) => u.replace(/[.,;:!?)>\]'"]+$/, ""))
    .filter((u) => !LINK_NOISE_RE.test(u) && !LINK_ASSET_RE.test(u));
  if (urls.length === 0) return undefined;

  const host = opts?.linkHost?.toLowerCase();
  const pool = host
    ? urls.filter((u) => {
        const h = hostOf(u);
        return h === host || h.endsWith(`.${host}`);
      })
    : urls;
  // A `linkHost` was asked for but nothing matched → no link (don't silently
  // hand back an off-host URL the caller explicitly didn't want).
  if (host && pool.length === 0) return undefined;

  const verification = pool.find((u) => LINK_KEYWORD_RE.test(u));
  if (verification) return verification;

  // Longest path+query wins — the token-bearing link beats a bare host.
  return pool.reduce((best, u) =>
    pathQueryLength(u) > pathQueryLength(best) ? u : best,
  );
};

/**
 * Extract both the code and the link from a received message, composing
 * {@link extractCode} and {@link extractLink}. Either field is omitted when its
 * extractor finds nothing, so the result is `{}` when neither is present.
 *
 * @param msg  `{ subject, text }` from the buffered `InboxMessage`.
 * @param opts forwarded to the two extractors (`codePattern`, `codeWidth`,
 *             `linkHost`).
 */
export const extractOtp = (
  msg: { readonly subject: string; readonly text: string },
  opts?: {
    readonly codePattern?: RegExp;
    readonly codeWidth?: number;
    readonly linkHost?: string;
  },
): OtpExtraction => {
  const code = extractCode(msg, opts);
  const link = extractLink(msg.text, opts);
  return {
    ...(code !== undefined ? { code } : {}),
    ...(link !== undefined ? { link } : {}),
  };
};

// --- internals ---------------------------------------------------------------

/** First-capture-group match of `re` against `s`, or `undefined`. Clones `re`
 * without the global flag so a caller-supplied `/g` pattern can't leak
 * `lastIndex` state across calls. */
const matchFirstGroup = (re: RegExp, s: string): string | undefined => {
  const flags = re.flags.replace(/g/g, "");
  const m = new RegExp(re.source, flags).exec(s);
  if (!m) return undefined;
  const group = m[1] ?? m[0];
  return group.trim() || undefined;
};

type Group = { readonly value: string; readonly index: number };

/** All first-group matches of a global `re` against `s`, with the absolute
 * index of the captured group (not the whole match). Defensive against
 * zero-width matches so it can never spin. */
const collectGroups = (re: RegExp, s: string): Group[] => {
  const out: Group[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = g.exec(s)) !== null) {
    const value = m[1] ?? m[0];
    // Index of the captured group inside the overall match.
    const groupIndex = m[1] !== undefined ? m.index + m[0].indexOf(m[1]) : m.index;
    out.push({ value, index: groupIndex });
    if (m.index === g.lastIndex) g.lastIndex++; // guard zero-width matches
  }
  return out;
};

/**
 * True iff the digit run `value` at `index` in `s` is *standalone* — i.e. the
 * char immediately before and after it is not another digit. This is what keeps
 * a 6-digit code from being plucked out of the middle of a 10-digit phone
 * number or a long tracking id embedded in a URL.
 */
const isStandaloneAt = (s: string, index: number, value: string): boolean => {
  const before = index > 0 ? s[index - 1]! : "";
  const after = s[index + value.length] ?? "";
  return !/\d/.test(before) && !/\d/.test(after);
};

/**
 * Value-only disqualifier for a standalone digit run: rejects a calendar year
 * (`1900`–`2099`) — the copyright-footer false positive. Position-aware chrome
 * (`:`/`%`/currency/decimal) is handled separately by
 * {@link hasQuantityNeighbour}.
 */
const isDisqualified = (value: string): boolean => YEAR_RE.test(value);

/**
 * Position-aware disqualifier used by the standalone fallback: rejects a run
 * that is clearly a quantity/price/time rather than a token — an adjacent `:`
 * (time / ratio), trailing `%` (percentage), or a currency sign / decimal-point
 * neighbour (`$1234`, `12.50`). Conservative: only the unambiguous chrome is
 * filtered, so a real code is never lost.
 */
const hasQuantityNeighbour = (s: string, index: number, value: string): boolean => {
  const before = index > 0 ? s[index - 1]! : "";
  const after = s[index + value.length] ?? "";
  // `12:34` (time), `45%`, `$12`, `€99`, `£10`, `12.50` (decimal).
  if (after === ":" || before === ":") return true;
  if (after === "%") return true;
  if (before === "$" || before === "€" || before === "£") return true;
  if (after === "." && /\d/.test(s[index + value.length + 1] ?? "")) return true;
  if (before === "." && /\d/.test(s[index - 2] ?? "")) return true;
  return false;
};

/** The host (lowercased, no port) of an `https://` URL, or `""` if unparseable
 * without the WHATWG `URL` (kept dependency-free; a tiny hand-parse suffices for
 * the well-formed links providers send). */
const hostOf = (url: string): string => {
  const m = /^https:\/\/([^/?#]+)/i.exec(url);
  if (!m) return "";
  return m[1]!.replace(/:\d+$/, "").toLowerCase();
};

/** Length of the path + query + fragment (everything after the host) — the
 * tie-breaker for "which URL carries the token". */
const pathQueryLength = (url: string): number => {
  const m = /^https:\/\/[^/?#]+(.*)$/i.exec(url);
  return m ? m[1]!.length : 0;
};
