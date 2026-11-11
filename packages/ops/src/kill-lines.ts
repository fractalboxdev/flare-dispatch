// The kill-line monitor (specs/verification.md FD-VER-030, specs/roadmap.md § Kill lines). Once a day the minute tick
// reads each kill line's metric over its window from the executions table and its siblings, and raises the `kill-line`
// notification for each crossed line. A raised line stays raised until the operator resolves it (FD-VER-031); a later
// reading under the line does not resolve it.
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Schema } from "effect";
import { raiseOnce, type RaiseResult } from "./raise.ts";
import { killLineAlarms, type KillLineReading } from "./verification/phase-gate.ts";

const DAY_MS = 86_400_000;

/** How often the monitor reads the kill lines. */
export const KILL_LINE_INTERVAL_MS = DAY_MS;

/** The executor kind of an owned device; every other kind is a cloud setup. */
const DEVICE_KIND = "device";

/** The risks of specs/roadmap.md § Kill lines, each the `risk` its reading and notification name. */
export const KILL_LINE_RISKS = {
  warmState: "Warm state saves less than assumed",
  availability: "Owned devices are too often unavailable",
  toil: "Operator toil",
  flaky: "Warm state hides flaky tests",
  requiredSlowdown: "Local placement slows required checks",
  productFit: "BYOC product fit",
} as const;

/** The window and threshold of each measured kill line. */
export const KILL_LINE_WINDOWS = {
  /** The roadmap names no window for the warm-state line; it reads the gate window. */
  warmState: { windowMs: 14 * DAY_MS, threshold: 30 },
  availability: { windowMs: 30 * DAY_MS, threshold: 50 },
  flaky: { windowMs: 7 * DAY_MS, threshold: 1 },
  /** Equal to the warm-state window; `readKillLines` reads both lines from one query over it. */
  requiredSlowdown: { windowMs: 14 * DAY_MS, threshold: 60 },
} as const;

/** A kill line the monitor did not measure, and why: no samples in its window, an unreadable table, or no metric. */
export interface UnmeasuredLine {
  readonly risk: string;
  readonly reason: string;
}

export type LineResult = KillLineReading | UnmeasuredLine;

const isReading = (r: LineResult): r is KillLineReading => "crossed" in r;

/** A table a kill line reads could not be read. */
export class KillLineUnreadable extends Schema.TaggedError<KillLineUnreadable>()(
  "KillLineUnreadable",
  { reason: Schema.String },
) {}

const query = <T>(db: D1Like, sql: string, ...values: readonly unknown[]) =>
  Effect.tryPromise({
    try: async () => {
      const { results } = await db
        .prepare(sql)
        .bind(...values)
        .all();
      return results as T[];
    },
    catch: (e) => new KillLineUnreadable({ reason: e instanceof Error ? e.message : String(e) }),
  });

/** The lower median of unsorted values; null when there are none. */
const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1]!;
};

/** The nearest-rank 95th percentile of unsorted values; null when there are none. */
const p95 = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** One `required` execution's time to verdict, enqueue to finish, with its accepted result's executor kind. */
export interface KillLineVerdict {
  readonly run: string;
  readonly kind: string;
  readonly ms: number;
}

/**
 * The warm-state line: for each `required` run with verdicts on an owned device and on a cloud setup, how far the
 * device median time to verdict lies below the lowest median of any cloud executor kind, in percent. The reading is
 * the run that saves least; it is crossed below 30%.
 */
