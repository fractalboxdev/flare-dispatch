// The log store (specs/cache-artifacts.md § Artifacts and logs; § Logs). A log object is
// `logs/<execution_id>/<epoch>/<step_key>/<stream>-<start>-<end>.ndjson`: the name depends only on the step's journal
// name, the epoch and byte offsets, so a replay writes the same names and a reclaimed epoch never overwrites the
// previous one. Each object carries `executor_id` and `executor_kind` in its custom metadata.
import { base64url, derivedHmacKey, fromBase64url, hmacSign, hmacVerify, sha256Hex } from "./crypto.ts";
import type { Bucket } from "./manifest.ts";

const EXECUTION_ID = /^[A-Za-z0-9:_-]{3,128}$/;
const LOG_NAME =
  /^logs\/([A-Za-z0-9:_-]{3,128})\/([1-9][0-9]{0,8})\/([0-9a-f]{24})\/([a-z][a-z0-9]{0,15})-(0|[1-9][0-9]{0,15})-(0|[1-9][0-9]{0,15})\.ndjson$/;

/** The first 24 hex characters of the SHA-256 of the step's journal name. */
export const stepKey = async (journalName: string) => (await sha256Hex(journalName)).slice(0, 24);

export interface LogObject {
  readonly executionId: string;
  readonly epoch: number;
  readonly stepKey: string;
  readonly stream: string;
  readonly start: number;
  readonly end: number;
}

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

/** Parses a log object name; anything outside the grammar is `undefined`, and the reader rejects it (FD-CACHE-082). */
export const parseLogObjectName = (name: string): LogObject | undefined => {
  const m = LOG_NAME.exec(name);
  if (m === null) return undefined;
  const start = Number(m[5]);
  const end = Number(m[6]);
  if (end < start) return undefined;
  return { executionId: m[1]!, epoch: Number(m[2]), stepKey: m[3]!, stream: m[4]!, start, end };
};

// ---- Capability token -----------------------------------------------------------------

export const LOG_TOKEN_LABEL = "flare-dispatch/log/v1";
export const MAX_CAPABILITY_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * A capability token bound to one subject (an execution id for logs, an artifact id for artifacts), with an expiry of
 * at most 7 days and a key derived under a domain-separation label, compared in constant time.
 */
export const signCapability = async (
  secret: string,
  label: string,
  subject: string,
  expiresAt: number,
  nowMs: number,
): Promise<string> => {
  const exp = Math.min(expiresAt, nowMs + MAX_CAPABILITY_TTL_MS);
  const body = `${exp}.${base64url(new TextEncoder().encode(subject))}`;
  const mac = await hmacSign(await derivedHmacKey(secret, label), `${label}\n${body}`);
  return `${body}.${base64url(mac)}`;
};

export const verifyCapability = async (
  secret: string,
  label: string,
  subject: string,
  token: string | null,
  nowMs: number,
): Promise<boolean> => {
  if (token === null) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[1-9][0-9]{0,15}$/.test(parts[0]!)) return false;
  const exp = Number(parts[0]);
  const mac = fromBase64url(parts[2]!);
  const bound = fromBase64url(parts[1]!);
  if (mac === undefined || bound === undefined || mac.length !== 32) return false;
  if (new TextDecoder().decode(bound) !== subject) return false;
  const valid = await hmacVerify(
    await derivedHmacKey(secret, label),
    mac,
    `${label}\n${parts[0]}.${parts[1]}`,
  );
  return valid && nowMs < exp && exp - nowMs <= MAX_CAPABILITY_TTL_MS;
};

/** A log capability token bound to one execution id (FD-CACHE-087). */
export const signLogToken = (secret: string, executionId: string, expiresAt: number, nowMs: number) =>
  signCapability(secret, LOG_TOKEN_LABEL, executionId, expiresAt, nowMs);

// ---- Reading ----------------------------------------------------------------------------

