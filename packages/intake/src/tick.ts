// The minute tick: it only plans units of work, and the caller runs each unit in
// its own Durable Object alarm (FD-INT-067). A unit is one installation's
// missed-webhook sweep (every 10 min, FD-INT-032, FD-INT-033) or its scheduled
// runs for the minute (FD-INT-051 to FD-INT-053). Each unit stops within its
// subrequest and D1-query budgets and returns the cursor of the unit that
// continues it; the unit queue runs that unit in the next alarm.
import {
  GithubRead,
  InstallationQuota,
  type PullSummary,
} from "@fractalboxdev/flare-dispatch-github";
import { Cause, Clock, Effect, Exit, Match, Option, Schema } from "effect";
import { IntakeConfig } from "./config.ts";
import { cronMatches, parseCron } from "./cron.ts";
import type { WebhookEvent, WebhookFields } from "./event.ts";
import { submission } from "./submit.ts";
import {
  nothing,
  readManifest,
  submitEach,
  viewOf,
  webhookSubmissions,
  type TriggerOutcome,
} from "./triggers.ts";

export const SWEEP_EVERY_MINUTES = 10;
export const SWEEP_WINDOW_MS = 72 * 3_600_000;
export const SWEEP_PULLS_PER_INSTALLATION = 100;
/** Below this share of its quota an installation is not swept (FD-INT-033). */
export const SWEEP_MIN_QUOTA_SHARE = 0.3;
/** A unit's subrequest bound is 1,000 (FD-INT-067); the margin covers the estimates' error. */
export const UNIT_SUBREQUESTS = 800;
/** A unit's D1-query bound is 500 (FD-INT-067); the margin covers the estimates' error. */
export const UNIT_D1_QUERIES = 400;
/**
 * The most D1 queries one submission makes: admission's transaction, dedup, cooldown, the intake record and a held
 * request's row, or a refusal's shed row.
 */
export const SUBMISSION_D1_QUERIES = 30;
/** The subrequests one submission makes: the workflow start and a held request's queued check run. */
export const SUBMISSION_SUBREQUESTS = 2;
/** The D1 queries a manifest read makes: the shed row an unreadable or invalid manifest records. */
export const MANIFEST_D1_QUERIES = 2;

export const TickUnit = Schema.Union([
  Schema.TaggedStruct("sweep", {
    installation: Schema.Number,
    scheduledAt: Schema.Number,
    /**
     * Index of the next repository, index of the next pull request among that repository's recent ones (0 when
     * absent), and how many pull requests the earlier units already looked at.
     */
    repoIndex: Schema.Number,
    pullIndex: Schema.optionalKey(Schema.Number),
    pullsSeen: Schema.Number,
    /** How many of the next pull request's submissions the earlier units already made (0 when absent). */
    submitted: Schema.optionalKey(Schema.Number),
  }),
  Schema.TaggedStruct("schedules", {
    installation: Schema.Number,
    scheduledAt: Schema.Number,
    repoIndex: Schema.Number,
    /** How many of the next repository's matching schedules the earlier units already submitted (0 when absent). */
    submitted: Schema.optionalKey(Schema.Number),
  }),
]);
export type TickUnit = typeof TickUnit.Type;

/** The units one tick enqueues; the tick itself reads and submits nothing. */
export const planTick = (
  scheduledAt: number,
  installations: readonly number[],
): readonly TickUnit[] => {
  const minute = new Date(scheduledAt).getUTCMinutes();
  return installations.flatMap((installation): TickUnit[] => [
    { _tag: "schedules", installation, scheduledAt, repoIndex: 0 },
    ...(minute % SWEEP_EVERY_MINUTES === 0
      ? [{ _tag: "sweep" as const, installation, scheduledAt, repoIndex: 0, pullsSeen: 0 }]
      : []),
  ]);
};

/** The budget a unit stopped at. */
export type UnitBound = "subrequests" | "d1-queries";

export interface UnitResult {
  readonly outcome: TriggerOutcome;
  /** The unit that continues this one, or null when it finished. */
  readonly next: TickUnit | null;
  /** Why the unit did nothing, when it did nothing on purpose. */
  readonly skipped: string | null;
  /** The budget the unit stopped at, when it returned a continuation. */
  readonly stoppedAt: UnitBound | null;
}

const finished = (outcome: TriggerOutcome, skipped: string | null = null): UnitResult => ({
  outcome,
  next: null,
  skipped,
  stoppedAt: null,
});

const merge = (a: TriggerOutcome, b: TriggerOutcome): TriggerOutcome => ({
  executions: [...a.executions, ...b.executions],
  duplicate:
    a.executions.length === 0
      ? b.duplicate
      : b.executions.length === 0
        ? a.duplicate
        : a.duplicate && b.duplicate,
  unavailable: a.unavailable ?? b.unavailable,
});