export const warmStateLine = (samples: readonly KillLineVerdict[]): LineResult => {
  const { threshold } = KILL_LINE_WINDOWS.warmState;
  const runs = [...new Set(samples.filter((s) => s.kind === DEVICE_KIND).map((s) => s.run))].sort();
  let worst: { run: string; below: number } | null = null;
  for (const run of runs) {
    const of = samples.filter((s) => s.run === run);
    const device = median(of.filter((s) => s.kind === DEVICE_KIND).map((s) => s.ms))!;
    const cloud = [...new Set(of.map((s) => s.kind).filter((k) => k !== DEVICE_KIND))]
      .map((kind) => median(of.filter((s) => s.kind === kind).map((s) => s.ms))!)
      .sort((a, b) => a - b)[0];
    if (cloud === undefined) continue;
    const below = cloud === 0 ? 0 : (1 - device / cloud) * 100;
    if (worst === null || below < worst.below) worst = { run, below };
  }
  if (worst === null)
    return {
      risk: KILL_LINE_RISKS.warmState,
      reason: "no required run reached a verdict both on an owned device and on a cloud setup",
    };
  const value = round1(worst.below);
  return {
    risk: KILL_LINE_RISKS.warmState,
    metric: `device median time to verdict below the best cloud setup, % (run ${worst.run})`,
    value,
    threshold,
    crossed: value < threshold,
  };
};

/** The eligible executions of the availability window: those concluded whose eligible kinds include `device`. */
export interface EligibleCount {
  readonly eligible: number;
  readonly on_device: number;
}

/** The availability line: the percentage of eligible executions an owned device took; crossed under 50%. */
export const availabilityLine = (count: EligibleCount): LineResult => {
  const { threshold } = KILL_LINE_WINDOWS.availability;
  const eligible = Number(count.eligible);
  if (eligible === 0)
    return {
      risk: KILL_LINE_RISKS.availability,
      reason: "no execution eligible for an owned device concluded in the last 30 days",
    };
  const value = round1((Number(count.on_device) / eligible) * 100);
  return {
    risk: KILL_LINE_RISKS.availability,
    metric: "eligible executions taken by owned devices over 30 days, %",
    value,
    threshold,
    crossed: value < threshold,
  };
};

/** The verdict audit disagreements of the flaky-test window; `verdict_audits` records disagreements only. */
export interface AuditCount {
  readonly disagreements: number;
}

/** The flaky-test line: verdict audit disagreements over 7 days; crossed above one. */
export const flakyLine = (count: AuditCount): LineResult => {
  const { threshold } = KILL_LINE_WINDOWS.flaky;
  const value = Number(count.disagreements);
  if (value === 0)
    return {
      risk: KILL_LINE_RISKS.flaky,
      reason:
        "no verdict audit disagreement recorded in the last 7 days (the table records disagreements only)",
    };
  return {
    risk: KILL_LINE_RISKS.flaky,
    metric: "verdict audit disagreements over 7 days",
    value,
    threshold,
    crossed: value > threshold,
  };
};

/**
 * The required-slowdown line: how far the p95 time to verdict of every `required` execution lies above the p95 of
 * those a cloud setup took, in seconds; crossed above 60 s.
 */
export const requiredSlowdownLine = (samples: readonly KillLineVerdict[]): LineResult => {
  const { threshold } = KILL_LINE_WINDOWS.requiredSlowdown;
  const all = p95(samples.map((s) => s.ms));
  const cloud = p95(samples.filter((s) => s.kind !== DEVICE_KIND).map((s) => s.ms));
  if (all === null || cloud === null)
    return {
      risk: KILL_LINE_RISKS.requiredSlowdown,
      reason: "no required execution reached a verdict on a cloud setup in the last 14 days",
    };
  const value = round1((all - cloud) / 1000);
  return {
    risk: KILL_LINE_RISKS.requiredSlowdown,
    metric: "required p95 time to verdict above cloud-only p95 over 14 days, s",
    value,
    threshold,
    crossed: value > threshold,
  };
};

/** The operator-toil line: no record counts manual interventions on a device yet (specs/roadmap.md § Open items). */
const TOIL: UnmeasuredLine = {
  risk: KILL_LINE_RISKS.toil,
  reason: "no record counts manual interventions on a device",
};

/** The product-fit line: an operator decision, which no table measures. */
const PRODUCT_FIT: UnmeasuredLine = {
  risk: KILL_LINE_RISKS.productFit,
  reason: "an operator decision, not a metric",
};

