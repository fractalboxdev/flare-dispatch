// @fractalboxdev/flare-dispatch-review-agent — diff noise stripping.
//
// `git diff` output includes high-volume, low-signal hunks the model should
// never burn tokens on: lockfiles, minified bundles, generated code, vendored
// trees. `stripDiffNoise` drops whole per-file sections whose path matches a
// noise pattern, keeping the rest of the unified diff intact. Pure — runs
// in-Worker on the captured diff text (no container exec).

/** Path fragments / extensions whose file sections are dropped wholesale. */
const NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)[^/]*lock(file)?(\.[a-z]+)?$/i, // package-lock.json, pnpm-lock.yaml, Cargo.lock, yarn.lock
  /(^|\/)[^/]*\.min\.(js|css)$/i, // minified bundles
  /(^|\/)(dist|build|out|vendor|node_modules)\//i, // generated / vendored trees
  /\.(snap|map)$/i, // snapshots, sourcemaps
  /(^|\/)[^/]*\.generated\.[a-z]+$/i, // *.generated.*
];

/** A `+++ b/<path>` line opens a new file section in a unified diff. */
const isNoisyPath = (path: string): boolean =>
  NOISE_PATTERNS.some((re) => re.test(path));

/**
 * Drop every per-file section whose target path matches a noise pattern.
 * Sections are delimited by `diff --git` lines (git's canonical separator).
 * A section before the first `diff --git` (rare preamble) is kept.
 */
export const stripDiffNoise = (diff: string): string => {
  if (diff.trim() === "") return diff;
  const lines = diff.split("\n");

  type Section = { header: string[]; path: string | undefined; body: string[] };
  const sections: Section[] = [];
  let current: Section | undefined;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      current = { header: [line], path: undefined, body: [] };
      sections.push(current);
      // `diff --git a/<p> b/<p>` — derive the path from the b-side.
      const m = line.match(/ b\/(.+)$/);
      if (m) current.path = m[1];
      continue;
    }
    if (current === undefined) {
      // Preamble before any `diff --git` — keep as a path-less section.
      current = { header: [], path: undefined, body: [line] };
      sections.push(current);
      continue;
    }
    current.body.push(line);
  }

  return sections
    .filter((s) => s.path === undefined || !isNoisyPath(s.path))
    .map((s) => [...s.header, ...s.body].join("\n"))
    .join("\n");
};

/**
 * Fallback max chars of (noise-stripped) diff sent to the model when the
 * caller doesn't pass a backend-sized cap. Prefer `ResolvedBackend.maxDiffChars`
 * (see backend.ts) — caps must track the model's context window: a huge PR
 * would otherwise blow the provider context (every domain reviewer embeds the
 * whole diff, and `full` tier fans out to seven of them), overflowing
 * invisibly instead of truncating visibly.
 */
export const MAX_DIFF_CHARS = 120_000;

/**
 * Truncate a diff to `maxChars`, appending a visible marker when it was cut so
 * the review (and the reader of its comment) knows it was based on a prefix.
 */
export const capDiff = (
  diff: string,
  maxChars: number = MAX_DIFF_CHARS,
): string =>
  diff.length <= maxChars
    ? diff
    : `${diff.slice(0, maxChars)}\n\n…(diff truncated at ${maxChars} chars — review covers the first portion only)…`;