/** A unit's budgets; `spend` answers the bound a spend would pass, and spends nothing then. */
const budget = () => {
  let subrequests = 0;
  let queries = 0;
  return {
    spend: (s: number, q: number): UnitBound | null => {
      if (subrequests + s > UNIT_SUBREQUESTS) return "subrequests";
      if (queries + q > UNIT_D1_QUERIES) return "d1-queries";
      subrequests += s;
      queries += q;
      return null;
    },
  };
};

/** The `pull_request` event the sweep submits for a head that lacks a required check run. */
export const sweepEvent = (
  repo: string,
  installation: number,
  pr: PullSummary,
): { readonly event: WebhookEvent; readonly fields: WebhookFields } => {
  const fields: WebhookFields = {
    action: "synchronize",
    repository: { full_name: repo },
    installation: { id: installation },
    pull_request: {
      number: pr.number,
      head: { sha: pr.head.sha, ref: pr.head.ref, repo: pr.head.repo },
      base: { ref: pr.base.ref, repo: pr.base.repo },
    },
  };
  return {
    fields,
    event: {
      _tag: "webhook",
      event: "pull_request",
      action: "synchronize",
      deliveryId: `sweep:${repo}#${pr.number}@${pr.head.sha}`,
      payload: fields,
    },
  };
};

/**
 * One installation's sweep: its open pull requests updated in the last 72 h, at most 100, and a `webhook` trigger
 * through intake for every head that lacks a FlareDispatch check run of its base branch's required set.
 */
const sweep = (unit: TickUnit & { readonly _tag: "sweep" }) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const github = yield* GithubRead;
    const quota = yield* InstallationQuota;
    if ((yield* quota.remainingShare(String(unit.installation))) < SWEEP_MIN_QUOTA_SHARE)
      return finished(nothing, "quota below 30%");
    const now = yield* Clock.currentTimeMillis;
    const spent = budget();
    spent.spend(1, 0);
    const repos = yield* github.repositories(unit.installation);
    let outcome = nothing;
    let pullsSeen = unit.pullsSeen;
    /** The submissions of repository `i`'s pull request `k` the earlier units already made. */
    const made = (i: number, k: number) =>
      i === unit.repoIndex && k === (unit.pullIndex ?? 0) ? (unit.submitted ?? 0) : 0;
    const stop = (
      stoppedAt: UnitBound,
      cursor: { repoIndex: number; pullIndex: number; pullsSeen: number; submitted: number },
    ): UnitResult => ({ outcome, next: { ...unit, ...cursor }, skipped: null, stoppedAt });
    for (let i = unit.repoIndex; i < repos.length; i++) {
      if (pullsSeen >= SWEEP_PULLS_PER_INSTALLATION) break;
      const repo = repos[i]!;
      // A unit that continues another resumes at the pull request its predecessor stopped before.
      const from = i === unit.repoIndex ? (unit.pullIndex ?? 0) : 0;
      const listed = spent.spend(1, 0);
      if (listed !== null)
        return stop(listed, { repoIndex: i, pullIndex: from, pullsSeen, submitted: made(i, from) });
      const pulls = (yield* github.openPulls(repo))
        .filter((p) => now - Date.parse(p.updated_at) <= SWEEP_WINDOW_MS)
        .slice(from, from + SWEEP_PULLS_PER_INSTALLATION - pullsSeen);
      for (const [k, pr] of pulls.entries()) {
        const at = from + k;
        const skip = made(i, at);
        // Two reads for the required set, one for the head's check runs, and the trigger's manifest reads.
        const read = spent.spend(8, MANIFEST_D1_QUERIES);
        if (read !== null)
          return stop(read, {
            repoIndex: i,
            pullIndex: at,
            pullsSeen,
            submitted: skip,
          });
        pullsSeen++;
        const required = (yield* github.requiredChecks(repo, pr.base.ref)).filter((n) =>
          n.startsWith("flare-dispatch/"),
        );
        if (required.length === 0) continue;
        const ours = (yield* github.checkRuns(repo, pr.head.sha)).filter(
          (r) => r.app?.id === config.appId,
        );
        if (required.every((n) => ours.some((r) => r.name === n))) continue;
        const { event, fields } = sweepEvent(repo, unit.installation, pr);
        const subs = yield* webhookSubmissions({
          event,
          fields,
          repo,
          sha: pr.head.sha,
          trigger: pr.head.repo?.full_name === pr.base.repo.full_name ? "webhook" : "fork-pr",
        });
        for (let j = skip; j < subs.length; j++) {
          // A pull request whose submissions pass the budget is continued at its next submission, and counted again.
          const bound = spent.spend(SUBMISSION_SUBREQUESTS, SUBMISSION_D1_QUERIES);
          if (bound !== null)
            return stop(bound, {
              repoIndex: i,
              pullIndex: at,
              pullsSeen: pullsSeen - 1,
              submitted: j,
            });
          outcome = merge(outcome, yield* submitEach([subs[j]!]));
        }
      }
    }
    return finished(outcome);
  });

