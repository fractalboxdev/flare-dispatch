// One request to mameko's admission function (FD-INT-001). Intake writes its own
// record and, for a refusal before admission, a shed row; every `executions`,
// dedup-key and `placements` row is admission's.
import { eligibleKinds, type Profile } from "@fractalboxdev/flare-dispatch-profile";
import { executionId as newExecutionId } from "@fractalboxdev/mameko-coordinator";
import type { D1AdmitInput } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Clock, Effect, Match } from "effect";
import {
  Admission,
  boundsOf,
  ClassResolver,
  IntakeConfig,
  intakeError,
  type IntakeError,
} from "./config.ts";
import { requestKey, type KeyedRequest } from "./dedup.ts";
import {
  OTHER_CACHE_TRIGGER,
  type CacheTriggerRecord,
  type Caller,
  type RecordedTrigger,
} from "./event.ts";
import { checkName, type IntakeRun } from "./runs.ts";
import { IntakeStore, ShedRecorder, type IntakeRecord, type StoreUnavailable } from "./store.ts";

export const COOLDOWN_MIN_SEC = 60;
export const COOLDOWN_MAX_SEC = 86_400;

/** A run's cooldown window, clamped to 60 s to 86400 s (FD-INT-058). */
export const clampCooldown = (seconds: number) =>
  Math.min(COOLDOWN_MAX_SEC, Math.max(COOLDOWN_MIN_SEC, Math.floor(seconds)));

export interface Submission extends Omit<KeyedRequest, "run"> {
  readonly run: IntakeRun;
  readonly trigger: RecordedTrigger;
  /** The webhook event name; null for another trigger kind. */
  readonly event: string | null;
  readonly ref: string;
  readonly inputs: unknown;
  readonly installation: number | null;
  readonly caller: Caller | null;
  readonly classInput: string | null;
  /** The id of attempt 1 when this request is a re-run; null for a first attempt. */
  readonly familyRoot: string | null;
  /** A re-run keeps its family's class (FD-INT-054). */
  readonly forcedClass: string | null;
  readonly spendLine: string | null;
  /** False for `cron` triggers and check re-runs (FD-INT-058). */
  readonly applyCooldown: boolean;
  readonly placementConstraint: string | null;
  readonly extraLabels: readonly string[];
  /** What the cache namespaces read of the trigger (FD-CACHE-019); `Other` unless a webhook says more. */
  readonly cacheTrigger: CacheTriggerRecord;
  /** The repository's default branch, when the trigger read it. */
  readonly defaultBranch: string | null;
  /** The branch whose required set decides a gating run (specs/profile.md § Class resolution, step 2). */
  readonly targetBranch: string | null;
  /** Whether a ruleset or branch protection protects a push's ref; null when intake did not read it. */
  readonly refProtection: boolean | null;
}

export const submission = (
  fields: Pick<Submission, "run" | "trigger" | "repo" | "sha" | "ref" | "inputs"> &
    Partial<Submission>,
): Submission => ({
  event: null,
  label: null,
  installation: null,
  caller: null,
  classInput: null,
  idempotency: null,
  followOn: null,
  attempt: 1,
  cronMinute: null,
  local: null,
  familyRoot: null,
  forcedClass: null,
  spendLine: null,
  applyCooldown: true,
  placementConstraint: null,
  extraLabels: [],
  cacheTrigger: OTHER_CACHE_TRIGGER,
  defaultBranch: null,
  targetBranch: null,
  refProtection: null,
  ...fields,
});

export interface Admitted {
  readonly executionId: string;
  readonly className: string;
  readonly duplicate: boolean;
  /** Admission concluded the execution at once, with this reason (MAMEKO-ADM-041). */
  readonly concluded: string | null;
  readonly notBefore: number | null;
}

/** Records a request rejected before admission (MAMEKO-ADM-086). */
export const shed = (repo: string, run: string | null, reason: string) =>
  ShedRecorder.use((s) => s.record({ scopeId: repo, run, reason, estimatedCost: null }));

const cooldownBucket = (s: Submission, scope: string) => `${s.run.name}:${s.repo}:${scope}`;

