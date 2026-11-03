// Check re-runs: a `check_run` or `check_suite` `rerequested` event submits the
// next attempt of a FlareDispatch check family, with the same check name and
// class and no cooldown (FD-INT-054 to FD-INT-056). An attempt beyond the family's
// retry allowance counts against the `interactive` line (FD-SPD-032).
import { Effect, Result, Schema } from "effect";
import { IntakeConfig } from "./config.ts";
import type { WebhookFields } from "./event.ts";
import { IntakeStore, TERMINAL_STATUSES, type RecordWithStatus } from "./store.ts";
import { shed, submission } from "./submit.ts";
import { nothing, submitEach, type TriggerOutcome } from "./triggers.ts";

/** Attempts per check family, the first included. */
export const MAX_ATTEMPTS = 5;
/** The line a re-run beyond its family's allowance admits against (FD-SPD-032). */
export const RERUN_OVERFLOW_LINE = "interactive";

export type RerunRefusal =
  | "foreign_app"
  | "unknown_check_run"
  | "in_progress"
  | "attempts_exhausted"
  | "run_not_registered"
  | "inputs_unreplayable";

/** max(1 + the run's declared retries, 2) × the first attempt's hold (MAMEKO-SPD-031). */
export const familyAllowance = (retries: number, firstHold: number) =>
  Math.max(1 + retries, 2) * firstHold;

/**
 * The spend line of the next attempt: `interactive` when the family's spend plus another first-attempt hold would
 * exceed the allowance, else the family's own class line (null).
 */
export const rerunSpendLine = (
  retries: number,
  spend: { readonly spentMicroUsd: number; readonly firstHoldMicroUsd: number | null },
): string | null =>
  spend.firstHoldMicroUsd !== null &&
  spend.spentMicroUsd + spend.firstHoldMicroUsd > familyAllowance(retries, spend.firstHoldMicroUsd)
    ? RERUN_OVERFLOW_LINE
    : null;

const latestOf = (family: readonly RecordWithStatus[]) =>
  family.reduce((a, b) => (b.attempt > a.attempt ? b : a));

const terminal = (r: RecordWithStatus) => r.status === null || TERMINAL_STATUSES.has(r.status);

/** The next attempt of one family, or the refusal that stops it (FD-INT-055). */
const nextAttempt = (family: readonly RecordWithStatus[]) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const store = yield* IntakeStore;
    const latest = latestOf(family);
    const refuse = (reason: RerunRefusal) => Result.fail({ reason, latest });
    if (!family.every(terminal)) return refuse("in_progress");
    if (latest.attempt >= MAX_ATTEMPTS) return refuse("attempts_exhausted");
    const run = config.catalog(latest.run);
    if (run === undefined) return refuse("run_not_registered");
    const inputs = Schema.decodeUnknownResult(run.input)(latest.inputs);
    if (Result.isFailure(inputs)) return refuse("inputs_unreplayable");
    const spendLine = rerunSpendLine(run.retries, yield* store.familySpend(latest.familyRoot));
    return Result.succeed(
      submission({
        run,
        trigger: latest.trigger,
        event: "check_run",
        label: latest.label,
        repo: latest.repo,
        sha: latest.sha,
        ref: latest.ref,
        inputs: inputs.success,
        installation: latest.installation,
        attempt: latest.attempt + 1,
        familyRoot: latest.familyRoot,
        forcedClass: latest.className,
        spendLine,
        cacheTrigger: latest.cacheTrigger,
        applyCooldown: false,
      }),
    );
  });

/** Submits the next attempt of a family, or records why not. */
const rerunFamily = (family: readonly RecordWithStatus[]) =>
  Effect.gen(function* () {
    const next = yield* nextAttempt(family);
    if (Result.isFailure(next)) {
      yield* shed(next.failure.latest.repo, next.failure.latest.run, next.failure.reason);
      return nothing;
    }
    return yield* submitEach([next.success]);
  });

const foreign = (appId: number, app: { readonly id: number } | null | undefined) =>
  app === undefined || app === null || app.id !== appId;

/** `check_run` `rerequested` on one check run (FD-INT-054, FD-INT-055). */
export const rerunCheckRun = (fields: WebhookFields, repo: string) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const store = yield* IntakeStore;
    const checkRun = fields.check_run;
    if (checkRun === undefined) return nothing;
    if (foreign(config.appId, checkRun.app)) {
      yield* shed(repo, null, "foreign_app");
      return nothing;
    }
    const id = checkRun.external_id ?? null;
    const record = id === null ? null : yield* store.get(id);
    if (record === null || record.repo !== repo) {
      yield* shed(repo, null, "unknown_check_run");
      return nothing;
    }
    return yield* rerunFamily(yield* store.family(record.familyRoot));
  });

/** `check_suite` `rerequested`: every family on the commit whose latest attempt did not succeed (FD-INT-056). */
export const rerunCheckSuite = (fields: WebhookFields, repo: string) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const store = yield* IntakeStore;
    const suite = fields.check_suite;
    if (suite === undefined || suite.head_sha === undefined) return nothing;
    if (foreign(config.appId, suite.app)) {
      yield* shed(repo, null, "foreign_app");
      return nothing;
    }
    const families = new Map<string, RecordWithStatus[]>();
    for (const r of yield* store.atCommit(repo, suite.head_sha))
      families.set(r.familyRoot, [...(families.get(r.familyRoot) ?? []), r]);
    const outcomes: TriggerOutcome[] = [];
    for (const family of families.values()) {
      if (latestOf(family).status === "success") continue;
      outcomes.push(yield* rerunFamily(yield* store.family(family[0]!.familyRoot)));
    }
    return {
      executions: outcomes.flatMap((o) => o.executions),
      duplicate: outcomes.length > 0 && outcomes.every((o) => o.duplicate),
      unavailable: outcomes.find((o) => o.unavailable !== null)?.unavailable ?? null,
    } satisfies TriggerOutcome;
  });
