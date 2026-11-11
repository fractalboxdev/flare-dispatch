// `ExecutionsRead` (specs/runs/agentic.md § `ci-triage-pr`): the failed executions of one repository since a time, and
// the log of an execution's failing epoch as plain text. A failed read is `ReadFailed`, never an empty window or an
// empty log (FD-AGT-042). The cloud executor reads through the control plane's executions and log routes; a host that
// holds the executions table and the log bucket reads them directly.
import {
  inStepOrder,
  listLogObjects,
  ndjsonToText,
  type LogListing,
} from "@fractalboxdev/flare-dispatch-cache/log-names";
import { Effect, Layer, Schema } from "effect";
import type { D1Binding } from "../local/store.ts";
import { ExecutionsRead, type FailedExecution } from "./ci-triage-pr.ts";
import { ReadFailed } from "./spec-drift-pr.ts";

const failed = (source: string) => (cause: unknown) =>
  new ReadFailed({ source, detail: String(cause).slice(0, 200) });

// ---- Over the control plane's routes ------------------------------------------------------------------------------

export interface ExecutionsApiConfig {
  /** The control plane's origin. */
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
}

/** The fields of `GET /v1/executions` the read uses (specs/interfaces.md FD-IFC-037, FD-IFC-038). */
const ExecutionsPage = Schema.Struct({
  executions: Schema.Array(
    Schema.Struct({
      execution_id: Schema.String,
      run: Schema.String,
      verdict: Schema.NullOr(Schema.String),
      reason: Schema.NullOr(Schema.String),
      finished_at: Schema.NullOr(Schema.Number),
    }),
  ),
  next_before: Schema.optionalKey(Schema.String),
});
const decodePage = Schema.decodeUnknownSync(ExecutionsPage);

const PAGE = 200;

/**
 * `ExecutionsRead` over the control plane's routes: `failedSince` pages `GET /v1/executions` for the repository's
 * executions done at or after `since` and keeps those whose verdict is `failure`, newest first; `failedJobLog` answers
 * `GET /v1/executions/<id>/logs?format=text`, every step log of the execution in step order (FD-CACHE-083). The Layer
 * sends no credential of its own: a request carries only what the egress proxy attaches to it. A request that fails,
 * an answer other than 200, a page outside the shape and a log not served as plain text each fail the read.
 */
export const executionsApiReadLayer = (
  config: ExecutionsApiConfig,
): Layer.Layer<ExecutionsRead> => {
  const get = async (path: string, query: Record<string, string>) => {
    const url = new URL(path, config.baseUrl);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const response = await config.fetch(url.toString());
    if (response.status !== 200) throw new Error(`GET ${url.pathname} answered ${response.status}`);
    return response;
  };
  return Layer.succeed(ExecutionsRead, {
    failedSince: (repository, since) =>
      Effect.tryPromise({
        try: async () => {
          const found: FailedExecution[] = [];
          let before: string | undefined;
          for (;;) {
            const response = await get("/v1/executions", {
              repository,
              status: "done",
              finished_since: String(since),
              limit: String(PAGE),
              ...(before === undefined ? {} : { before }),
            });
            const page = decodePage(await response.json());
            for (const e of page.executions) {
              const finishedAt = e.finished_at;
              if (e.verdict !== "failure" || finishedAt === null || finishedAt < since) continue;
              found.push({
                executionId: e.execution_id,
                run: e.run,
                reason: e.reason ?? "",
                finishedAt,
              });
            }
            if (page.next_before === undefined) break;
            before = page.next_before;
          }
          return found.sort(
            (a, b) =>
              b.finishedAt - a.finishedAt ||
              (a.executionId < b.executionId ? -1 : a.executionId > b.executionId ? 1 : 0),
          );
        },
        catch: failed("executions"),
      }),
    failedJobLog: (executionId) =>
      Effect.tryPromise({
        try: async () => {
          const response = await get(`/v1/executions/${encodeURIComponent(executionId)}/logs`, {
            format: "text",
          });
          if (!(response.headers.get("content-type") ?? "").startsWith("text/plain"))
            throw new Error(`the log of ${executionId} is not served as plain text`);
          return await response.text();
        },
        catch: failed("logs"),
      }),
  });
};

// ---- Over the stores ----------------------------------------------------------------------------------------------

/** The log store's listing and reads, as an R2 bucket answers them. */
export interface LogObjects extends LogListing {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export interface ExecutionsReadConfig {
  /** The control plane's database: mameko's `executions` table, whose `scope_id` is the repository. */
  readonly db: D1Binding;
  /** The bucket that holds `logs/`. */
  readonly logs: LogObjects;
}

/**
 * `ExecutionsRead` over the executions table and the log store, for a host that holds both bindings. `failedSince`
 * answers the repository's executions that concluded `failure` at or after `since`, newest first; `failedJobLog` the
 * text of the failing epoch's log in step order, empty for an execution that wrote none. The failing epoch is the
 * latest, the one whose result concluded the execution. A database, listing or object read that throws, or a listed
 * object that is gone, fails the read.
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
          const objects = await listLogObjects(config.logs, executionId);
          if (objects.length === 0) return "";
          const epoch = Math.max(...objects.map((o) => o.log.epoch));
          const texts: string[] = [];
          for (const o of inStepOrder(objects.filter((o) => o.log.epoch === epoch))) {
            const body = await config.logs.get(o.key);
            if (body === null) throw new Error(`log object ${o.key} is listed but missing`);
            texts.push(ndjsonToText(await body.text()));
          }
          return texts.join("\n");
        },
        catch: failed("logs"),
      }),
  });
