// Primitives: small pure helpers for Schedule-mode runs.
//
// Trivial, capability-free utilities the cron-driven runs share — `isoDate`
// (the UTC day key used for cron-window dedup + dated branch/file names) and
// `parseList` (split a comma/space/newline-separated CONFIG_KV value). They live
// here, not in a sibling `runs/_shared.ts`, so a recipe that is a verbatim copy
// of its deployed run still resolves the import (recipes already import from
// `@fractalboxdev/flare-dispatch-core/primitives`); a relative sibling import would break the
// copy.
//
// Pure — no capability needed (like `sharded`). Layer: 03-dsl § Primitives.

/** The UTC calendar date (`YYYY-MM-DD`) for an epoch-ms instant. */
export const isoDate = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 10);

/**
 * Split a comma / whitespace / newline-separated list (e.g. a CONFIG_KV repo or
 * project list), trimming entries and dropping blanks.
 */
export const parseList = (raw: string | undefined): readonly string[] =>
  (raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
