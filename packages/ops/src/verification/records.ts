// The phase gate's records from the deployed control plane (specs/verification.md FD-VER-028, FD-VER-029,
// FD-VER-031): the `V-MEASURE` thresholds of gate n over its window, read from the executions table and its siblings,
// the page alarms raised in the window, and the unresolved `kill-line` notifications. `GET /v1/ops/phase-gate` serves
// them; the `phase-gate` job fetches them into its records file and maps each page alarm to the phase of the `V-LIVE`
// requirement that names it.
import { HIT_RATE_WINDOW_MS } from "@fractalboxdev/flare-dispatch-cache";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { PageAlarmEpisode, PhaseGateRecords } from "@fractalboxdev/flare-dispatch-api/declaration";
import { Effect, Schema } from "effect";
import { decodeStrict } from "../decode.ts";
import type { MeasureRecord, PageAlarmRecord } from "./phase-gate.ts";
import type { Requirement } from "./spec-tags.ts";

const DAY_MS = 86_400_000;

/** The gate window: the 14 days before the records are read (specs/roadmap.md, each gate's `V-MEASURE` line). */
export const GATE_WINDOW_MS = 14 * DAY_MS;

/** Gate 0: a warm run's median time to verdict is at least 30% below the best cloud setup. */
export const WARM_SPEEDUP = 0.3;

/** The executor kind of an owned device; every other kind is a cloud setup. */
const DEVICE_KIND = "device";

/**
 * What `GET /v1/ops/phase-gate?gate=<n>` answers and the `phase-gate` job's records file holds, with its page-alarm
 * episodes: the declaration's response schemas.
 */
export { PageAlarmEpisode, PhaseGateRecords };

/** A table the records read could not be read. */
export class RecordsUnreadable extends Schema.TaggedError<RecordsUnreadable>()(
  "RecordsUnreadable",
  { reason: Schema.String },
) {}

const query = <T>(db: D1Like, sql: string, ...values: readonly unknown[]) =>
  Effect.tryPromise({
    try: async () => {
      const statement = db.prepare(sql);
      const { results } = await (values.length === 0 ? statement : statement.bind(...values)).all();
      return results as T[];
    },
    catch: (e) => new RecordsUnreadable({ reason: e instanceof Error ? e.message : String(e) }),
  });

/** The lower median of unsorted values; null when there are none. */
const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1]!;
};