/** One installation's scheduled runs for the tick's minute, each pinned to its branch's head (FD-INT-052). */
const schedules = (unit: TickUnit & { readonly _tag: "schedules" }) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const github = yield* GithubRead;
    const spent = budget();
    spent.spend(1, 0);
    const repos = yield* github.repositories(unit.installation);
    let outcome = nothing;
    const stop = (stoppedAt: UnitBound, repoIndex: number, submitted: number): UnitResult => ({
      outcome,
      next: { ...unit, repoIndex, submitted },
      skipped: null,
      stoppedAt,
    });
    for (let i = unit.repoIndex; i < repos.length; i++) {
      const repo = repos[i]!;
      const skip = i === unit.repoIndex ? (unit.submitted ?? 0) : 0;
      const read = spent.spend(3, MANIFEST_D1_QUERIES);
      if (read !== null) return stop(read, i, skip);
      const defaultBranch = yield* github.defaultBranch(repo);
      const manifest = yield* readManifest(repo, yield* github.branchHead(repo, defaultBranch));
      if (Option.isNone(manifest)) continue;
      // `matched` counts the repository's schedules that match the minute, in manifest order; a continuation skips
      // the ones its predecessors submitted.
      let matched = 0;
      for (const entry of manifest.value.runs) {
        const run = config.catalog(entry.recipe);
        if (run === undefined || !config.allows(repo, run.name)) continue;
        for (const s of entry.schedules ?? []) {
          const cron = parseCron(s.cron);
          if (cron === null || !cronMatches(cron, unit.scheduledAt)) continue;
          if (matched++ < skip) continue;
          const branch = s.branch ?? defaultBranch;
          const bound = spent.spend(1 + SUBMISSION_SUBREQUESTS, SUBMISSION_D1_QUERIES);
          if (bound !== null) return stop(bound, i, matched - 1);
          // A schedule whose branch does not read is skipped; the repository's other schedules still run.
          const head = yield* Effect.option(github.branchHead(repo, branch));
          if (Option.isNone(head)) {
            yield* Effect.logWarning("scheduled run skipped: branch head unreadable", {
              repo,
              branch,
            });
            continue;
          }
          const sha = head.value;
          const event = {
            _tag: "cron" as const,
            scheduledAt: unit.scheduledAt,
            repo,
            schedule: s.cron,
            branch,
          };
          const inputs = run.trigger(event, viewOf(entry, manifest.value), { defaultBranch });
          if (Option.isNone(inputs)) continue;
          outcome = merge(
            outcome,
            yield* submitEach([
              submission({
                run,
                trigger: "cron",
                label: entry.label ?? null,
                repo,
                sha,
                ref: `refs/heads/${branch}`,
                inputs: inputs.value,
                installation: unit.installation,
                cronMinute: unit.scheduledAt,
                applyCooldown: false,
              }),
            ]),
          );
        }
      }
    }
    return finished(outcome);
  });

/** Runs one unit the tick planned. */
export const runTickUnit = (unit: TickUnit) =>
  Match.value(unit)
    .pipe(Match.tag("sweep", sweep), Match.tag("schedules", schedules), Match.exhaustive)
    .pipe(
      Effect.catchTags({
        GithubHttpError: (e) => Effect.succeed(finished(nothing, e.message)),
        GithubNetworkError: (e) => Effect.succeed(finished(nothing, e.message)),
        GithubUncredentialed: (e) =>
          Effect.succeed(finished(nothing, `no installation serves ${e.repo}`)),
        GithubUnexpected: (e) => Effect.succeed(finished(nothing, e.message)),
        QuotaUnavailable: (e) => Effect.succeed(finished(nothing, `quota unavailable: ${e.message}`)),
      }),
    );

// ---------------------------------------------------------------------------
// The unit queue: one per installation, kept in a Durable Object's storage. The tick enqueues the units it plans; each
// alarm runs the queue's first unit, queues the unit that continues it and re-arms, so every unit has its own alarm
// and with it its own subrequest and D1-query allowance.

/** The storage a unit queue lives in: a Durable Object's. */
export interface UnitQueueStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

/** How often an alarm runs a unit that fails before the queue drops it; the next plan covers it again. */
export const UNIT_ATTEMPTS = 3;
/** How long a failed unit waits before its next attempt. */
export const UNIT_RETRY_MS = 30_000;

const QueuedUnit = Schema.Struct({ unit: TickUnit, attempts: Schema.Number });
type QueuedUnit = typeof QueuedUnit.Type;
const QUEUE_KEY = "units";