const verdicts = (db: D1Like, windowMs: number, now: number) =>
  query<KillLineVerdict>(
    db,
    `select e.run as run, p.accepted_kind as kind, e.finished_at - e.enqueued_at as ms
     from executions e join placements p on p.execution_id = e.id
     where e.class = 'required' and e.status in ('success', 'failure')
       and e.finished_at is not null and p.accepted_kind is not null
       and e.finished_at > ? and e.finished_at <= ?`,
    now - windowMs,
    now,
  );

const unreadable = (risk: string) => (e: KillLineUnreadable) =>
  Effect.succeed<LineResult>({ risk, reason: `cannot be read: ${e.reason}` });

/** Every kill line of specs/roadmap.md at `now`: a reading over its window, or why it was not measured. */
export const readKillLines = (db: D1Like, now: number) =>
  Effect.gen(function* () {
    // The warm-state and required-slowdown lines share one 14-day window, so one read serves both.
    const required = yield* verdicts(db, KILL_LINE_WINDOWS.warmState.windowMs, now).pipe(
      Effect.map((samples) => [warmStateLine(samples), requiredSlowdownLine(samples)] as const),
      Effect.catchTag("KillLineUnreadable", (e) =>
        Effect.all([
          unreadable(KILL_LINE_RISKS.warmState)(e),
          unreadable(KILL_LINE_RISKS.requiredSlowdown)(e),
        ]),
      ),
    );
    const [warm, slowdown] = required;
    const availability = yield* query<EligibleCount>(
      db,
      `select count(*) as eligible, coalesce(sum(p.accepted_kind = ?), 0) as on_device
       from executions e join placements p on p.execution_id = e.id
       where p.accepted_kind is not null and e.finished_at is not null
         and e.finished_at > ? and e.finished_at <= ?
         and (p.eligible_kinds is null
           or exists (select 1 from json_each(p.eligible_kinds) k where k.value = ?))`,
      DEVICE_KIND,
      now - KILL_LINE_WINDOWS.availability.windowMs,
      now,
      DEVICE_KIND,
    ).pipe(
      Effect.map((rows) => availabilityLine(rows[0] ?? { eligible: 0, on_device: 0 })),
      Effect.catchTag("KillLineUnreadable", unreadable(KILL_LINE_RISKS.availability)),
    );
    const flaky = yield* query<AuditCount>(
      db,
      `select count(*) as disagreements from verdict_audits where recorded_at > ? and recorded_at <= ?`,
      now - KILL_LINE_WINDOWS.flaky.windowMs,
      now,
    ).pipe(
      Effect.map((rows) => flakyLine(rows[0] ?? { disagreements: 0 })),
      Effect.catchTag("KillLineUnreadable", unreadable(KILL_LINE_RISKS.flaky)),
    );
    return [warm, availability, TOIL, flaky, slowdown, PRODUCT_FIT];
  });

/** What one daily read did: each line's result and each `kill-line` notification's raise. */
export interface KillLineReport {
  readonly lines: readonly LineResult[];
  readonly raised: readonly { readonly risk: string; readonly result: RaiseResult }[];
}

/**
 * Reads every kill line at `now` and raises the `kill-line` notification, naming the risk, the metric, its value and
 * the threshold, for each crossed line (FD-VER-030). The dedupe key is per risk, so a line crossed again on the next
 * day's read is sent again at most once per 24 h while it stays raised.
 */
export const killLineMonitor = (db: D1Like, now: number) =>
  Effect.gen(function* () {
    const lines = yield* readKillLines(db, now);
    const raised: { risk: string; result: RaiseResult }[] = [];
    for (const alarm of killLineAlarms(lines.filter(isReading)))
      raised.push({ risk: alarm.detail.risk, result: yield* raiseOnce(db, alarm, now) });
    return { lines, raised } satisfies KillLineReport;
  });