/** One `required` execution's time to verdict, enqueue to finish, with its accepted result's executor kind. */
export interface VerdictSample {
  readonly run: string;
  readonly kind: string;
  readonly ms: number;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Gate 0's warm-run threshold: for each `required` run with a verdict on an owned device in the window, the device
 * median is at least 30% below the lowest median of any cloud executor kind. It does not hold when no run has a
 * device verdict, or a run with one has no cloud verdict to compare with.
 */
export const warmVerdictMeasure = (samples: readonly VerdictSample[]): MeasureRecord => {
  const runs = [...new Set(samples.filter((s) => s.kind === DEVICE_KIND).map((s) => s.run))].sort();
  if (runs.length === 0)
    return {
      name: "warm-verdict",
      holds: false,
      detail: "no required run reached a verdict on an owned device in the window",
    };
  const failures: string[] = [];
  const passes: string[] = [];
  for (const run of runs) {
    const of = samples.filter((s) => s.run === run);
    const device = median(of.filter((s) => s.kind === DEVICE_KIND).map((s) => s.ms))!;
    const cloud = [...new Set(of.map((s) => s.kind).filter((k) => k !== DEVICE_KIND))]
      .map((kind) => ({
        kind,
        ms: median(of.filter((s) => s.kind === kind).map((s) => s.ms))!,
      }))
      .sort((a, b) => a.ms - b.ms)[0];
    if (cloud === undefined) {
      failures.push(`${run}: no cloud verdict to compare with`);
      continue;
    }
    const below = cloud.ms === 0 ? 0 : 1 - device / cloud.ms;
    const line = `${run}: device median ${seconds(device)}, best cloud ${cloud.kind} ${seconds(cloud.ms)}, ${Math.round(below * 100)}% below`;
    (below >= WARM_SPEEDUP ? passes : failures).push(line);
  }
  return {
    name: "warm-verdict",
    holds: failures.length === 0,
    detail: (failures.length === 0 ? passes : failures).join("; "),
  };
};

/**
 * One cache tier's hits for one executor kind and level over 28 days, with every lookup of that executor kind and
 * level: a miss has no tier, so the hit rate per tier is `hits` over `lookups` (`cacheHitRates`, FD-CACHE-090).
 */
export interface CacheHitRow {
  readonly executor_kind: string;
  readonly level: string;
  readonly tier: string | null;
  readonly lookups: number;
  readonly hits: number;
}

/** Gate 0's cache report: the hit rate per tier and executor kind is reported; no lookup means no report. */
export const cacheHitRateMeasure = (rows: readonly CacheHitRow[] | null): MeasureRecord =>
  rows === null
    ? { name: "cache-hit-rate", holds: false, detail: "the cache lookups cannot be read" }
    : rows.length === 0
      ? { name: "cache-hit-rate", holds: false, detail: "no cache lookup in the last 28 days" }
      : {
          name: "cache-hit-rate",
          holds: true,
          detail: rows
            .map(
              (r) =>
                `${r.executor_kind} ${r.level} ${r.tier ?? "miss"}: ${Number(r.hits)}/${Number(r.lookups)}`,
            )
            .join("; "),
        };

/** Gate 0's spend check: no `estimate-drift` notification is unresolved. */
export const estimateDriftMeasure = (unresolved: readonly string[]): MeasureRecord => ({
  name: "estimate-drift",
  holds: unresolved.length === 0,
  detail:
    unresolved.length === 0
      ? "no estimate-drift notification is unresolved"
      : `unresolved: ${unresolved.join(", ")}`,
});

/** One row of `fd_alarm_transitions`. */
export interface AlarmTransition {
  readonly dedupe_key: string;
  readonly name: string;
  readonly state: string;
  readonly at: number;
}

/**
 * The raise-to-resolve episodes of each alarm key that overlap the window, from its transitions in time order. An
 * episode raised before the window counts from the window start; one still open has no `resolvedAt`.
 */
export const alarmEpisodes = (
  transitions: readonly AlarmTransition[],
  windowStart: number,
  windowEnd: number,
): readonly PageAlarmEpisode[] => {
  const open = new Map<string, { name: string; at: number }>();
  const out: PageAlarmEpisode[] = [];
  const close = (key: string, resolvedAt: number | null) => {
    const raised = open.get(key)!;
    open.delete(key);
    if (raised.at > windowEnd || (resolvedAt !== null && resolvedAt <= windowStart)) return;
    out.push({
      name: raised.name,
      dedupeKey: key,
      raisedAt: Math.max(raised.at, windowStart),
      resolvedAt: resolvedAt !== null && resolvedAt > windowEnd ? null : resolvedAt,
    });
  };
  const ordered = [...transitions].sort((a, b) => a.at - b.at);
  for (const t of ordered) {
    if (t.state === "raised") {
      if (!open.has(t.dedupe_key)) open.set(t.dedupe_key, { name: t.name, at: t.at });
    } else if (open.has(t.dedupe_key)) close(t.dedupe_key, t.at);
  }
  for (const key of open.keys()) close(key, null);
  return out.sort((a, b) => a.raisedAt - b.raisedAt || a.dedupeKey.localeCompare(b.dedupeKey));
};

/**
 * The records of gate `gate` over the 14 days before `now`. Gate 0's thresholds are measured; a gate whose
 * thresholds this control plane does not measure answers one measure that does not hold, so its gate fails.
 */
export const phaseGateRecords = (db: D1Like, gate: number, now: number) =>
  Effect.gen(function* () {
    const windowStart = now - GATE_WINDOW_MS;
    const measures: MeasureRecord[] = [];
    if (gate === 0) {
      const samples = yield* query<VerdictSample>(
        db,
        `select e.run as run, p.accepted_kind as kind, e.finished_at - e.enqueued_at as ms
         from executions e join placements p on p.execution_id = e.id
         where e.class = 'required' and e.status in ('success', 'failure')
           and e.finished_at is not null and p.accepted_kind is not null
           and e.finished_at > ? and e.finished_at <= ?`,
        windowStart,
        now,
      );
      measures.push(warmVerdictMeasure(samples));
      const cache = yield* query<CacheHitRow>(
        db,
        `with totals as (
           select executor_kind, level, count(*) as lookups from cache_lookups
           where at > ?1 and at <= ?2 group by executor_kind, level
         )
         select l.executor_kind, l.level, l.tier, t.lookups, sum(l.hit) as hits
         from cache_lookups l join totals t on t.executor_kind = l.executor_kind and t.level = l.level
         where l.at > ?1 and l.at <= ?2 group by l.executor_kind, l.level, l.tier
         order by l.executor_kind, l.level, l.tier`,
        now - HIT_RATE_WINDOW_MS,
        now,
      ).pipe(Effect.catchTag("RecordsUnreadable", () => Effect.succeed(null)));
      measures.push(cacheHitRateMeasure(cache));
      const drift = yield* query<{ dedupe_key: string }>(
        db,
        "select dedupe_key from fd_alarms where name = 'estimate-drift' and state = 'raised' order by dedupe_key",
      );
      measures.push(estimateDriftMeasure(drift.map((d) => d.dedupe_key)));
    } else
      measures.push({
        name: `gate-${gate}`,
        holds: false,
        detail: `this control plane measures no threshold of gate ${gate}`,
      });
    const transitions = yield* query<AlarmTransition>(
      db,
      `select dedupe_key, name, state, at from fd_alarm_transitions
       where severity = 'page' and at <= ? order by at, rowid`,
      now,
    );
    const killLines = yield* query<{ dedupe_key: string }>(
      db,
      "select dedupe_key from fd_alarms where name = 'kill-line' and state = 'raised' order by dedupe_key",
    );
    return {
      gate,
      windowStart,
      windowEnd: now,
      measures,
      pageAlarms: alarmEpisodes(transitions, windowStart, now),
      killLines: killLines.map((k) => k.dedupe_key),
    } satisfies PhaseGateRecords;
  });

const ALARM_NAME =
  /`([a-z][a-z0-9-]*)` (?:page |notify )?alarm|alarm `([a-z][a-z0-9-]*)`|`([a-z][a-z0-9-]*)` as the `queue_full_alarm`/g;

/**
 * Each alarm a `V-LIVE` requirement names, as an alarm or as a class's `queue_full_alarm` (raised at severity `page`,
 * MAMEKO-ADM-092), with the lowest phase of the requirements that name it.
 */
export const liveAlarmPhases = (
  requirements: readonly Requirement[],
): ReadonlyMap<string, number> => {
  const out = new Map<string, number>();
  for (const r of requirements)
    if (r.tags.includes("V-LIVE"))
      for (const m of r.sentence.matchAll(ALARM_NAME)) {
        const name = (m[1] ?? m[2] ?? m[3])!;
        out.set(name, Math.min(out.get(name) ?? r.phase, r.phase));
      }
  return out;
};

/** The page alarms the phase gate reads: each episode of an alarm a `V-LIVE` requirement names, with its phase. */
export const pageAlarmRecords = (
  episodes: readonly PageAlarmEpisode[],
  requirements: readonly Requirement[],
): readonly PageAlarmRecord[] => {
  const phases = liveAlarmPhases(requirements);
  return episodes.flatMap((e) => {
    const requirementPhase = phases.get(e.name);
    return requirementPhase === undefined
      ? []
      : [{ name: e.name, requirementPhase, raisedAt: e.raisedAt, resolvedAt: e.resolvedAt }];
  });
};

/** The control plane did not answer the records. */
export class RecordsFetchFailed extends Schema.TaggedError<RecordsFetchFailed>()(
  "RecordsFetchFailed",
  { reason: Schema.String },
) {}

/** Where the `phase-gate` job reads the records: the dispatcher's origin and an Access service token. */
export interface RecordsSource {
  readonly origin: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch?: typeof fetch;
}

/** Fetches and decodes the records of gate n from the control plane the deploy workflow targets. */
export const fetchPhaseGateRecords = (source: RecordsSource, gate: number) =>
  Effect.gen(function* () {
    const url = `${source.origin.replace(/\/$/, "")}/v1/ops/phase-gate?gate=${gate}`;
    const response = yield* Effect.tryPromise({
      try: () =>
        (source.fetch ?? fetch)(url, {
          headers: {
            "CF-Access-Client-Id": source.clientId,
            "CF-Access-Client-Secret": source.clientSecret,
            accept: "application/json",
          },
        }),
      catch: (e) => new RecordsFetchFailed({ reason: `${url}: ${String(e)}` }),
    });
    if (!response.ok)
      return yield* new RecordsFetchFailed({ reason: `${url} answered ${response.status}` });
    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (e) => new RecordsFetchFailed({ reason: `${url}: not JSON: ${String(e)}` }),
    });
    const records = yield* decodeStrict(PhaseGateRecords, body).pipe(
      Effect.mapError(
        (issues) =>
          new RecordsFetchFailed({
            reason: issues.map((i) => `${i.path}: ${i.message}`).join("; "),
          }),
      ),
    );
    if (records.gate !== gate)
      return yield* new RecordsFetchFailed({
        reason: `asked for gate ${gate}, answered gate ${records.gate}`,
      });
    return records;
  });