/** Every log object of an execution, paging through R2 listings past 1000 objects. */
export const listLogObjects = async (bucket: Bucket, executionId: string) => {
  const found: { readonly key: string; readonly uploaded: number; readonly log: LogObject }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({
      prefix: `logs/${executionId}/`,
      limit: 1000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const o of page.objects) {
      const log = parseLogObjectName(o.key);
      if (log !== undefined && log.executionId === executionId)
        found.push({ key: o.key, uploaded: o.uploaded.getTime(), log });
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return found;
};

/**
 * Step order: by epoch, then by the time each step's first segment was uploaded, then by stream and offset. Step
 * keys are hashes, so the upload time of a step's first segment is what orders the steps.
 */
export const inStepOrder = <T extends { readonly uploaded: number; readonly log: LogObject }>(
  objects: readonly T[],
): T[] => {
  const firstSeen = new Map<string, number>();
  for (const o of objects) {
    const id = `${o.log.epoch}/${o.log.stepKey}`;
    firstSeen.set(id, Math.min(firstSeen.get(id) ?? Infinity, o.uploaded));
  }
  return [...objects].sort(
    (a, b) =>
      a.log.epoch - b.log.epoch ||
      firstSeen.get(`${a.log.epoch}/${a.log.stepKey}`)! -
        firstSeen.get(`${b.log.epoch}/${b.log.stepKey}`)! ||
      (a.log.stepKey < b.log.stepKey ? -1 : a.log.stepKey > b.log.stepKey ? 1 : 0) ||
      (a.log.stream < b.log.stream ? -1 : a.log.stream > b.log.stream ? 1 : 0) ||
      a.log.start - b.log.start,
  );
};

// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
export const stripAnsi = (text: string) => text.replace(ANSI, "");

/** One NDJSON line as plain text: its `line`, `text` or `message` field, else the raw line. */
const lineText = (line: string): string => {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    for (const field of ["line", "text", "message"])
      if (typeof parsed[field] === "string") return parsed[field] as string;
  } catch {
    // A line that is not JSON is shown as it is.
  }
  return line;
};

export const ndjsonToText = (ndjson: string) =>
  ndjson
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => stripAnsi(lineText(l)))
    .join("\n");

const IMMUTABLE = "public, max-age=31536000, immutable";

/** The facts of an execution the log routes read. */
export interface LogExecution {
  readonly terminal: boolean;
  /** True while the repository's confidentiality mode is `confidential-compute`: logs stay on the device. */
  readonly confidential?: boolean;
  readonly executorId?: string;
}

export interface LogRouteDeps {
  readonly bucket: Bucket;
  readonly secret: string;
  readonly now: () => number;
  readonly execution: (executionId: string) => Promise<LogExecution | null>;
  /** A viewer identity with read access to the execution's repository, when the request carries one. */
  readonly viewerMayRead?: (request: Request, executionId: string) => Promise<boolean>;
  /** A fresh nonce per HTML response. */
  readonly nonce?: () => string;
}

const LOG_ROUTE = /^\/v1\/executions\/([A-Za-z0-9:_-]{3,128})\/logs(?:\/(.+))?$/;

const tokenOf = (request: Request, url: URL) => {
  const auth = request.headers.get("authorization");
  const bearer = auth === null ? null : /^Bearer\s+(\S+)$/i.exec(auth.trim());
  return bearer?.[1] ?? url.searchParams.get("token");
};

const plain = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * `GET /v1/executions/<id>/logs/<file>` and `GET /v1/executions/<id>/logs` (FD-CACHE-083): one file as NDJSON, as
 * plain text with `?format=text`, or the HTML viewer with `?format=html`; without a file, the aggregate of every file
 * in step order. A name outside the grammar is `404` (FD-CACHE-082). A terminal execution's logs are served
 * `Cache-Control: immutable` (FD-CACHE-085). Access needs a viewer identity or a log token bound to the execution.
 */
export const handleLogs = async (request: Request, deps: LogRouteDeps): Promise<Response | null> => {
  const url = new URL(request.url);
  const m = LOG_ROUTE.exec(url.pathname);
  if (m === null) return null;
  if (request.method !== "GET") return plain(405, "method not allowed");
  const executionId = m[1]!;
  const file = m[2];
  const allowed =
    (await verifyCapability(deps.secret, LOG_TOKEN_LABEL, executionId, tokenOf(request, url), deps.now())) ||
    (deps.viewerMayRead !== undefined && (await deps.viewerMayRead(request, executionId)));
  if (!allowed) return plain(404, "not found");
  const execution = await deps.execution(executionId);
  if (execution === null) return plain(404, "not found");
  const format = url.searchParams.get("format") ?? "ndjson";
  if (execution.confidential === true) return confidentialPointer(executionId, execution, deps);
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
  if (objects === undefined) return plain(404, "not found");
  const bodies: { key: string; text: string; meta: Record<string, string> }[] = [];
  for (const o of objects) {
    const body = await deps.bucket.get(o.key);
    if (body === null) {
      if (file !== undefined) return plain(404, "not found");
      continue;
    }
    bodies.push({ key: o.key, text: await body.text(), meta: body.customMetadata ?? {} });
  }
  if (format === "html") return viewer(executionId, bodies, deps, cache);
  if (format === "text")
    return new Response(bodies.map((b) => ndjsonToText(b.text)).join("\n"), {
      headers: { "content-type": "text/plain; charset=utf-8", ...cache },
    });
  return new Response(bodies.map((b) => b.text.replace(/\n?$/, "\n")).join(""), {
    headers: { "content-type": "application/x-ndjson", ...cache },
  });
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
  deps: LogRouteDeps,
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
const confidentialPointer = (executionId: string, execution: LogExecution, deps: LogRouteDeps) => {
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
