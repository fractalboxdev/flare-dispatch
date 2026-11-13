// Log object naming as a V-REPLAY workflow (specs/cache-artifacts.md FD-CACHE-081). One run executes a gate job's
// steps; each step's stdout and stderr go up as NDJSON segments of at most `SEGMENT_BYTES`, each named by
// `logObjectName` from the step's journal name, the epoch and the segment's byte offsets. The journal keeps the step
// results the engine recorded and the log bucket. The first run's executor is lost after the last steps uploaded their
// logs and before their results were journaled, so a second run over the journal reruns those steps in a new process,
// as an engine replay does, and uploads their segments again.
//
// Effects: `intent` for each log segment `PUT`, keyed by the object name.
import type { ReplayEffect, ReplayWorkflow } from "../../../ops/src/verification/harness.ts";
import { logObjectName } from "../../src/logs.ts";
import type { Bucket } from "../../src/manifest.ts";
import { simBucket } from "../sim/cache.sim.ts";

export const EXECUTION = "exec-replay-logs";
export const EPOCH = 2;
/** The longest segment the executor uploads, in bytes of NDJSON. */
export const SEGMENT_BYTES = 96;

/** The job's steps by journal name, each with the lines it writes to each stream. */
export const STEPS: readonly {
  readonly journalName: string;
  readonly lines: Readonly<Record<"stdout" | "stderr", readonly string[]>>;
}[] = [
  {
    journalName: "checkout",
    lines: { stdout: ["fetching 0123456", "checked out FETCH_HEAD"], stderr: [] },
  },
  {
    journalName: "install",
    lines: {
      stdout: Array.from({ length: 6 }, (_, i) => `resolved package ${i} of 6`),
      stderr: ["warn: peer dependency missing"],
    },
  },
  {
    journalName: "test:shard-1/2",
    lines: {
      stdout: Array.from({ length: 5 }, (_, i) => `ok ${i + 1} - suite ${i + 1}`),
      stderr: [],
    },
  },
  {
    journalName: "test:shard-2/2",
    lines: {
      stdout: Array.from({ length: 4 }, (_, i) => `ok ${i + 6} - suite ${i + 6}`),
      stderr: ["deprecation: Buffer()"],
    },
  },
];

/** How many leading steps had their results journaled before the first run's executor was lost. */
export const JOURNALED_STEPS = 2;

/** What a rerun finds in place: the journaled step results and the log objects already uploaded. */
export interface Journal {
  readonly results: Map<string, string>;
  readonly bucket: Bucket;
}

export interface LogNameRun {
  readonly journal: Journal;
  readonly effects: readonly ReplayEffect[];
  /** The journal names of the steps this run executed. */
  readonly ran: readonly string[];
}

const encoder = new TextEncoder();

/** One stream's NDJSON lines cut into segments of at most `SEGMENT_BYTES`, each with its byte offsets. */
const segmentsOf = (lines: readonly string[]) => {
  const segments: { start: number; end: number; body: string }[] = [];
  let start = 0;
  let body = "";
  for (const line of lines) {
    const record = `${JSON.stringify({ line })}\n`;
    if (body !== "" && encoder.encode(body + record).byteLength > SEGMENT_BYTES) {
      const end = start + encoder.encode(body).byteLength;
      segments.push({ start, end, body });
      start = end;
      body = "";
    }
    body += record;
  }
  if (body !== "") segments.push({ start, end: start + encoder.encode(body).byteLength, body });
  return segments;
};

/** Runs the job from no journal, or reruns over `journal` every step whose result it lacks. */
export const logNameRun = async (journal: Journal | null): Promise<LogNameRun> => {
  const effects: ReplayEffect[] = [];
  const ran: string[] = [];
  const results = journal?.results ?? new Map<string, string>();
  const bucket = journal?.bucket ?? simBucket(() => 0);
  for (const [index, step] of STEPS.entries()) {
    if (results.has(step.journalName)) continue;
    ran.push(step.journalName);
    for (const stream of ["stdout", "stderr"] as const)
      for (const segment of segmentsOf(step.lines[stream])) {
        const name = await logObjectName({
          executionId: EXECUTION,
          epoch: EPOCH,
          journalName: step.journalName,
          stream,
          start: segment.start,
          end: segment.end,
        });
        if (name === undefined) throw new Error(`no log name for ${step.journalName} ${stream}`);
        await bucket.put(name, segment.body);
        effects.push({ kind: "intent", key: `log ${name}` });
      }
    // The first run's executor is lost before the later steps' results reach the journal.
    if (journal !== null || index < JOURNALED_STEPS) results.set(step.journalName, "success");
  }
  return { journal: { results, bucket }, effects, ran };
};

/** The workflow the `replay` job runs twice (FD-VER-025). */
export const workflows: readonly ReplayWorkflow<Journal>[] = [
  { name: "log-name", ids: ["FD-CACHE-081"], run: logNameRun },
];
