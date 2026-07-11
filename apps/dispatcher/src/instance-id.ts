// Cloudflare Workflows instance-id sanitization.
//
// Every dispatch path (webhook, scheduled, direct `/v1/dispatch`) derives a
// Workflow `instanceId` from a SEMANTIC key — a run's `idempotencyKey(ctx)`
// like `pr-review:owner/repo:42:<40-char-sha>`, or `semanticInstanceId`'s
// `run:owner_repo:sha12`. Those keys are great for dedup (same logical event →
// same id → `create({ id })` is a no-op) but are NOT valid instance ids:
// Cloudflare Workflows accepts only `[A-Za-z0-9_-]` and caps the id at 64
// chars. A raw key with `:` / `/` (or one that overruns 64) makes
// `create({ id })` fail with `instance.invalid_id` — the run never starts.
//
// `toInstanceId` maps any semantic key into a valid id DETERMINISTICALLY, so
// the dedup contract is preserved (same key → same id):
//   * swap every disallowed char for `_`;
//   * when the result exceeds 64 chars, keep a 64-char-bounded prefix plus a
//     stable djb2 suffix of the ORIGINAL key, so two keys that share a long
//     prefix but differ in their (truncated-away) tail still map to distinct
//     ids.

/** Cloudflare Workflows instance ids allow only these chars and cap at 64. */
const MAX_INSTANCE_ID_LEN = 64;
const DISALLOWED = /[^A-Za-z0-9_-]/g;

/** djb2 — a small, fast, deterministic string hash (returned unsigned). */
const djb2 = (s: string): number => {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  }
  return hash;
};

/**
 * Map a semantic dedup key to a valid, deterministic CF Workflows instance id.
 * Idempotent for already-valid keys (≤64 chars, allowed charset) — they pass
 * through unchanged.
 */
export const toInstanceId = (raw: string): string => {
  const safe = raw.replace(DISALLOWED, "_");
  if (safe.length <= MAX_INSTANCE_ID_LEN) return safe;
  // Too long: keep a prefix + a stable suffix derived from the FULL original
  // key, so distinct keys can't collide after truncation. Suffix is base36 of
  // a uint32 (≤7 chars), leaving a comfortable prefix budget.
  const suffix = djb2(raw).toString(36);
  return `${safe.slice(0, MAX_INSTANCE_ID_LEN - suffix.length - 1)}_${suffix}`;
};