/** The end of the open cooldown window of the request's bucket, or null when none is open (FD-INT-057). */
const cooldownWait = (s: Submission, now: number) =>
  Effect.gen(function* () {
    const cooldown = s.run.cooldown;
    if (!s.applyCooldown || cooldown === undefined) return null;
    const store = yield* IntakeStore;
    const bucket = cooldownBucket(s, cooldown.scope(s.inputs));
    const prior = yield* store.cooldown(bucket);
    const windowMs = clampCooldown(cooldown.seconds) * 1000;
    const notBefore = prior === null ? null : prior.armedAt + windowMs;
    return { bucket, notBefore: notBefore !== null && notBefore > now ? notBefore : null };
  });

/**
 * The executor kinds the profile's placement allows a request: its class, the labels class resolution returned with
 * the run's capability labels and any recorded placement constraint, and the constraints the run declares for these
 * inputs, so a `cloud-pinned` run never reaches a device (FD-GATE-061, FD-GATE-080).
 */
export const placementKinds = (
  profile: Profile,
  s: Submission,
  className: string,
  labels: readonly string[],
): readonly string[] => {
  const declared = s.run.placement?.(s.inputs) ?? { constraints: [], labels: [] };
  const tagPush = s.cacheTrigger._tag === "Push" && s.cacheTrigger.ref.startsWith("refs/tags/");
  return eligibleKinds(profile, {
    class: className,
    labels: [
      ...new Set([
        ...labels,
        ...declared.labels,
        ...(s.placementConstraint === null ? [] : [s.placementConstraint]),
      ]),
    ],
    constraints: declared.constraints,
    ...(tagPush ? { trigger: "tag-push" } : {}),
  }).kinds;
};

export const submit = (
  s: Submission,
): Effect.Effect<
  Admitted,
  IntakeError | StoreUnavailable,
  IntakeConfig | Admission | ClassResolver | IntakeStore | ShedRecorder
> =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const admission = yield* Admission;
    const store = yield* IntakeStore;
    const now = yield* Clock.currentTimeMillis;
    const name = checkName(s.run.name, s.label);

    const resolution =
      s.forcedClass === null
        ? yield* (yield* ClassResolver).resolve({
            run: s.run,
            trigger: s.trigger,
            event: s.event,
            repo: s.repo,
            ref: s.ref,
            sha: s.sha,
            defaultBranch: s.defaultBranch,
            targetBranch: s.targetBranch,
            refProtection: s.refProtection,
            checkName: name,
            classInput: s.classInput,
            caller: s.caller,
          })
        : ({ _tag: "Class", class: s.forcedClass, labels: [], alarm: null } as const);
    const resolved = yield* Match.value(resolution).pipe(
      Match.tag("Class", (r) => Effect.succeed(r)),
      Match.tag("Fail", ({ reason }) =>
        Effect.andThen(
          shed(s.repo, s.run.name, reason),
          Effect.fail(intakeError(403, "forbidden", `class resolution refused: ${reason}`)),
        ),
      ),
      Match.exhaustive,
    );
    const className = resolved.class;
    const bounds = yield* boundsOf(config.profile, className);
    const key = yield* requestKey({ ...s, run: s.run.name });
    const cooldown = yield* cooldownWait(s, now);
    const id = newExecutionId(now, Math.random);

    const labels = [...new Set([...resolved.labels, ...s.extraLabels])];
    const notBefore = cooldown?.notBefore ?? null;
    const record: IntakeRecord = {
      executionId: id,
      trigger: s.trigger,
      run: s.run.name,
      label: s.label,
      repo: s.repo,
      sha: s.sha,
      ref: s.ref,
      inputs: s.inputs,
      // A held request's duration counts from the end of its window.
      deadlineAtMs: (notBefore ?? now) + s.run.maxDurationSec * 1000,
      className,
      labels,
      attempt: s.attempt,
      familyRoot: s.familyRoot ?? id,
      installation: s.installation,
      caller: s.caller?.id ?? null,
      notBefore,
      spendLine: s.spendLine,
      placementConstraint: s.placementConstraint,
      cacheTrigger: s.cacheTrigger,
      eligibleKinds: placementKinds(config.profile, s, className, labels),
      createdAt: now,
    };
    const admitInput: D1AdmitInput = {
      executionId: id,
      scopeId: s.repo,
      run: s.run.name,
      className,
      enqueuedAtMs: now,
      dedup: {
        sha256: key.sha256,
        canonical: key.canonical,
        requestDigest: key.requestDigest,
        onMismatch: key.onMismatch,
      },
      bounds,
    };

    // Inside the run's cooldown window the request is held before admission, and the minute tick admits it once the
    // window ends (FD-INT-057). A request whose dedup key already names an execution, held or admitted, answers it.
    if (cooldown !== null && notBefore !== null) {
      const held = yield* store.hold(record, {
        admit: admitInput,
        cooldownBucket: cooldown.bucket,
        notBefore,
      });
      if (held._tag === "Held")
        return { executionId: id, className, duplicate: false, concluded: null, notBefore };
      if (key.onMismatch === "conflict" && held.requestDigest !== key.requestDigest)
        return yield* Effect.fail(
          intakeError(
            409,
            "conflict",
            "the Idempotency-Key names a request with another body",
            held.executionId,
          ),
        );
      return {
        executionId: held.executionId,
        className,
        duplicate: true,
        concluded: null,
        notBefore: null,
      };
    }

    // The record goes in first, so a device that claims the moment admission commits finds the inputs, and the
    // placement row admission inserts takes the record's eligible kinds.
    yield* store.put(record);
    const admitted = yield* admission
      .admit(admitInput)
      .pipe(
        Effect.catchTag("IntakeUnavailable", () =>
          Effect.andThen(
            store.drop(id),
            Effect.fail(
              intakeError(503, "intake_unavailable", "admission failed; nothing was written"),
            ),
          ),
        ),
      );
    return yield* Match.value(admitted).pipe(
      Match.tag("Queued", ({ executionId }) =>
        Effect.gen(function* () {
          if (cooldown !== null) yield* store.armCooldown(cooldown.bucket, executionId, now);
          yield* admission.queued(className);
          return { executionId, className, duplicate: false, concluded: null, notBefore: null };
        }),
      ),
      Match.tag("Concluded", ({ executionId, reason }) =>
        Effect.succeed<Admitted>({
          executionId,
          className,
          duplicate: false,
          concluded: reason,
          notBefore: null,
        }),
      ),
      Match.tag("Duplicate", ({ executionId }) =>
        Effect.as(store.drop(id), {
          executionId,
          className,
          duplicate: true,
          concluded: null,
          notBefore: null,
        } satisfies Admitted),
      ),
      Match.tag("Conflict", ({ executionId }) =>
        Effect.andThen(
          store.drop(id),
          Effect.fail(
            intakeError(
              409,
              "conflict",
              "the Idempotency-Key names a request with another body",
              executionId,
            ),
          ),
        ),
      ),
      Match.exhaustive,
    );
  });

