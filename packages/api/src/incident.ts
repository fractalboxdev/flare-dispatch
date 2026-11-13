// The bound on a failure summary (FD-IFC-042): each field to its `incident/v1` cap, then the whole pack to 16 KiB
// serialized, shortening the log tails first and then dropping the last list entries. A `confidential-compute`
// repository's summary keeps only the reason and the failing step names (FD-IFC-045).
import { INCIDENT_CAPS, type IncidentV1 } from "./declaration.ts";

const cut = (text: string, max: number) =>
  text.length <= max ? text : text.slice(text.length - max);
const head = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max));
const cutOpt = (text: string | undefined, max: number, keep: "head" | "tail" = "head") =>
  text === undefined ? undefined : keep === "tail" ? cut(text, max) : head(text, max);

const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

const capFields = (pack: IncidentV1): IncidentV1 => {
  const { text, path, logTail } = INCIDENT_CAPS;
  return defined({
    ...pack,
    incidentId: head(pack.incidentId, 200),
    repo: head(pack.repo, 200),
    suspectRef:
      pack.suspectRef === undefined
        ? undefined
        : {
            ...pack.suspectRef,
            base: head(pack.suspectRef.base, path),
            head: head(pack.suspectRef.head, path),
          },
    diagnosis:
      pack.diagnosis === undefined
        ? undefined
        : {
            title: head(pack.diagnosis.title, text),
            area: head(pack.diagnosis.area, text),
            diagnosis: head(pack.diagnosis.diagnosis, text),
            suggestedFix: head(pack.diagnosis.suggestedFix, text),
          },
    signals: pack.signals?.slice(0, 50).map((s) =>
      defined({
        ...s,
        source: head(s.source, 120),
        title: head(s.title, 200),
        detail: head(s.detail, text),
        url: cutOpt(s.url, 1000),
      }),
    ),
    ciFailures: pack.ciFailures?.slice(0, 20).map((f) =>
      defined({
        ...f,
        name: head(f.name, text),
        conclusion: head(f.conclusion, 200),
        command: cutOpt(f.command, text),
        logTail: cutOpt(f.logTail, logTail, "tail"),
        url: cutOpt(f.url, 1000),
      }),
    ),
    suspectFiles: pack.suspectFiles?.slice(0, 50).map((p) => head(p, path)),
    repro:
      pack.repro === undefined
        ? undefined
        : defined({
            ...pack.repro,
            command: cutOpt(pack.repro.command, text),
            note: cutOpt(pack.repro.note, text),
          }),
  });
};

const sizeOf = (pack: IncidentV1) => new TextEncoder().encode(JSON.stringify(pack)).byteLength;

/** Shortens one step at a time until the pack fits; each step strictly shrinks it, so the loop ends. */
const shrink = (pack: IncidentV1): IncidentV1 | undefined => {
  const failures = pack.ciFailures ?? [];
  const longest = failures.reduce(
    (best, f, i) => ((f.logTail?.length ?? 0) > (failures[best]?.logTail?.length ?? 0) ? i : best),
    0,
  );
  const tail = failures[longest]?.logTail;
  if (tail !== undefined && tail.length > 256)
    return {
      ...pack,
      ciFailures: failures.map((f, i) =>
        i === longest ? { ...f, logTail: cut(tail, Math.floor(tail.length / 2)) } : f,
      ),
    };
  for (const key of ["signals", "suspectFiles", "ciFailures"] as const) {
    const list = pack[key];
    if (list !== undefined && list.length > 0) return { ...pack, [key]: list.slice(0, -1) };
  }
  if (pack.diagnosis !== undefined) return defined({ ...pack, diagnosis: undefined });
  return undefined;
};

export const boundIncident = (pack: IncidentV1): IncidentV1 => {
  let bounded = capFields(pack);
  while (sizeOf(bounded) > INCIDENT_CAPS.serializedBytes) {
    const next = shrink(bounded);
    if (next === undefined) break;
    bounded = next;
  }
  return bounded;
};

/**
 * The summary a `confidential-compute` repository's caller receives (FD-IFC-045): the pack's identity and, for each
 * failure, its kind, step name and reason. No log tail, command, URL, path, diagnosis, signal, suspect ref or repro.
 */
export const confidentialIncident = (pack: IncidentV1): IncidentV1 => ({
  contractVersion: pack.contractVersion,
  incidentId: pack.incidentId,
  class: pack.class,
  repo: pack.repo,
  ...(pack.ciFailures === undefined
    ? {}
    : {
        ciFailures: pack.ciFailures.map(({ kind, name, conclusion }) => ({
          kind,
          name,
          conclusion,
        })),
      }),
});
