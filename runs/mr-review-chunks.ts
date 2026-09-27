// The MAP side of the large-MR review: split a unified diff into review chunks.
//
// A large MR used to hit two walls at once: `capDiff` silently truncated the diff
// at `maxDiffChars`, and one model call over a long diff ran past Workers AI's
// request timeout (3046) or spent its whole token budget reasoning (an empty
// answer). The review now runs one model pass per CHUNK instead:
//
//   * split the diff by file (`diff --git` sections);
//   * split a file bigger than the chunk size by hunk (`@@`), and a hunk bigger
//     than the chunk size by line — every piece repeats the file header so the
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

/** Split one file section into pieces of at most `maxChars`, each led by the file header. */
const splitFile = (file: DiffFile, maxChars: number): readonly string[] => {
  if (file.text.length <= maxChars) return [file.text];
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
    else pieces.push(...splitLines(hunk, header, maxChars));
  }
  if (cur !== "") pieces.push(header + cur);
  return pieces;
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
 * into chunks of at most `maxChars`. Once `maxChunks` chunks are full, every
 * remaining file is listed in `notReviewed` — a file with some pieces in and
 * some out is listed as "partially reviewed".
 */
export const planChunks = (
  diff: string,
  opts: { readonly maxChars: number; readonly maxChunks: number },
): ChunkPlan => {
  const maxChars = Math.max(200, Math.floor(opts.maxChars));
  const maxChunks = Math.max(1, Math.floor(opts.maxChunks));
  const files = splitDiffFiles(diff)
    .map((f, i) => ({ f, i, signal: fileSignal(f.path) }))
    .sort((a, b) => b.signal - a.signal || a.i - b.i)
    .map((x) => x.f);

  const chunks: { paths: string[]; text: string }[] = [];
  const notReviewed: NotReviewed[] = [];
  const capReason = `not reviewed: chunk cap (${maxChunks}) reached`;
  for (const file of files) {
    const pieces = splitFile(file, maxChars);
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
