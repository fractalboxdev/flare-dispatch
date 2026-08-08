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
// `parseRepo` and `parseRepoRelativePath` are here for the same reason and one
// more: they are the validators standing between a CONFIG_KV string and a
// write. Every scheduled run that files a PR against a control repo needs both,
// and a per-run copy of a security-relevant check is a per-run chance to get it
// subtly different.
//
// Pure — no capability needed (like `sharded`). Layer: 03-dsl § Primitives.

/** The UTC calendar date (`YYYY-MM-DD`) for an epoch-ms instant. */
export const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Split a comma / whitespace / newline-separated list (e.g. a CONFIG_KV repo or
 * project list), trimming entries and dropping blanks.
 */
export const parseList = (raw: string | undefined): readonly string[] =>
  (raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * A configured `owner/name`, or `undefined` when the value is unusable.
 *
 * Validated rather than trusted because this string decides which repository
 * receives a pull request. Unset and malformed are deliberately the SAME answer
 * — both mean the operator did not name a repository, and neither may be
 * guessed past by falling back to some repo the code happens to know.
 */
export const parseRepo = (raw: string | undefined | null): string | undefined => {
  const trimmed = (raw ?? "").trim();
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : undefined;
};

/**
 * A configured repo-relative path, or `undefined` when it escapes the root.
 *
 * Config is a trusted-ish input — an operator wrote it — but these values
 * become paths in a commit and in `contents` API reads, and the failure they
 * guard is not malice: a leading `/` or a stray `../` produces a path that
 * means something other than what the operator read back. An empty value takes
 * the caller's fallback rather than erroring, so "unset" behaves like a fresh
 * install.
 */
export const parseRepoRelativePath = (
  raw: string | undefined | null,
  fallback: string,
): string | undefined => {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return fallback;
  if (trimmed.startsWith("/") || trimmed.includes("\\")) return undefined;
  if (trimmed.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return undefined;
  return trimmed;
};
