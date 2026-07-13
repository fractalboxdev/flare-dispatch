// @fractalboxdev/flare-dispatch-review-agent — shared schemas.
//
// `Finding` + `ReviewOutput` are the wire contract between the engine and the
// `pr-review` run. They MUST stay byte-for-byte identical to the shapes the run
// declares (runs/pr-review.ts) — the run's `outputs` schema is `ReviewOutput`,
// rendered into the check-run summary + annotations. A drift here silently
// breaks the check output, so both sides import this one definition.

import { Schema } from "effect";

/**
 * A single review finding. Maps 1:1 onto a GitHub check-run annotation (the run
 * returns `findings`; the dispatcher renders the annotation set) AND is rolled
 * into the visible PR review comment the engine posts.
 */
// Bounds are enforced at DECODE time (not render time): `path`/`title`/`message`
// are model-authored, and the model is steerable by a hostile PR diff. A cap
// here stops an oversized field from bloating the check-run body or comment
// before any rendering runs; the non-negative integer line numbers reject the
// `-1`/`NaN`/fractional values a model can emit (`findingUrl` drops a non-positive
// line, but the schema is the single choke). Character-level neutralisation of
// markdown/HTML still happens at render (`sanitizeModelText`); this is the
// length/shape gate that pairs with it.
export const Finding = Schema.Struct({
  path: Schema.String.pipe(Schema.maxLength(400)),
  startLine: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  endLine: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  level: Schema.Literal("notice", "warning", "failure"),
  title: Schema.String.pipe(Schema.maxLength(200)),
  message: Schema.String.pipe(Schema.maxLength(2_000)),
});
export type Finding = typeof Finding.Type;

/** The risk tier — selects which domain reviewers run. */
export const Tier = Schema.Literal("trivial", "lite", "full");
export type Tier = typeof Tier.Type;

/** The coordinator's verdict family — mirrors GitHub PR review events. */
export const Verdict = Schema.Literal("approve", "comment", "request-changes");
export type Verdict = typeof Verdict.Type;

/**
 * The coordinated output WITHOUT the tier (the engine's `coordinate` produces
 * this; the run stitches the tier back on from its plan). Pinned separately so
 * the engine's return type and the run's `Omit<ReviewOutput, "tier">` are the
 * same source.
 */
export const CoordinatedReview = Schema.Struct({
  verdict: Verdict,
  critical: Schema.Number,
  warnings: Schema.Number,
  suggestions: Schema.Number,
  findings: Schema.Array(Finding),
});
export type CoordinatedReview = typeof CoordinatedReview.Type;

/** The run's full output — `CoordinatedReview` + the resolved `tier`. */
export const ReviewOutput = Schema.Struct({
  verdict: Verdict,
  tier: Tier,
  critical: Schema.Number,
  warnings: Schema.Number,
  suggestions: Schema.Number,
  findings: Schema.Array(Finding),
});
export type ReviewOutput = typeof ReviewOutput.Type;
