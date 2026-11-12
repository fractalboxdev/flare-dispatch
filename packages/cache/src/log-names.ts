// The log object grammar and its reading (specs/cache-artifacts.md § Logs): parsing a log object name, listing an
// execution's log objects, step order and the plain-text rendering of NDJSON. It names no Workers type, so a reader
// outside a Worker imports it as `@fractalboxdev/flare-dispatch-cache/log-names`.

const LOG_NAME =
  /^logs\/([A-Za-z0-9:_-]{3,128})\/([1-9][0-9]{0,8})\/([0-9a-f]{24})\/([a-z][a-z0-9]{0,15})-(0|[1-9][0-9]{0,15})-(0|[1-9][0-9]{0,15})\.ndjson$/;

export interface LogObject {
  readonly executionId: string;
  readonly epoch: number;
  readonly stepKey: string;
  readonly stream: string;
  readonly start: number;
  readonly end: number;
}

/** Parses a log object name; anything outside the grammar is `undefined`, and the reader rejects it (FD-CACHE-082). */
export const parseLogObjectName = (name: string): LogObject | undefined => {
  const m = LOG_NAME.exec(name);
  if (m === null) return undefined;
  const start = Number(m[5]);
  const end = Number(m[6]);
  if (end < start) return undefined;
  return { executionId: m[1]!, epoch: Number(m[2]), stepKey: m[3]!, stream: m[4]!, start, end };
};

// ---- Reading ----------------------------------------------------------------------------

/** The listing a log read pages through, as an R2 bucket answers it. */
export interface LogListing {
  list(options: {
    readonly prefix: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{
    readonly objects: readonly { readonly key: string; readonly uploaded: Date }[];
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

/** Every log object of an execution, paging through R2 listings past 1000 objects. */
export const listLogObjects = async (bucket: LogListing, executionId: string) => {
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
