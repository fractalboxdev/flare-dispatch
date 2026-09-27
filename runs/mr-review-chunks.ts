// The MAP side of the large-MR review: split a unified diff into review chunks.
//
// A large MR used to hit two walls at once: `capDiff` silently truncated the diff
// at `maxDiffChars`, and one model call over a long diff ran past Workers AI's
// request timeout (3046) or spent its whole token budget reasoning (an empty
// answer). The review now runs one model pass per CHUNK instead:
//
//   * split the diff by file (`diff --git` sections);
//   * keep a file up to `maxHunkChars` whole; split a bigger one by hunk (`@@`). A hunk bigger
//     than the chunk size but under `maxHunkChars` (~30 KB) goes WHOLE into a
//     chunk of its own; only a hunk above that is split, at blank-line or
//     top-level-key boundaries — every piece repeats the file header so the
//     model always knows which file it is reading;
//   * pack the pieces greedily into chunks of at most `maxChars`, highest-signal
//     files first (source > config > docs > generated);
//   * stop at `maxChunks` — whatever did not fit is LISTED in `notReviewed` with
//     its reason, never silently dropped.
//
// PURE — no Effect, no I/O — so the Workflow can checkpoint the plan as data.

/** One `diff --git` section. */
export type DiffFile = { readonly path: string; readonly text: string };

/** One unit of review work — a model pass reads `text` and nothing else. */
export type Chunk = {
  readonly id: number;
  /** Files (some possibly partial) this chunk carries, in order. */
  readonly paths: readonly string[];
  readonly text: string;
};

/** A changed file (or the rest of one) that no chunk carries. */
export type NotReviewed = { readonly path: string; readonly reason: string };

export type ChunkPlan = {
  readonly chunks: readonly Chunk[];
  readonly notReviewed: readonly NotReviewed[];
};

const headerPath = (firstLine: string): string => {
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(firstLine);
  return m ? m[2]! : firstLine.replace(/^diff --git /, "");
};

/** Split a unified diff into its `diff --git` sections (text kept byte-for-byte). */
export const splitDiffFiles = (diff: string): readonly DiffFile[] =>
  diff
    .split(/^(?=diff --git )/m)
    .filter((s) => s.length > 0)
    .map((text) => ({ path: headerPath(text.split("\n", 1)[0] ?? ""), text }));

const GENERATED =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.min\.(js|css)$|\.map$|\.snap$|(^|\/)(dist|build|vendor|__snapshots__|generated)\/|\.generated\.|\.pb\.go$/i;
const DOCS = /\.(md|mdx|txt|rst|adoc)$|(^|\/)(CHANGELOG|LICENSE|NOTICE)(\.|$)/i;
const CONFIG = /\.(json|jsonc|ya?ml|toml|ini|env|properties|xml|lock)$/i;
const CI_OR_BUILD = /(^|\/)(\.gitlab-ci\.yml|Dockerfile[^/]*|Makefile|\.github\/workflows\/[^/]+)$/;

/**
 * How much a file's review is worth when the chunk cap forces a choice —
 * higher first. CI/build definitions rank with source: they run code.
 */
export const fileSignal = (path: string): number => {
  if (GENERATED.test(path)) return 0;
  if (CI_OR_BUILD.test(path)) return 3;
  if (DOCS.test(path)) return 1;
  if (CONFIG.test(path)) return 2;
  return 3;
};

/** Default cap for a hunk kept whole. Atomos !304 (2026-09-27): a ~20 KB
 *  `.gitlab-ci.yml` hunk split by line put eight removed guard jobs in one
 *  chunk and their `run_check` replacements in another — three false findings. */
export const DEFAULT_MAX_HUNK_CHARS = 30_000;

/** Split one file section into pieces of at most `maxChars` — a whole file or a
 *  single hunk up to `maxHunkChars` stays whole — each led by the file header. */
const splitFile = (file: DiffFile, maxChars: number, maxHunkChars: number): readonly string[] => {
  // A whole file up to the hunk cap stays whole too: Atomos !304 removed the
  // guard jobs in one hunk and re-added them in another hunk of the same file.
  if (file.text.length <= maxHunkChars) return [file.text];
  const firstHunk = file.text.search(/^@@/m);
  // No hunk marker (a binary or rename-only section): split by line, but keep
  // the `diff --git` line on every piece so the model can name the file.
  if (firstHunk < 0) {
    const nl = file.text.indexOf("\n") + 1;
    return splitLines(file.text.slice(nl), file.text.slice(0, nl), maxChars);
  }
  const header = file.text.slice(0, firstHunk);
  const hunks = file.text.slice(firstHunk).split(/^(?=@@)/m);
  const room = Math.max(1, maxChars - header.length);
  const pieces: string[] = [];
  let cur = "";
  for (const hunk of hunks) {
    if (cur.length + hunk.length <= room) {
      cur += hunk;
      continue;
    }
    if (cur !== "") pieces.push(header + cur);
    cur = "";
    if (hunk.length <= room) cur = hunk;
    else if (header.length + hunk.length <= maxHunkChars) pieces.push(header + hunk);
    else pieces.push(...splitAtBoundaries(hunk, header, maxHunkChars));
  }
  if (cur !== "") pieces.push(header + cur);
  return pieces;
};

