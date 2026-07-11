// @fractalbox/flare-dispatch-core — the `signals/v1` contract.
//
// A *signal* is one normalized observability finding a CONSUMER collected from
// a system the dispatcher's read capabilities don't reach — an APM/tracing
// SaaS, runtime exception logs, health probes, an alert webhook. The contract
// is deliberately the narrow waist of the triage pipeline: the dispatcher
// stays vendor-blind (it never queries Datadog/SigNoz/HyperDX/…), and any
// vendor is supported on day one by a consumer-side adapter that prints this
// shape. Vendor-specific query logic, credentials, and severity semantics all
// live with the caller.
//
// --- Producer contract (what a collector/adapter MUST do) --------------------
//
//   1. stdout is ONLY the JSON payload — a `Signal[]` (or an inputs object
//      embedding one). Diagnostics go to stderr.
//   2. Always exit 0 with a valid (possibly empty) array. Each source the
//      collector scans degrades to empty INDEPENDENTLY — a partial outage
//      still produces a dispatch with whatever was observable.
//   3. Respect the caps below. The dispatch gate Schema-decodes against this
//      contract and rejects an oversized payload as a 400; collectors should
//      group + truncate (one signal per failure CLUSTER, not per raw event)
//      rather than rely on the gate.
//   4. Order by severity, worst first — array order is the only ranking the
//      contract carries.
//
// Versioning: additive changes (new OPTIONAL fields) stay `v1`. Renaming,
// removing, or tightening a field is `v2` — a new schema, not an edit.
//
// Spec: specs/02-runs.md § Signals.

import { Schema } from "effect";

/** The contract version. Bump only on breaking change (see header). */
export const SIGNALS_CONTRACT_VERSION = "v1";

// Caps — bound a dispatch body well under the CF Workflows params ceiling
// (50 × ~2 KB detail ≈ 100 KB worst case) and turn an oversized dispatch into
// a clean 400 at the dispatch gate instead of a silent overflow downstream.
export const MAX_SIGNALS = 50;
export const MAX_SIGNAL_SOURCE_CHARS = 120;
export const MAX_SIGNAL_TITLE_CHARS = 200;
export const MAX_SIGNAL_DETAIL_CHARS = 2_000;
export const MAX_SIGNAL_URL_CHARS = 1_000;

/**
 * One caller-supplied observability signal — `signals/v1`.
 */
export const Signal = Schema.Struct({
  /**
   * Which system produced the signal. Convention: `vendor-or-surface[:scope]`,
   * e.g. "workers-observability:my-api", "datadog:monitor", "health-probe".
   */
  source: Schema.String.pipe(Schema.maxLength(MAX_SIGNAL_SOURCE_CHARS)),
  /** Short title naming the error. */
  title: Schema.String.pipe(Schema.maxLength(MAX_SIGNAL_TITLE_CHARS)),
  /** Enough detail for a model to triage (message, context, window). */
  detail: Schema.String.pipe(Schema.maxLength(MAX_SIGNAL_DETAIL_CHARS)),
  /** Optional deep link into the producing system. */
  url: Schema.optional(Schema.String.pipe(Schema.maxLength(MAX_SIGNAL_URL_CHARS))),
  /** Optional occurrence count over the caller's window. */
  count: Schema.optional(Schema.Number),
});
export type SignalT = typeof Signal.Type;

/** The capped array shape runs accept as input. */
export const SignalArray = Schema.Array(Signal).pipe(Schema.maxItems(MAX_SIGNALS));
