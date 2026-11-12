// The log store (specs/cache-artifacts.md § Artifacts and logs; § Logs). A log object is
// `logs/<execution_id>/<epoch>/<step_key>/<stream>-<start>-<end>.ndjson`: the name depends only on the step's journal
// name, the epoch and byte offsets, so a replay writes the same names and a reclaimed epoch never overwrites the
// previous one. Each object carries `executor_id` and `executor_kind` in its custom metadata.
import { base64url, sha256Hex } from "./crypto.ts";
import { inStepOrder, listLogObjects, ndjsonToText, parseLogObjectName } from "./log-names.ts";
import type { Bucket } from "./manifest.ts";

export * from "./log-names.ts";

const EXECUTION_ID = /^[A-Za-z0-9:_-]{3,128}$/;

/** The first 24 hex characters of the SHA-256 of the step's journal name. */
export const stepKey = async (journalName: string) => (await sha256Hex(journalName)).slice(0, 24);

/** The object name of one log segment (FD-CACHE-081); it carries no process-local counter. */
export const logObjectName = async (segment: {
  readonly executionId: string;
  readonly epoch: number;
  readonly journalName: string;
  readonly stream: string;
  readonly start: number;
  readonly end: number;
}): Promise<string | undefined> => {
  const name = `logs/${segment.executionId}/${segment.epoch}/${await stepKey(segment.journalName)}/${segment.stream}-${segment.start}-${segment.end}.ndjson`;
  return parseLogObjectName(name) === undefined ? undefined : name;
};

const IMMUTABLE = "public, max-age=31536000, immutable";

/** The facts of an execution the log routes read. */
export interface LogExecution {
  readonly terminal: boolean;
  /** True while the repository's confidentiality mode is `confidential-compute`: logs stay on the device. */
  readonly confidential?: boolean;
  readonly executorId?: string;
}

/** What serving an execution's logs reads, once the caller has been identified. */
export interface LogServeDeps {
  readonly bucket: Bucket;
  readonly execution: (executionId: string) => Promise<LogExecution | null>;
  /** A fresh nonce per HTML response. */
  readonly nonce?: () => string;
}

/** The answer of a log read: the response, or which of the execution and the file does not exist. */
export type LogRead =
  | { readonly _tag: "Served"; readonly response: Response }
  | { readonly _tag: "NoExecution" }
  | { readonly _tag: "NoFile" };

/**
 * One execution's logs for a caller already identified: one file, or with no `file` the aggregate of every file in
 * step order, as NDJSON, as plain text with `?format=text` or as the HTML viewer with `?format=html` (FD-CACHE-083).
 * A file name outside the grammar does not exist (FD-CACHE-082).
 */
export const serveLogs = async (
  request: Request,
  target: { readonly executionId: string; readonly file: string | undefined },
  deps: LogServeDeps,
): Promise<LogRead> => {
  const { executionId, file } = target;
  if (!EXECUTION_ID.test(executionId)) return { _tag: "NoExecution" };
  const execution = await deps.execution(executionId);
  if (execution === null) return { _tag: "NoExecution" };
  const served = (response: Response) => ({ _tag: "Served", response }) as const;
  const format = new URL(request.url).searchParams.get("format") ?? "ndjson";
  if (execution.confidential === true) return served(confidentialPointer(executionId, execution, deps));
  const cache = { "cache-control": execution.terminal ? IMMUTABLE : "no-store" };
  const objects =
    file === undefined
      ? inStepOrder(await listLogObjects(deps.bucket, executionId))
      : (() => {
          const log = parseLogObjectName(`logs/${executionId}/${file}`);
          return log === undefined || log.executionId !== executionId
            ? undefined
            : [{ key: `logs/${executionId}/${file}`, uploaded: 0, log }];
        })();
  if (objects === undefined) return { _tag: "NoFile" };
  const bodies: { key: string; text: string; meta: Record<string, string> }[] = [];
  for (const o of objects) {
    const body = await deps.bucket.get(o.key);
    if (body === null) {
      if (file !== undefined) return { _tag: "NoFile" };
      continue;
    }
    bodies.push({ key: o.key, text: await body.text(), meta: body.customMetadata ?? {} });
  }
  if (format === "html") return served(viewer(executionId, bodies, deps, cache));
  if (format === "text")
    return served(
      new Response(bodies.map((b) => ndjsonToText(b.text)).join("\n"), {
        headers: { "content-type": "text/plain; charset=utf-8", ...cache },
      }),
    );
  return served(
    new Response(bodies.map((b) => b.text.replace(/\n?$/, "\n")).join(""), {
      headers: { "content-type": "application/x-ndjson", ...cache },
    }),
  );
};

