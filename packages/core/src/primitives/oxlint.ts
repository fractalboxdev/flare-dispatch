// Primitives: classifying oxlint's output.
//
// oxlint exits NON-ZERO (1) when it has nothing to lint, printing on stdout:
//
//   No files found to lint. Please check your paths and ignore patterns.
//
// A repo with no JS/TS surface at all (Rust / Python / Go / docs-only), a tree
// whose sources are entirely gitignored, or an `args` path filter that matches
// no file all land here — an exit code INDISTINGUISHABLE from a genuine lint
// finding. Classifying on the exit code alone turned the `oxlint` gate red on
// repos that simply have nothing for it to lint, and fed `pr-review`'s model the
// sentinel as though it were a static-analysis finding.
//
// Same shape as runtime-cf's `isWorkingDirFailure`: a non-zero exit that is not
// a verdict gets reclassified before it can masquerade as one.
//
// Pure — no capability needed (like `scheduling`). Layer: 03-dsl § Primitives.

/**
 * oxlint's "nothing to lint" sentinel, anchored to the start of a line: a real
 * diagnostic renders its source snippets indented behind a `│` gutter, so it
 * cannot produce this text at column 0.
 */
const NOTHING_TO_LINT = /^No files found to lint\b/m;

/**
 * True when oxlint's output says it had nothing to lint — a no-op, NOT a lint
 * verdict, however the process exited. Pass the command's stdout (the stream the
 * sentinel is written to); combined stdout+stderr works too.
 */
export const isNothingToLint = (output: string): boolean => NOTHING_TO_LINT.test(output);