/** Held requests one pass admits; the rest wait for the next minute's pass. */
export const RELEASE_PER_PASS = 100;

export interface ReleaseReport {
  readonly admitted: number;
  readonly concluded: number;
  readonly duplicate: number;
  /** Requests admission could not answer; they stay held for the next pass. */
  readonly unavailable: number;
  /** True when the pass stopped at its limit with more requests due. */
  readonly more: boolean;
}

/**
 * Admits every held request whose cooldown window has ended (FD-INT-057). An admitted request arms its bucket's window
 * from now; a request admission answers as a duplicate or a conflict loses its record, as at submit.
 */
export const releaseHeld = (
  limit: number = RELEASE_PER_PASS,
): Effect.Effect<ReleaseReport, StoreUnavailable, Admission | IntakeStore> =>
  Effect.gen(function* () {
    const store = yield* IntakeStore;
    const admission = yield* Admission;
    const now = yield* Clock.currentTimeMillis;
    const due = yield* store.due(now, limit);
    let admitted = 0;
    let concluded = 0;
    let duplicate = 0;
    let unavailable = 0;
    for (const held of due) {
      const id = held.admit.executionId;
      const result = yield* admission
        .admit({ ...held.admit, enqueuedAtMs: now })
        .pipe(Effect.catchTag("IntakeUnavailable", () => Effect.succeed(null)));
      if (result === null) {
        unavailable++;
        continue;
      }
      yield* Match.value(result).pipe(
        Match.tag("Queued", () =>
          Effect.gen(function* () {
            yield* store.release(id);
            yield* store.armCooldown(held.cooldownBucket, id, now);
            yield* admission.queued(held.admit.className);
            admitted++;
          }),
        ),
        Match.tag("Concluded", () =>
          Effect.andThen(
            store.release(id),
            Effect.sync(() => void concluded++),
          ),
        ),
        Match.tag("Duplicate", "Conflict", () =>
          Effect.gen(function* () {
            yield* store.release(id);
            yield* store.drop(id);
            duplicate++;
          }),
        ),
        Match.exhaustive,
      );
    }
    return { admitted, concluded, duplicate, unavailable, more: due.length === limit };
  });