const readQueue = (storage: UnitQueueStorage) =>
  Effect.gen(function* () {
    const raw = yield* Effect.promise(() => storage.get(QUEUE_KEY));
    if (raw === undefined) return [] as readonly QueuedUnit[];
    return yield* Schema.decodeUnknownEffect(Schema.Array(QueuedUnit))(raw).pipe(
      Effect.catch((e) =>
        Effect.as(
          Effect.logError("unit queue unreadable; dropping it", { error: String(e) }),
          [] as readonly QueuedUnit[],
        ),
      ),
    );
  });

/** Writes the queue and arms the alarm while units remain; `rearm` moves an armed alarm to `alarmAt`. */
const writeQueue = (
  storage: UnitQueueStorage,
  queue: readonly QueuedUnit[],
  alarmAt: number,
  rearm: boolean,
) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => storage.put(QUEUE_KEY, queue));
    if (queue.length === 0) return;
    if (rearm || (yield* Effect.promise(() => storage.getAlarm())) === null)
      yield* Effect.promise(() => storage.setAlarm(alarmAt));
  });

const keyOf = (unit: TickUnit) => JSON.stringify(Object.entries(unit).sort());

/**
 * Appends the units a tick planned to the queue, skipping one already queued (a tick fired twice for its minute), and
 * arms the alarm. Answers how many it added.
 */
export const enqueueUnits = (storage: UnitQueueStorage, units: readonly TickUnit[], now: number) =>
  Effect.gen(function* () {
    const queue = [...(yield* readQueue(storage))];
    const keys = new Set(queue.map((q) => keyOf(q.unit)));
    let added = 0;
    for (const unit of units) {
      const key = keyOf(unit);
      if (keys.has(key)) continue;
      keys.add(key);
      queue.push({ unit, attempts: 0 });
      added++;
    }
    yield* writeQueue(storage, queue, now, false);
    return added;
  });

/** What one alarm did: the unit it ran and its result, or the failure it recorded. */
export type QueuedRun =
  | { readonly _tag: "Ran"; readonly unit: TickUnit; readonly result: UnitResult }
  | {
      readonly _tag: "Failed";
      readonly unit: TickUnit;
      readonly attempts: number;
      readonly dropped: boolean;
    };

/**
 * Removes the unit an alarm ran from the queue as it stands now and appends `after` (its continuation or its retry,
 * unless already queued). The queue is read again after the unit ran: the unit's GitHub reads and D1 queries let an
 * `enqueue` from a later tick run meanwhile, and a write of the queue read before the unit would drop what it added.
 */
const settleQueue = (storage: UnitQueueStorage, ran: TickUnit, after: QueuedUnit | null) =>
  Effect.gen(function* () {
    const queue = [...(yield* readQueue(storage))];
    const ranKey = keyOf(ran);
    const at = queue.findIndex((q) => keyOf(q.unit) === ranKey);
    if (at !== -1) queue.splice(at, 1);
    const others = queue.length;
    if (after !== null && !queue.some((q) => keyOf(q.unit) === keyOf(after.unit)))
      queue.push(after);
    return { queue, others };
  });

/**
 * One alarm of the queue: runs its first unit, queues the unit that continues it, and re-arms while units remain. A
 * unit that fails goes to the back of the queue, and after `UNIT_ATTEMPTS` failures leaves it. Units enqueued while
 * the unit runs stay queued. Answers null when the queue is empty.
 */
export const runQueuedUnit = (
  storage: UnitQueueStorage,
  now: number,
): Effect.Effect<QueuedRun | null, never, Effect.Services<ReturnType<typeof runTickUnit>>> =>
  Effect.gen(function* () {
    const [head] = yield* readQueue(storage);
    if (head === undefined) return null;
    const exit = yield* Effect.exit(runTickUnit(head.unit));
    if (Exit.isSuccess(exit)) {
      const result = exit.value;
      const next = result.next === null ? null : { unit: result.next, attempts: 0 };
      const { queue } = yield* settleQueue(storage, head.unit, next);
      yield* writeQueue(storage, queue, now, true);
      return { _tag: "Ran", unit: head.unit, result } as const;
    }
    const attempts = head.attempts + 1;
    const dropped = attempts >= UNIT_ATTEMPTS;
    yield* Effect.logError("tick unit failed", {
      unit: head.unit,
      attempts,
      dropped,
      cause: Cause.pretty(exit.cause),
    });
    const { queue, others } = yield* settleQueue(
      storage,
      head.unit,
      dropped ? null : { unit: head.unit, attempts },
    );
    yield* writeQueue(storage, queue, others > 0 ? now : now + UNIT_RETRY_MS, true);
    return { _tag: "Failed", unit: head.unit, attempts, dropped } as const;
  });
