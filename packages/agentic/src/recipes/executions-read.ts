// `ExecutionsRead` over the control plane's executions table and its log store (specs/runs/agentic.md
// § `ci-triage-pr`): the failed executions of one repository since a time, and the log of an execution's failing epoch
// as plain text. A failed read is `ReadFailed`, never an empty window or an empty log (FD-AGT-042).
import { Effect, Layer } from "effect";
import type { D1Binding } from "../local/store.ts";
import { ExecutionsRead, type FailedExecution } from "./ci-triage-pr.ts";
import { ReadFailed } from "./spec-drift-pr.ts";

/** The log store's listing and reads, as an R2 bucket answers them. */
export interface LogObjects {
  list(options: {
    readonly prefix: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{
    readonly objects: readonly { readonly key: string; readonly uploaded: Date }[];
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export interface ExecutionsReadConfig {
  /** The control plane's database: mameko's `executions` table, whose `scope_id` is the repository. */
  readonly db: D1Binding;
  /** The bucket that holds `logs/`. */
  readonly logs: LogObjects;
}

/** `logs/<execution_id>/<epoch>/<step_key>/<stream>-<start>-<end>.ndjson` (specs/cache-artifacts.md § Logs). */
const LOG_NAME =
  /^logs\/([A-Za-z0-9:_-]{3,128})\/([1-9][0-9]{0,8})\/([0-9a-f]{24})\/([a-z][a-z0-9]{0,15})-(0|[1-9][0-9]{0,15})-(0|[1-9][0-9]{0,15})\.ndjson$/;

interface LogSegment {
  readonly key: string;
  readonly uploaded: number;
  readonly epoch: number;
  readonly step: string;
  readonly stream: string;
  readonly start: number;
}

const listSegments = async (logs: LogObjects, executionId: string): Promise<LogSegment[]> => {
  const found: LogSegment[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await logs.list({
      prefix: `logs/${executionId}/`,
      limit: 1000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const o of page.objects) {
      const m = LOG_NAME.exec(o.key);
      if (m === null || m[1] !== executionId) continue;
      found.push({
        key: o.key,
        uploaded: o.uploaded.getTime(),
        epoch: Number(m[2]),
        step: m[3]!,
        stream: m[4]!,
        start: Number(m[5]),
      });
    }
    if (!page.truncated) return found;
    cursor = page.cursor;
  }
};

/**
 * The failing epoch's segments in step order: steps by the upload time of their first segment, then by stream and
 * offset. The failing epoch is the latest, the one whose result concluded the execution.
 */
const failingEpochInStepOrder = (segments: readonly LogSegment[]): LogSegment[] => {
  const epoch = Math.max(...segments.map((s) => s.epoch));
  const latest = segments.filter((s) => s.epoch === epoch);
  const firstSeen = new Map<string, number>();
  for (const s of latest)
    firstSeen.set(s.step, Math.min(firstSeen.get(s.step) ?? Infinity, s.uploaded));
  return latest.sort(
    (a, b) =>
      firstSeen.get(a.step)! - firstSeen.get(b.step)! ||
      a.step.localeCompare(b.step) ||
      a.stream.localeCompare(b.stream) ||
      a.start - b.start,
  );
};

const ANSI =
  // oxlint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** One NDJSON line as plain text: its `line`, `text` or `message` field, else the raw line, with ANSI escapes removed. */
const lineText = (line: string): string => {
  let text = line;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const field = ["line", "text", "message"].find((f) => typeof parsed[f] === "string");
    if (field !== undefined) text = parsed[field] as string;
  } catch {
    // A line that is not JSON is read as it is.
  }
  return text.replace(ANSI, "");
};

const ndjsonToText = (ndjson: string) =>
  ndjson
    .split("\n")
    .filter((l) => l !== "")
    .map(lineText)
    .join("\n");

const failed = (source: string) => (cause: unknown) =>
  new ReadFailed({ source, detail: String(cause).slice(0, 200) });

/**
 * `ExecutionsRead` over the executions table and the log store. `failedSince` answers the repository's executions that
 * concluded `failure` at or after `since`, newest first; `failedJobLog` the text of the failing epoch's log, empty for
 * an execution that wrote none. A database, listing or object read that throws, or a listed object that is gone, fails
 * the read.
 */
export const executionsReadLayer = (config: ExecutionsReadConfig): Layer.Layer<ExecutionsRead> =>
  Layer.succeed(ExecutionsRead, {
    failedSince: (repository, since) =>
      Effect.tryPromise({
        try: async () => {
          const { results } = await config.db
            .prepare(
              `select id, run, reason, finished_at from executions
                where scope_id = ? and status = 'failure' and finished_at >= ?
                order by finished_at desc, id`,
            )
            .bind(repository, since)
            .all();
          return (
            results as readonly {
              id: string;
              run: string;
              reason: string | null;
              finished_at: number;
            }[]
          ).map((r): FailedExecution => ({
            executionId: r.id,
            run: r.run,
            reason: r.reason ?? "",
            finishedAt: r.finished_at,
          }));
        },
        catch: failed("executions"),
      }),
    failedJobLog: (executionId) =>
      Effect.tryPromise({
        try: async () => {
          const segments = await listSegments(config.logs, executionId);
          if (segments.length === 0) return "";
          const texts: string[] = [];
          for (const s of failingEpochInStepOrder(segments)) {
            const body = await config.logs.get(s.key);
            if (body === null) throw new Error(`log object ${s.key} is listed but missing`);
            texts.push(ndjsonToText(await body.text()));
          }
          return texts.join("\n");
        },
        catch: failed("logs"),
      }),
  });
