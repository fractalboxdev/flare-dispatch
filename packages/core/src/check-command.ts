import { Schema } from "effect";
import type { ExecOpts, ExecResult } from "./services/sandbox";

export const CheckCommandHandle = Schema.Struct({
  id: Schema.String,
  container: Schema.Struct({ id: Schema.String }),
  fingerprint: Schema.String,
  startedAt: Schema.Number,
  deadline: Schema.Number,
});
export type CheckCommandHandle = typeof CheckCommandHandle.Type;
export const CheckCommandObservation = Schema.Struct({
  state: Schema.Literal("running", "exited", "timeout", "missing"),
  exitCode: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
});
export type CheckCommandObservation = typeof CheckCommandObservation.Type;
export const CheckCommandLogState = Schema.Struct({
  stdoutOffset: Schema.Number,
  stderrOffset: Schema.Number,
  stdoutTail: Schema.String,
  stderrTail: Schema.String,
  chunks: Schema.Array(Schema.String),
});
export type CheckCommandLogState = typeof CheckCommandLogState.Type;
export const CheckCommandChunk = Schema.Struct({ text: Schema.String, bytes: Schema.Number });
export type CheckCommandChunk = typeof CheckCommandChunk.Type;

/** The process owner's RPC boundary; process identity survives Workflow retries. */
export interface CheckCommandOwner {
  start(opts: {
    handle: CheckCommandHandle;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<void>;
  observe(handle: CheckCommandHandle): Promise<CheckCommandObservation>;
  read(
    handle: CheckCommandHandle,
    stream: "stdout" | "stderr",
    offset: number,
    length: number,
  ): Promise<CheckCommandChunk>;
  logs(handle: CheckCommandHandle): Promise<CheckCommandLogState>;
  advanceLogs(
    handle: CheckCommandHandle,
    expected: CheckCommandLogState,
    next: CheckCommandLogState,
  ): Promise<void>;
  receipt(handle: CheckCommandHandle): Promise<ExecResult | undefined>;
  finish(handle: CheckCommandHandle, result: ExecResult): Promise<ExecResult>;
}
export type CheckCommandPrepare = ExecOpts & { readonly stepName: string };
