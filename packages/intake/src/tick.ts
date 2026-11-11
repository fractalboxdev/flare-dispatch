// The minute tick: it only plans units of work, and the caller runs each unit in
// its own Durable Object alarm or Queue message (FD-INT-067). A unit is one
// installation's missed-webhook sweep (every 10 min, FD-INT-032, FD-INT-033) or
// its scheduled runs for the minute (FD-INT-051 to FD-INT-053). Each unit stops
// within its subrequest budget and returns the cursor of the unit that continues.
import {
  GithubRead,
  InstallationQuota,
  type PullSummary,
} from "@fractalboxdev/flare-dispatch-github";
import { Clock, Effect, Match, Option, Schema } from "effect";
import { IntakeConfig } from "./config.ts";
import { cronMatches, parseCron } from "./cron.ts";
import type { WebhookEvent, WebhookFields } from "./event.ts";
import { submission } from "./submit.ts";
import {
  nothing,
  readManifest,
  submitEach,
  triggerWebhook,
  viewOf,
  type TriggerOutcome,
} from "./triggers.ts";

export const SWEEP_EVERY_MINUTES = 10;
export const SWEEP_WINDOW_MS = 72 * 3_600_000;
export const SWEEP_PULLS_PER_INSTALLATION = 100;
/** Below this share of its quota an installation is not swept (FD-INT-033). */
export const SWEEP_MIN_QUOTA_SHARE = 0.3;
/** A unit's subrequest bound is 1,000 (FD-INT-067); the margin covers admission and the store. */
export const UNIT_SUBREQUESTS = 800;

export const TickUnit = Schema.Union([
  Schema.TaggedStruct("sweep", {
    installation: Schema.Number,
    scheduledAt: Schema.Number,
    /** Index of the next repository, and how many pull requests the earlier units already looked at. */
    repoIndex: Schema.Number,
    pullsSeen: Schema.Number,
  }),
  Schema.TaggedStruct("schedules", {
    installation: Schema.Number,
    scheduledAt: Schema.Number,
    repoIndex: Schema.Number,
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

export interface UnitResult {
  readonly outcome: TriggerOutcome;
  /** The unit that continues this one, or null when it finished. */
  readonly next: TickUnit | null;
  /** Why the unit did nothing, when it did nothing on purpose. */
  readonly skipped: string | null;
}

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

/** A budget of subrequests; `spend` answers false once it would pass the bound. */
const budget = (limit: number) => {
  let used = 0;
  return { spend: (n: number) => (used + n > limit ? false : ((used += n), true)) };
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
      return { outcome: nothing, next: null, skipped: "quota below 30%" } satisfies UnitResult;
    const now = yield* Clock.currentTimeMillis;
    const spent = budget(UNIT_SUBREQUESTS);
    spent.spend(1);
    const repos = yield* github.repositories(unit.installation);
    let outcome = nothing;
    let pullsSeen = unit.pullsSeen;
    for (let i = unit.repoIndex; i < repos.length; i++) {
      if (pullsSeen >= SWEEP_PULLS_PER_INSTALLATION) break;
      const repo = repos[i]!;
      if (!spent.spend(1))
        return { outcome, next: { ...unit, repoIndex: i, pullsSeen }, skipped: null };
      const pulls = (yield* github.openPulls(repo))
        .filter((p) => now - Date.parse(p.updated_at) <= SWEEP_WINDOW_MS)
        .slice(0, SWEEP_PULLS_PER_INSTALLATION - pullsSeen);
      pullsSeen += pulls.length;
      for (const pr of pulls) {
        // Two reads for the required set, one for the head's check runs, and the trigger's manifest reads.
        if (!spent.spend(8))
          return { outcome, next: { ...unit, repoIndex: i, pullsSeen }, skipped: null };
        const required = (yield* github.requiredChecks(repo, pr.base.ref)).filter((n) =>
          n.startsWith("flare-dispatch/"),
        );
        if (required.length === 0) continue;
        const ours = (yield* github.checkRuns(repo, pr.head.sha)).filter(
          (r) => r.app?.id === config.appId,
        );
        if (required.every((n) => ours.some((r) => r.name === n))) continue;
        const { event, fields } = sweepEvent(repo, unit.installation, pr);
        outcome = merge(
          outcome,
          yield* triggerWebhook({
            event,
            fields,
            repo,
            sha: pr.head.sha,
            trigger: pr.head.repo?.full_name === pr.base.repo.full_name ? "webhook" : "fork-pr",
          }),
        );
      }
    }
    return { outcome, next: null, skipped: null } satisfies UnitResult;
  });

/** One installation's scheduled runs for the tick's minute, each pinned to its branch's head (FD-INT-052). */
const schedules = (unit: TickUnit & { readonly _tag: "schedules" }) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const github = yield* GithubRead;
    const spent = budget(UNIT_SUBREQUESTS);
    spent.spend(1);
    const repos = yield* github.repositories(unit.installation);
    let outcome = nothing;
    for (let i = unit.repoIndex; i < repos.length; i++) {
      const repo = repos[i]!;
      if (!spent.spend(3))
        return { outcome, next: { ...unit, repoIndex: i }, skipped: null } satisfies UnitResult;
      const defaultBranch = yield* github.defaultBranch(repo);
      const manifest = yield* readManifest(repo, yield* github.branchHead(repo, defaultBranch));
      if (Option.isNone(manifest)) continue;
      const subs = [];
      for (const entry of manifest.value.runs) {
        const run = config.catalog(entry.recipe);
        if (run === undefined || !config.allows(repo, run.name)) continue;
        for (const s of entry.schedules ?? []) {
          const cron = parseCron(s.cron);
          if (cron === null || !cronMatches(cron, unit.scheduledAt)) continue;
          const branch = s.branch ?? defaultBranch;
          if (!spent.spend(1))
            return { outcome, next: { ...unit, repoIndex: i }, skipped: null } satisfies UnitResult;
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
          };
          const inputs = run.trigger(event, viewOf(entry, manifest.value), { defaultBranch });
          if (Option.isNone(inputs)) continue;
          subs.push(
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
          );
        }
      }
      outcome = merge(outcome, yield* submitEach(subs));
    }
    return { outcome, next: null, skipped: null } satisfies UnitResult;
  });

/** Runs one unit the tick planned. */
export const runTickUnit = (unit: TickUnit) =>
  Match.value(unit)
    .pipe(Match.tag("sweep", sweep), Match.tag("schedules", schedules), Match.exhaustive)
    .pipe(
      Effect.catchTags({
        GithubHttpError: (e) =>
          Effect.succeed<UnitResult>({ outcome: nothing, next: null, skipped: e.message }),
        GithubNetworkError: (e) =>
          Effect.succeed<UnitResult>({ outcome: nothing, next: null, skipped: e.message }),
        GithubUncredentialed: (e) =>
          Effect.succeed<UnitResult>({
            outcome: nothing,
            next: null,
            skipped: `no installation serves ${e.repo}`,
          }),
        GithubUnexpected: (e) =>
          Effect.succeed<UnitResult>({ outcome: nothing, next: null, skipped: e.message }),
      }),
    );
