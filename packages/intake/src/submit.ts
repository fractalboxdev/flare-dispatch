// One request to mameko's admission function (FD-INT-001). Intake writes its own
// record and, for a refusal before admission, a shed row; every `executions`,
// dedup-key and `placements` row is admission's.
import { executionId as newExecutionId } from "@fractalboxdev/mameko-coordinator";
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
import type { Caller, RecordedTrigger } from "./event.ts";
import { checkName, type IntakeRun } from "./runs.ts";
import { IntakeStore, ShedRecorder, type StoreUnavailable } from "./store.ts";

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

    // The record goes in first, so a device that claims the moment admission commits finds the inputs.
    yield* store.put({
      executionId: id,
      trigger: s.trigger,
      run: s.run.name,
      label: s.label,
      repo: s.repo,
      sha: s.sha,
      ref: s.ref,
      inputs: s.inputs,
      deadlineAtMs: now + s.run.maxDurationSec * 1000,
      className,
      labels: [...new Set([...resolved.labels, ...s.extraLabels])],
      attempt: s.attempt,
      familyRoot: s.familyRoot ?? id,
      installation: s.installation,
      caller: s.caller?.id ?? null,
      notBefore: cooldown?.notBefore ?? null,
      spendLine: s.spendLine,
      placementConstraint: s.placementConstraint,
      createdAt: now,
    });
    const admitted = yield* admission
      .admit({
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
      })
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
          if (cooldown !== null && cooldown.notBefore === null)
            yield* store.armCooldown(cooldown.bucket, executionId, now);
          yield* admission.queued(className);
          return {
            executionId,
            className,
            duplicate: false,
            concluded: null,
            notBefore: cooldown?.notBefore ?? null,
          };
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