/** A line a split may start at: a blank line (in any diff column) or a
 *  top-level key/declaration (first column after the diff marker not blank). */
const isBoundary = (line: string): boolean => {
  if (line.startsWith("\\")) return false;
  const content = "-+ ".includes(line[0] ?? "") ? line.slice(1) : line;
  return /^(\s*$|\S)/.test(content);
};

/** Split a hunk above the hunk cap into pieces of at most `maxChars`, cutting
 *  only before a {@link isBoundary} line; a block with no boundary inside the
 *  room falls back to {@link splitLines}. */
const splitAtBoundaries = (hunk: string, header: string, maxChars: number): string[] => {
  const room = Math.max(1, maxChars - header.length);
  const lines = hunk.split(/(?<=\n)/);
  const out: string[] = [];
  let start = 0;
  while (start < lines.length) {
    let len = 0;
    let end = start;
    let lastCut = -1;
    while (end < lines.length && len + lines[end]!.length <= room) {
      if (end > start && isBoundary(lines[end]!)) lastCut = end;
      len += lines[end]!.length;
      end++;
    }
    if (end >= lines.length) {
      out.push(header + lines.slice(start).join(""));
      break;
    }
    if (lastCut > start) {
      out.push(header + lines.slice(start, lastCut).join(""));
      start = lastCut;
    } else {
      // One block bigger than the room: cut by line, then resume at the next boundary.
      let next = Math.max(end, start + 1);
      while (next < lines.length && !isBoundary(lines[next]!)) next++;
      out.push(...splitLines(lines.slice(start, next).join(""), header, maxChars));
      start = next;
    }
  }
  return out;
};

/** Last resort for one oversize hunk: cut on line boundaries (a line longer than
 *  the room is cut hard — a minified line is not worth a chunk of its own). */
const splitLines = (text: string, header: string, maxChars: number): string[] => {
  const room = Math.max(1, maxChars - header.length);
  const out: string[] = [];
  let cur = "";
  for (const raw of text.split(/(?<=\n)/)) {
    for (let i = 0; i < raw.length; i += room) {
      const line = raw.slice(i, i + room);
      if (cur.length + line.length > room) {
        out.push(header + cur);
        cur = "";
      }
      cur += line;
    }
  }
  if (cur !== "") out.push(header + cur);
  return out;
};

/**
 * Plan the chunks for a (noise-stripped, ignore-filtered) diff. Files are taken
 * highest {@link fileSignal} first (ties keep diff order); pieces pack greedily
 * into chunks of at most `maxChars` (a whole hunk up to `maxHunkChars` gets a
 * chunk of its own). Once `maxChunks` chunks are full, every
 * remaining file is listed in `notReviewed` — a file with some pieces in and
 * some out is listed as "partially reviewed".
 */
export const planChunks = (
  diff: string,
  opts: { readonly maxChars: number; readonly maxChunks: number; readonly maxHunkChars?: number },
): ChunkPlan => {
  const maxChars = Math.max(200, Math.floor(opts.maxChars));
  const maxHunkChars = Math.max(maxChars, Math.floor(opts.maxHunkChars ?? DEFAULT_MAX_HUNK_CHARS));
  const maxChunks = Math.max(1, Math.floor(opts.maxChunks));
  const files = splitDiffFiles(diff)
    .map((f, i) => ({ f, i, signal: fileSignal(f.path) }))
    .sort((a, b) => b.signal - a.signal || a.i - b.i)
    .map((x) => x.f);

  const chunks: { paths: string[]; text: string }[] = [];
  const notReviewed: NotReviewed[] = [];
  const capReason = `not reviewed: chunk cap (${maxChunks}) reached`;
  for (const file of files) {
    const pieces = splitFile(file, maxChars, maxHunkChars);
    let placed = 0;
    for (const piece of pieces) {
      const last = chunks[chunks.length - 1];
      if (last !== undefined && last.text.length + piece.length <= maxChars) {
        last.text += piece;
        if (last.paths[last.paths.length - 1] !== file.path) last.paths.push(file.path);
      } else if (chunks.length < maxChunks) {
        chunks.push({ paths: [file.path], text: piece });
      } else {
        break;
      }
      placed++;
    }
    if (placed === 0) notReviewed.push({ path: file.path, reason: capReason });
    else if (placed < pieces.length) {
      notReviewed.push({
        path: file.path,
        reason: `partially reviewed: ${pieces.length - placed} of ${pieces.length} parts past the chunk cap (${maxChunks})`,
      });
    }
  }
  return { chunks: chunks.map((c, id) => ({ id, paths: c.paths, text: c.text })), notReviewed };
};

// ---------------------------------------------------------------------------
// Cross-chunk context. A chunk reviewer reads its chunk only; these two helpers
// give it (and the verifier) enough of the rest of the MR to see that a thing
// removed here is added back elsewhere.

