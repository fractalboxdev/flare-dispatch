// One request to mameko's admission function (FD-INT-001). Intake writes its own
// record and, for a refusal before admission, a shed row; every `executions`,
// dedup-key and `placements` row is admission's.
import {
  placementInputs,
  type ConfidentialityMode,
  type PlacementRequest,
  type Profile,
} from "@fractalboxdev/flare-dispatch-profile";
import { executionId as newExecutionId, type AdmitAnswer } from "@fractalboxdev/mameko-coordinator";
import { Clock, Effect, Match } from "effect";
import {
  Admission,
  boundsOf,
  ClassResolver,
  IntakeConfig,
  intakeError,
  type ExecutionStartFailed,
  type IntakeAdmitInput,
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
  /**
   * Admission concluded the execution at once: its reason (`capacity: queue full`, MAMEKO-ADM-040), `expired` or
   * `deferred` for a class whose terminal outcome is that and which concludes with no reason (MAMEKO-ADM-040,
   * MAMEKO-ADM-042), or the reason of a `cancelled` conclusion (MAMEKO-ADM-063). Null when admission did not conclude it.
   */
  readonly concluded: string | null;
  readonly notBefore: number | null;
}

type Concluded = Extract<AdmitAnswer, { readonly _tag: "Concluded" }>;

/** Admission's answer, where a failed workflow start after the commit still leaves the execution queued. */
type Answer = AdmitAnswer | { readonly _tag: "Queued"; readonly executionId: string };

/**
 * The execution committed queued and its workflow start failed; the admission sweep starts it (MAMEKO-ADM-030), so
 * intake answers it as queued.
 */
const queuedUnstarted = (e: ExecutionStartFailed) =>
  Effect.as(
    Effect.logWarning(
      "execution workflow start failed after admission; the admission sweep starts it",
      {
        executionId: e.executionId,
        cause: e.cause,
      },
    ),
    { _tag: "Queued", executionId: e.executionId } as const,
  );

const concludedReason = (c: Concluded): string =>
  Match.value(c.outcome).pipe(
    Match.when("failure", () => c.reason ?? "failure"),
    Match.when("expired", () => "expired"),
    Match.when("deferred", () => "deferred"),
    Match.when("cancelled", () => c.reason ?? "cancelled"),
    Match.exhaustive,
  );

/** Records a request rejected before admission (MAMEKO-ADM-090). */
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
 * The executor kinds the profile's placement allows a request, with the constraints that held: its class, the labels
 * class resolution returned with the run's capability labels and any recorded placement constraint, and the
 * constraints the run declares for these inputs, so a `cloud-pinned` run never reaches a device (FD-GATE-061,
 * FD-GATE-080).
 */
const placementRequest = (
  s: Submission,
  className: string,
  labels: readonly string[],
  confidentiality?: ConfidentialityMode,
): PlacementRequest => {
  const declared = s.run.placement?.(s.inputs) ?? { constraints: [], labels: [] };
  const tagPush = s.cacheTrigger._tag === "Push" && s.cacheTrigger.ref.startsWith("refs/tags/");
  return {
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
    ...(confidentiality === undefined ? {} : { confidentiality }),
  };
};