/** JSON safe inside a `<script type="application/json">`: no `<` survives to close the element. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

const defaultNonce = () => base64url(crypto.getRandomValues(new Uint8Array(16)));

const csp = (nonce: string) =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

/**
 * The HTML log viewer (FD-CACHE-084, FD-CACHE-086): a nonce-based CSP with `default-src 'none'`, the log text set only
 * through `textContent` with ANSI escapes stripped, and for each object the executor id, executor kind and epoch that
 * produced it.
 */
const viewer = (
  executionId: string,
  bodies: readonly { key: string; text: string; meta: Record<string, string> }[],
  deps: LogServeDeps,
  cache: Record<string, string>,
) => {
  const nonce = (deps.nonce ?? defaultNonce)();
  const sections = bodies.map((b) => {
    const log = parseLogObjectName(b.key)!;
    return {
      heading: `epoch ${log.epoch} · ${log.stream} ${log.start}-${log.end} · executor ${b.meta.executor_id ?? "unknown"} (${b.meta.executor_kind ?? "unknown"})`,
      text: ndjsonToText(b.text),
    };
  });
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>logs</title><style nonce="${nonce}">body{font:13px ui-monospace,monospace;margin:1rem}h2{font-size:13px;margin:1rem 0 .25rem}pre{white-space:pre-wrap;margin:0}</style></head><body><main id="logs"></main><script type="application/json" id="data">${scriptJson({ executionId, sections })}</script><script nonce="${nonce}">const d=JSON.parse(document.getElementById("data").textContent);const m=document.getElementById("logs");for(const s of d.sections){const h=document.createElement("h2");h.textContent=s.heading;const p=document.createElement("pre");p.textContent=s.text;m.append(h,p);}</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp(nonce),
      "x-content-type-options": "nosniff",
      ...cache,
    },
  });
};

/**
 * A `confidential-compute` execution keeps its logs on the device (FD-CACHE-088): the viewer shows the executor id and
 * execution id as a pointer and fetches no log content.
 */
const confidentialPointer = (executionId: string, execution: LogExecution, deps: LogServeDeps) => {
  const nonce = (deps.nonce ?? defaultNonce)();
  const pointer = { executionId, executorId: execution.executorId ?? "unknown" };
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>logs</title></head><body><p id="p"></p><script type="application/json" id="data">${scriptJson(pointer)}</script><script nonce="${nonce}">const d=JSON.parse(document.getElementById("data").textContent);document.getElementById("p").textContent="Logs of execution "+d.executionId+" stay on executor "+d.executorId+".";</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp(nonce),
      "cache-control": "no-store",
    },
  });
};

export const DEFAULT_LOG_RETENTION_MS = 30 * 24 * 3600 * 1000;

/**
 * One tick of the log sweep (FD-CACHE-089): deletes every log object of an execution that ended more than the
 * retention ago, default 30 days. `endedAt` answers `null` for an execution still running.
 */
export const sweepLogs = async (
  bucket: Bucket,
  endedAt: (executionId: string) => Promise<number | null>,
  nowMs: number,
  options: { readonly retentionMs?: number; readonly maxPages?: number; readonly cursor?: string } = {},
) => {
  const retention = options.retentionMs ?? DEFAULT_LOG_RETENTION_MS;
  let cursor = options.cursor;
  let deleted = 0;
  const ended = new Map<string, number | null>();
  for (let page = 0; page < (options.maxPages ?? 500); page++) {
    const listed = await bucket.list({
      prefix: "logs/",
      limit: 1000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const doomed: string[] = [];
    for (const o of listed.objects) {
      const id = o.key.split("/")[1] ?? "";
      if (!EXECUTION_ID.test(id)) continue;
      if (!ended.has(id)) ended.set(id, await endedAt(id));
      const at = ended.get(id);
      if (at !== null && at !== undefined && nowMs - at > retention) doomed.push(o.key);
    }
    if (doomed.length > 0) await bucket.delete(doomed);
    deleted += doomed.length;
    if (!listed.truncated) return { deleted, cursor: undefined };
    cursor = listed.cursor;
  }
  return { deleted, cursor };
};
