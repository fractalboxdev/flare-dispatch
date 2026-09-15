// mr-review — config-driven path ignore for the reviewable diff.
//
// Some paths must never reach the model: planted-defect fixtures for testing the
// reviewer, vendored code, generated docs. `stripDiffNoise` handles the universal
// cases (lockfiles, minified bundles); this module handles the per-deploy list from
// CONFIG_KV `pr-review.ignorePaths` — comma-separated globs where `**` spans
// directories and `*` stops at `/`. Pure: no I/O.

/** Compile one glob into an anchored RegExp. */
export const globToRegExp = (glob: string): RegExp => {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` also matches zero directories
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
};

/** Parse the CONFIG_KV value: comma- or newline-separated globs, blanks dropped. */
export const parseIgnorePaths = (raw: string | null | undefined): readonly string[] =>
  (raw ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** The path a `diff --git a/<old> b/<new>` header names on the new side. */
const headerPath = (header: string): string | null => {
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
  return m ? m[2]! : null;
};

/**
 * Drop every per-file section of a unified diff whose new path matches one of the
 * globs. Returns the kept diff and the dropped paths (for the summary). A diff with no
 * `diff --git` headers is returned unchanged.
 */
export const stripIgnoredPaths = (
  diff: string,
  globs: readonly string[],
): { readonly diff: string; readonly dropped: readonly string[] } => {
  if (globs.length === 0) return { diff, dropped: [] };
  const res = globs.map(globToRegExp);
  const sections = diff.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const section of sections) {
    const firstLine = section.split("\n", 1)[0] ?? "";
    const path = headerPath(firstLine);
    if (path !== null && res.some((r) => r.test(path))) {
      dropped.push(path);
    } else {
      kept.push(section);
    }
  }
  return { diff: kept.join(""), dropped };
};

/**
 * The unified-diff section for one file's NEW path, or `null` when no
 * `diff --git` section matches — a model-hallucinated path, or a diff carrying
 * no headers at all. Reuses the same section split + header parse as
 * {@link stripIgnoredPaths} so verification sends a reviewer only the hunk for
 * the file its finding names, instead of the whole diff. Pure.
 */
export const diffSectionForPath = (diff: string, path: string): string | null => {
  const sections = diff.split(/^(?=diff --git )/m);
  for (const section of sections) {
    const firstLine = section.split("\n", 1)[0] ?? "";
    if (headerPath(firstLine) === path) return section;
  }
  return null;
};
