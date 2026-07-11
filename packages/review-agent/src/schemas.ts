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
export const Finding = Schema.Struct({
  path: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
  level: Schema.Literal("notice", "warning", "failure"),
  title: Schema.String,
  message: Schema.String,
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
