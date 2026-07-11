// FlareDispatch Dispatcher — per-execution log-viewer capability tokens.
//
// The log-viewer surfaces (`/logs/:execution`, `/v1/executions/:id`,
// `/v1/executions/:id/logs[/:file]`) serve the COMPLETE raw stdout/stderr of
// every command a run executed — which routinely contains secrets (`set -x`
// traces, env dumps, tokens smuggled into URLs). The existing
// `/v1/artifacts/:execution/:name` route is unauthenticated-by-id, but it only
// serves what a run *explicitly promoted* via `artifact.upload` (an
// operator-curated subset); the log routes serve everything, retroactively.
//
// And the execution id is DERIVABLE, not opaque: the dispatch path builds it as
// `{run}:{owner_repo}:{sha12}` (routes/dispatch.ts `semanticInstanceId`) — run
// names ship in this open-source repo's registry, repo+sha are public GitHub
// data — so "obscure id" is no barrier at all. A reviewer (the security panel,
// `.tmp/log-viewer-design-review.md` § B2) flagged that exposing raw logs on a
// guessable id is materially worse than the artifacts precedent.
//
// So every per-execution surface requires a CAPABILITY TOKEN bound to the
// execution id:
//
//   token = base64url( HMAC-SHA256( k_logs, executionId ) )[0..22)   // 132 bits
//   k_logs = HKDF-SHA256( ikm, salt="", info="flare-dispatch/log-link/v1" )
//
// `k_logs` is HKDF-derived (domain-separated by the `info` label) so a log
// token can never be confused with — or forged from — a dispatch HMAC, even
// when both derive from the same input keying material.
//
// --- Key material: LOG_LINK_SECRET, falling back to HMAC_SECRET --------------
//
// `ikm` prefers a dedicated `LOG_LINK_SECRET` secret. When unset it falls back
// to `HMAC_SECRET` — which every Action-mode deploy already provisions and the
// deploy workflow re-syncs on every push — so the viewer is tokened-by-default
// with ZERO new repo secrets. The HKDF label keeps the derived key independent
// of the raw-bytes HMAC the dispatch route verifies, so reuse is safe. When
// NEITHER is set (a degenerate deploy), the routes default-DENY (`503`): the
// token surface is never silently default-open.
//
// Residual risk, documented in specs/05-byoc.md: a token embedded in a *public*
// repo's check-run is itself public — that is a per-run disclosure the operator
// makes by publishing the link. The token's job is to stop DERIVATION: private
// repos, executions never linked anywhere, and retroactive enumeration of
// history all stay closed.

import { makeCapabilityToken } from "./capability-token";
import type { Env } from "./env";

/** HKDF `info` label — domain-separates `k_logs` from the dispatch HMAC key. */
const HKDF_INFO = "flare-dispatch/log-link/v1";

const token = makeCapabilityToken(HKDF_INFO);

/**
 * The valid shape of an execution id wherever it arrives in a URL path. Covers
 * the semantic `{run}:{owner_repo}:{sha12}` form (the `:` separator), dashed
 * legacy ids, ULIDs, and caller-chosen `Idempotency-Key` values — while
 * refusing anything that could smuggle a path traversal, a `/`, or markdown
 * link-breaking punctuation into a generated URL (review M5/m11). Bounded to
 * keep it well under CF Workflows' 64-char instance-id limit's neighbours and
 * any reasonable custom key.
 */
export const EXECUTION_ID_RE = /^[A-Za-z0-9:_-]{3,128}$/;

/** True iff `id` is a syntactically-valid execution id (see `EXECUTION_ID_RE`). */
export const isValidExecutionId = (id: string): boolean =>
  EXECUTION_ID_RE.test(id);

/**
 * The keying material for log tokens: a dedicated `LOG_LINK_SECRET` if set,
 * else `HMAC_SECRET`. `undefined` only when neither is present (→ the routes
 * default-deny). Empty strings are treated as unset.
 */
export const resolveLogLinkSecret = (env: Env): string | undefined => {
  const dedicated = env.LOG_LINK_SECRET;
  if (typeof dedicated === "string" && dedicated.length > 0) return dedicated;
  const hmac = env.HMAC_SECRET;
  if (typeof hmac === "string" && hmac.length > 0) return hmac;
  return undefined;
};

/** Mint the capability token for `executionId` under the given key material. */
export const signLogToken = token.sign;

/**
 * Verify a presented token for `executionId`. Recomputes the expected token and
 * compares constant-time. `false` for a missing/short token or any mismatch.
 */
export const verifyLogToken = token.verify;

/**
 * Build the tokened log-viewer URL for an execution — the link embedded in the
 * dispatch 202, the check-run summary, and the inline-truncation breadcrumb.
 * `origin` is the dispatcher's public origin (no trailing slash); `fragment`,
 * when given, deep-links to one log file's section (e.g. `exec-2.ndjson`).
 */
export const buildLogsUrl = (
  origin: string,
  executionId: string,
  token: string,
  fragment?: string,
): string => {
  const base = `${origin.replace(/\/$/, "")}/logs/${encodeURIComponent(
    executionId,
  )}?t=${token}`;
  return fragment !== undefined && fragment.length > 0
    ? `${base}#${encodeURIComponent(fragment)}`
    : base;
};