const YAML_KEY = /^([A-Za-z_.$"'][^\s:]*(?::[^\s:]+)*):(\s|$)/;
const DECL =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:pub\s+)?(?:function\*?|const|let|var|class|interface|type|enum|def|fn|func|struct)\s+([A-Za-z_$][\w$]*)/;

/** The name a top-level (unindented) line declares — a YAML key or a code declaration. */
const topLevelName = (content: string): string | undefined => DECL.exec(content)?.[1] ?? YAML_KEY.exec(content)?.[1];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does `line` name `name` as a whole token (not inside a longer name — `lint` is not in `prelint`)? */
const namesToken = (line: string, name: string): boolean =>
  new RegExp(`(^|[^\\w-])${escapeRe(name)}($|[^\\w-])`).test(line);

/** Added / removed body lines of a file section (no `+++`/`---` headers). */
const changedLines = (text: string, sign: "+" | "-"): string[] =>
  text.split("\n").filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3)));

const listNames = (names: readonly string[], max = 12): string =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")}, … +${names.length - max}`;

/**
 * A short map of the WHOLE diff for every chunk reviewer: per file, its hunk
 * headers and the top-level keys/symbols it removes and adds, and each removed
 * name that still appears in the MR's added lines. At most `maxChars`.
 */
export const DIFF_MAP_MAX_CHARS = 4_000;

export const buildDiffMap = (diff: string, maxChars = DIFF_MAP_MAX_CHARS): string => {
  const files = splitDiffFiles(diff);
  const allAdded = files.flatMap((f) => changedLines(f.text, "+").map((l) => ({ path: f.path, l })));
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const hunks = f.text.split("\n").filter((l) => l.startsWith("@@")).map((h) => h.slice(0, 80));
    const names = (sign: "+" | "-"): string[] => [
      ...new Set(changedLines(f.text, sign).flatMap((l) => topLevelName(l.slice(1)) ?? [])),
    ];
    const removed = names("-");
    const added = names("+");
    const addedSet = new Set(added);
    const back = removed
      .filter((n) => !addedSet.has(n))
      .flatMap((n) => {
        const hit = allAdded.find((a) => namesToken(a.l.slice(1), n));
        return hit !== undefined ? [`${n} still in added lines (${hit.path})`] : [];
      });
    const parts = [
      `- ${f.path}: ${hunks.length} hunk(s) ${listNames(hunks, 6)}`,
      ...(removed.length > 0 ? [`  removed: ${listNames(removed)}`] : []),
      ...(added.length > 0 ? [`  added: ${listNames(added)}`] : []),
      ...(back.length > 0 ? [`  note: ${listNames(back, 8)}`] : []),
    ].join("\n");
    const tail = `… ${files.length - i} more file(s) not listed`;
    if (used + parts.length + 1 + tail.length > maxChars) {
      lines.push(tail);
      break;
    }
    lines.push(parts);
    used += parts.length + 1;
  }
  return lines.join("\n").slice(0, maxChars);
};

const CLAIMS_ABSENCE =
  /remov|delet|missing|cut off|truncat|replacement|not (?:added|defined|present|found|included)|does not (?:add|define|include|contain)|dropped|\bgone\b|no longer/i;

/** Names a finding points at: `backticked` text and identifiers with a -, _, :, . or camelCase hump. */
const findingNames = (text: string): string[] => {
  const ticks = [...text.matchAll(/`([^`\n]{3,80})`/g)].map((m) => m[1]!.trim());
  const idents = [...text.matchAll(/[A-Za-z_$][\w$]*(?:[-_:.][\w$]+)+|[a-z]+[A-Z][\w$]*/g)].map((m) => m[0]);
  return [...new Set([...ticks, ...idents].map((s) => s.replace(/[.:,;]+$/, "")).filter((s) => s.length >= 4))];
};

/**
 * For a finding that claims something was removed, missing or cut off: the
 * post-change lines (±3 lines of context) that name the same thing ANYWHERE in
 * the MR, from every chunk's added lines. Empty when the finding claims no
 * absence or nothing matches. At most `maxChars`.
 */
export const addedContextFor = (findingText: string, chunkTexts: readonly string[], maxChars: number): string => {
  if (!CLAIMS_ABSENCE.test(findingText)) return "";
  const names = findingNames(findingText);
  if (names.length === 0) return "";
  const out: string[] = [];
  let used = 0;
  const seen = new Set<string>();
  for (const [ci, text] of chunkTexts.entries()) {
    for (const file of splitDiffFiles(text)) {
      const ls = file.text.split("\n");
      for (let i = 0; i < ls.length; i++) {
        const l = ls[i]!;
        if (!l.startsWith("+") || l.startsWith("+++")) continue;
        const name = names.find((n) => namesToken(l.slice(1), n));
        if (name === undefined) continue;
        const from = Math.max(0, i - 3);
        const to = Math.min(ls.length, i + 4);
        const key = `${ci}:${file.path}:${from}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const snippet = `# ${file.path} (added lines naming ${name})\n${ls.slice(from, to).join("\n")}\n`;
        if (used + snippet.length > maxChars) return out.join("");
        out.push(snippet);
        used += snippet.length;
        i = to - 1;
      }
    }
  }
  return out.join("");
};
