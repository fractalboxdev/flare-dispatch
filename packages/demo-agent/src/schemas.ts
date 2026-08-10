// @fractalboxdev/flare-dispatch-demo-agent — JSON output contracts.
//
// Every subcommand that emits structured stdout pins its shape here. The
// `product-demo` run parses the last line of stdout as one of these — see
// runs/product-demo.ts. Keeping the schemas alongside the CLI (not in
// @fractalboxdev/flare-dispatch-core) means the run-side parse types and the agent-side
// emit types are derived from the same source.

import { Schema } from "effect";

/** Viewport preset → CDP `Emulation.setDeviceMetricsOverride` parameters. */
export const ViewportPreset = Schema.Literal("desktop", "mobile");
export type ViewportPreset = typeof ViewportPreset.Type;

export type ViewportDims = {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly mobile: boolean;
};

export const VIEWPORTS: Readonly<Record<ViewportPreset, ViewportDims>> = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
};

/** `record stop` emits this on the LAST line of stdout. */
export const RecordStopOutput = Schema.Struct({
  sessionId: Schema.String,
  eventCount: Schema.Number,
});
export type RecordStopOutput = typeof RecordStopOutput.Type;

/** `play` emits this on the LAST line of stdout. */
export const PlayOutput = Schema.Struct({
  status: Schema.Literal("passed", "failed"),
  durationMs: Schema.Number,
  chapterStartMs: Schema.Number,
  chapterEndMs: Schema.Number,
  narrative: Schema.String,
  keyScreenshotPath: Schema.String,
});
export type PlayOutput = typeof PlayOutput.Type;

/** One model-picked action — the unit the play loop applies via CDP. */
export const ModelAction = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("click"),
    /** Accessibility-tree node ID (preferred) or CSS selector fallback. */
    target: Schema.String,
    rationale: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("type"),
    target: Schema.String,
    text: Schema.String,
    rationale: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("nav"),
    url: Schema.String,
    rationale: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    /** CDP key code, e.g. "Enter", "Tab", "Escape". */
    key: Schema.String,
    rationale: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("wait"),
    /** Milliseconds (clamped 0–5000 by the loop). */
    ms: Schema.Number,
    rationale: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("screenshot"),
    /** Marks this frame as the story's "key screenshot". */
    rationale: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("done"),
    /** Becomes the story's `narrative` field. */
    narrative: Schema.String,
    /** Whether the story succeeded ("passed") or failed mid-walkthrough ("failed"). */
    status: Schema.Literal("passed", "failed"),
  }),
);
export type ModelAction = typeof ModelAction.Type;

/** One story result inside the stories.json the summarizer reads. */
export const StorySummaryInput = Schema.Struct({
  name: Schema.String,
  status: Schema.Literal("passed", "failed"),
  durationMs: Schema.Number,
  chapterStartMs: Schema.Number,
  chapterEndMs: Schema.Number,
  narrative: Schema.String,
  keyScreenshotUri: Schema.String,
});
export type StorySummaryInput = typeof StorySummaryInput.Type;

/** The full stories.json file the summarizer reads. */
export const StoriesJson = Schema.Struct({
  stories: Schema.Array(StorySummaryInput),
  replayUri: Schema.String,
  replayJsonUri: Schema.String,
});
export type StoriesJson = typeof StoriesJson.Type;