/** The facts and constraint parameters admission's placement binding answers for the request (MAMEKO-ADM-088). */
const admissionPlacement = (
  profile: Profile,
  s: Submission,
  className: string,
  labels: readonly string[],
  confidentiality: ConfidentialityMode,
): IntakeAdmitInput["placement"] => {
  const { facts, params } = placementInputs(
    profile,
    placementRequest(s, className, labels, confidentiality),
  );
  return {
    facts: {
      runLabels: facts.runLabels,
      confidentiality: facts.confidentiality,
      cloudPinned: facts.cloudPinned,
      cloudOnly: facts.cloudOnly,
      localOnly: facts.localOnly,
      needsLocalModel: facts.needsLocalModel,
    },
    params,
  };
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

    // The lease carries the recorded inputs to an executor, so inputs holding a write credential are refused here,
    // before any record, execution or placement row exists (FD-AGT-008).
    const credentialField = config.writeCredentialIn(s.inputs);
    if (credentialField !== null) {
      const field =
        credentialField === "" || credentialField.startsWith("[")
          ? `inputs${credentialField}`
          : `inputs.${credentialField}`;
      yield* shed(s.repo, s.run.name, `credential in payload: ${field}`);
      return yield* Effect.fail(
        intakeError(
          400,
          "invalid_inputs",
          `CredentialInPayload: ${field} holds a write credential`,
        ),
      );
    }

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
    yield* boundsOf(config.profile, className);
    const key = yield* requestKey({ ...s, run: s.run.name });
    const cooldown = yield* cooldownWait(s, now);
    const id = newExecutionId(now, Math.random);

    // A fork pull request's input stays untrusted on every attempt, re-runs included (FD-PROF-018).
    const untrusted = s.trigger === "fork-pr" ? ["untrusted-input"] : [];
    const labels = [...new Set([...resolved.labels, ...s.extraLabels, ...untrusted])];
    const notBefore = cooldown?.notBefore ?? null;
    const confidentiality = config.confidentiality(s.repo);
    const record: IntakeRecord = {
      executionId: id,
      trigger: s.trigger,
      run: s.run.name,
      label: s.label,
      repo: s.repo,
      sha: s.sha,
      ref: s.ref,
      inputs: s.inputs,
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
      // Admission decides the kinds; `placed` copies them from its placement row once it answers.
      eligibleKinds: null,
      createdAt: now,
    };
    // mameko's `admit` writes the execution, dedup key and placement rows under this id in one transaction, with the
    // eligible kinds, the constraints, the isolation and the deadline it derives from the class and these facts
    // (MAMEKO-ADM-023, MAMEKO-ADM-104, MAMEKO-LEASE-083).
    const admitInput: IntakeAdmitInput = {
      executionId: id,
      scopeId: s.repo,
      run: s.run.name,
      className,
      labels,
      enqueuedAtMs: now,
      dedup: {
        sha256: key.sha256,
        canonical: key.canonical,
        requestDigest: key.requestDigest,
        digestBody: key.requestDigest === null ? null : (s.idempotency?.body ?? null),
        onMismatch: key.onMismatch,
      },
      placement: admissionPlacement(config.profile, s, className, labels, confidentiality),
      maxDurationSec: s.run.maxDurationSec,
      grants: s.run.grants ?? { setup: [], agent: [] },
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

    // The record goes in first, so a device that claims the moment admission commits finds the inputs.
    yield* store.put(record);
    const admitted: Answer = yield* admission.admit(admitInput).pipe(
      Effect.catchTags({
        IntakeUnavailable: () =>
          Effect.andThen(
            store.drop(id),
            Effect.fail(
              intakeError(503, "intake_unavailable", "admission failed; nothing was written"),
            ),
          ),
        ExecutionStartFailed: queuedUnstarted,
      }),
    );
    return yield* Match.value(admitted).pipe(
      Match.tag("Queued", ({ executionId }) =>
        Effect.gen(function* () {
          yield* store.placed(executionId);
          if (cooldown !== null) yield* store.armCooldown(cooldown.bucket, executionId, now);
          yield* admission.queued(className);
          return { executionId, className, duplicate: false, concluded: null, notBefore: null };
        }),
      ),
      Match.tag("Concluded", (c) =>
        Effect.as(store.placed(c.executionId), {
          executionId: c.executionId,
          className,
          duplicate: false,
          concluded: concludedReason(c),
          notBefore: null,
        } satisfies Admitted),
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
 * from now; a request admission answers as a duplicate of another execution, or as a conflict, loses its record, as at
 * submit. A duplicate of the request's own id is a release whose admission committed before an earlier pass ended: it
 * is admitted when that admission wrote a placement row, and concluded, arming no window, when it did not.
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
      const result: Answer | null = yield* admission
        .admit({ ...held.admit, enqueuedAtMs: now })
        .pipe(
          Effect.catchTags({
            IntakeUnavailable: () => Effect.succeed(null),
            ExecutionStartFailed: queuedUnstarted,
          }),
        );
      if (result === null) {
        unavailable++;
        continue;
      }
      // The placement row tells a queued execution from one admission concluded, whichever pass admitted it.
      const answered = Effect.gen(function* () {
        yield* store.release(id);
        if (!(yield* store.placed(id))) {
          concluded++;
          return;
        }
        yield* store.armCooldown(held.cooldownBucket, id, now);
        yield* admission.queued(held.admit.className);
        admitted++;
      });
      yield* Match.value(result).pipe(
        Match.tag("Queued", () => answered),
        Match.tag("Concluded", () => answered),
        Match.tag("Duplicate", ({ executionId }) =>
          executionId === id
            ? answered
            : Effect.gen(function* () {
                yield* store.release(id);
                yield* store.drop(id);
                duplicate++;
              }),
        ),
        Match.tag("Conflict", () =>
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
