// One request to mameko's admission function (FD-INT-001). Intake writes its own
// record and, for a refusal before admission, a shed row; every `executions`,
// dedup-key and `placements` row is admission's.
import { attachesDeploymentSecret } from "@fractalboxdev/flare-dispatch-catalog";
import {
  deploymentSecretGrantLabels,
  placementInputs,
  supersessionKey,
  type ClassName,
  type ConfidentialityMode,
  type PlacementRequest,
  type Profile,
} from "@fractalboxdev/flare-dispatch-profile";
import {
  computeDataClasses,
  TriageIssuesInput,
  TriagePrsInput,
  trifectaAdmission,
  type DataClasses,
} from "@fractalboxdev/flare-dispatch-agentic";
import { executionId as newExecutionId, type AdmitAnswer } from "@fractalboxdev/mameko-coordinator";
import { Clock, Effect, Match, Schema } from "effect";
import {
  Admission,
  boundsOf,
  ClassResolver,
  IntakeConfig,
  intakeError,
  type ClassRequest,
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
import { profileRequestOf } from "./layer.ts";
import { heldCheckOf, HeldCheckReporter } from "./ports.ts";
import { checkName, type IntakeRun } from "./runs.ts";
import {
  HELD_STATUS,
  IntakeStore,
  ShedRecorder,
  type IntakeRecord,
  StoreUnavailable,
} from "./store.ts";

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
  /**
   * The constraints the run declares that `placementConstraint` supersedes: a reproduction drops a release run's
   * `cloud-pinned`, since its own constraint decides where it runs (FD-PROV-064).
   */
  readonly supersededConstraints: readonly string[];
  readonly extraLabels: readonly string[];
  /** What the cache namespaces read of the trigger (FD-CACHE-019); `Other` unless a webhook says more. */
  readonly cacheTrigger: CacheTriggerRecord;
  /** The repository's default branch, when the trigger read it. */
  readonly defaultBranch: string | null;
  /** The branch whose required set decides a gating run (specs/profile.md § Class resolution, step 2). */
  readonly targetBranch: string | null;
  /** Whether a ruleset or branch protection protects a push's ref; null when intake did not read it. */
  readonly refProtection: boolean | null;
  /** Whether the repository is public, as the trigger stated it; null when the trigger did not say. */
  readonly repositoryPublic: boolean | null;
  /** The `author_association` of every principal whose text the trigger's payload carries. */
  readonly inputAssociations: readonly string[];
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
  release: null,
  attempt: 1,
  cronMinute: null,
  local: null,
  familyRoot: null,
  forcedClass: null,
  spendLine: null,
  applyCooldown: true,
  placementConstraint: null,
  supersededConstraints: [],
  extraLabels: [],
  cacheTrigger: OTHER_CACHE_TRIGGER,
  defaultBranch: null,
  targetBranch: null,
  refProtection: null,
  repositoryPublic: null,
  inputAssociations: [],
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

/**
 * The execution's three data classes from what intake knows of the request (specs/runs/agentic.md § Data classes). A
 * repository whose visibility the trigger did not state counts as private. The `agent` egress profile holds the
 * profile's base grants and the run's own agent grants. Every intent applier writes to the execution's own repository,
 * the row's scope, so no intent targets another.
 */
type DataClassRequest = Pick<
  Submission,
  "trigger" | "repo" | "repositoryPublic" | "inputAssociations"
> & {
  readonly run: Pick<IntakeRun, "grants">;
};

export const dataClassesOf = (
  profile: Profile,
  s: DataClassRequest,
  confidentiality: ConfidentialityMode,
): DataClasses =>
  computeDataClasses({
    repositoryPublic: s.repositoryPublic === true,
    confidentiality,
    inputAssociations: s.inputAssociations,
    forkHead: s.trigger === "fork-pr",
    egressGrants: [...profile.egress_profiles.agent.grants, ...(s.run.grants?.agent ?? [])],
    intentRepositories: [s.repo],
    repository: s.repo,
  });

const dataClassRefusal = (
  profile: Profile,
  request: DataClassRequest,
  confidentiality: ConfidentialityMode,
) =>
  Match.value(trifectaAdmission(dataClassesOf(profile, request, confidentiality))).pipe(
    Match.tag("refuse", (r) => r.reason),
    Match.tag("admit", () => null),
    Match.exhaustive,
  );

/** Records a request rejected before admission (MAMEKO-ADM-091). */
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
 * constraints the run declares for these inputs but the ones `supersededConstraints` names, so a `cloud-pinned` run
 * never reaches a device (FD-GATE-061, FD-GATE-080).
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
    constraints: declared.constraints.filter((c) => !s.supersededConstraints.includes(c)),
    ...(tagPush ? { trigger: "tag-push" } : {}),
    ...(confidentiality === undefined ? {} : { confidentiality }),
  };
};

/** The facts and constraint parameters admission's placement binding answers for the request (MAMEKO-ADM-089). */
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

/**
 * The supersession group a request joins, through the profile's `supersessionKey` binding: a pull-request request of a
 * run that declares `supersede` joins `<owner>/<repo>:<pull request number>:<run>[:<label>]`, and every other request,
 * a check re-run included, joins none (FD-PROF-027, FD-PROF-029).
 */
const supersessionKeyOf = (
  s: Submission,
  request: ClassRequest,
  className: string,
): string | null =>
  supersessionKey({
    ...profileRequestOf(request, false),
    ...Match.value(s.cacheTrigger).pipe(
      Match.tag("PullRequest", (t) => ({ pullRequest: t.number })),
      Match.orElse(() => ({})),
    ),
    ...(s.label === null ? {} : { label: s.label }),
    ...(s.familyRoot === null ? {} : { rerun: { firstAttemptClass: className as ClassName } }),
  });

export const submit = (
  s: Submission,
): Effect.Effect<
  Admitted,
  IntakeError | StoreUnavailable,
  IntakeConfig | Admission | ClassResolver | IntakeStore | ShedRecorder | HeldCheckReporter
> =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const admission = yield* Admission;
    const store = yield* IntakeStore;
    const now = yield* Clock.currentTimeMillis;
    const name = checkName(s.run.name, s.label);

    // Triage reads its input repository; issue intents and staged digests are applied in this admission's scope.
    // Bind the two before any trigger can admit work based on another repository's reports or suppression key.
    if (s.run.name === "triage-issues" || s.run.name === "triage-prs") {
      const schema = s.run.name === "triage-issues" ? TriageIssuesInput : TriagePrsInput;
      const inputs = yield* Schema.decodeUnknownEffect(schema)(s.inputs).pipe(
        Effect.mapError(() => intakeError(400, "invalid_inputs", `invalid ${s.run.name} inputs`)),
      );
      if (`${inputs.repo.owner}/${inputs.repo.name}`.toLowerCase() !== s.repo.toLowerCase())
        return yield* Effect.fail(
          intakeError(
            400,
            "invalid_inputs",
            `${s.run.name} inputs.repo must match the execution repository`,
          ),
        );
    }

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

    const classRequest: ClassRequest = {
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
    };
    const resolution =
      s.forcedClass === null
        ? yield* (yield* ClassResolver).resolve(classRequest)
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
    const confidentiality = config.confidentiality(s.repo);
    // An execution whose computed classes are all true concludes `failure` with `policy: trifecta` at admission, before
    // placement (FD-AGT-005); it waits out no cooldown window.
    const refusal = dataClassRefusal(config.profile, s, confidentiality);
    const cooldown = refusal === null ? yield* cooldownWait(s, now) : null;
    const id = newExecutionId(now, Math.random);

    // A fork pull request's input stays untrusted on every attempt, re-runs included (FD-PROF-018).
    const untrusted = s.trigger === "fork-pr" ? ["untrusted-input"] : [];
    // An execution whose egress profiles hold a grant that attaches a deployment secret is never placed on `gha`
    // (FD-ISO-022).
    const deploymentSecret = deploymentSecretGrantLabels(
      config.profile,
      s.run.grants,
      attachesDeploymentSecret,
    );
    const labels = [
      ...new Set([...resolved.labels, ...s.extraLabels, ...untrusted, ...deploymentSecret]),
    ];
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
      repositoryPublic: s.repositoryPublic,
      inputAssociations: s.inputAssociations,
      createdAt: now,
    };
    // mameko's `admit` writes the execution, dedup key and placement rows under this id in one transaction, with the
    // eligible kinds, the constraints, the isolation and the deadline it derives from the class and these facts
    // (MAMEKO-ADM-023, MAMEKO-ADM-105, MAMEKO-LEASE-084).
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
      supersessionKey: supersessionKeyOf(s, classRequest, className),
      // A run that declares `serialize` names its serial group from its inputs, e.g. one `worker-deploy` target
      // (FD-GATE-063).
      serialKey: s.run.serialKey?.(s.inputs) ?? null,
      // A merge group's runs report on the group's head, which is the request's commit (FD-GH-075).
      check: s.run.ownsCheck ? { name, headSha: s.sha } : null,
      refusal,
    };

    // Inside the run's cooldown window the request is held before admission, and the minute tick admits it once the
    // window ends (FD-INT-057). Its check run shows `queued` for the window, under the id the execution is admitted
    // with. A request whose dedup key already names an execution, held or admitted, answers it and posts nothing.
    if (cooldown !== null && notBefore !== null) {
      const held = yield* store.hold(record, {
        admit: admitInput,
        cooldownBucket: cooldown.bucket,
        notBefore,
      });
      if (held._tag === "Held") {
        const check = heldCheckOf(admitInput);
        if (check !== null) yield* (yield* HeldCheckReporter).queued(check);
        return { executionId: id, className, duplicate: false, concluded: null, notBefore };
      }
      if (key.onMismatch === "conflict" && held.requestDigest !== key.requestDigest)
        return yield* Effect.fail(
          intakeError(
            409,
            "conflict",
            "the Idempotency-Key names a request with another body",
            held.executionId,
          ),
        );
      // A prior delivery may have committed the hold before its outbox insert failed. Rebuild the same cp key from
      // the authoritative held record, so redelivery repairs reporting without creating or admitting another request.
      const known = yield* store.get(held.executionId);
      const check = heldCheckOf(admitInput);
      if (known?.status === HELD_STATUS && check !== null)
        yield* (yield* HeldCheckReporter).queued({ ...check, executionId: held.executionId });
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
 * from now, and admission's `check.open` adopts the queued check run the hold posted; a request admission answers as a
 * duplicate of another execution, or as a conflict, loses its record, as at submit, and its queued check run concludes
 * `cancelled`. A duplicate of the request's own id is a release whose admission committed before an earlier pass ended:
 * it is admitted when that admission wrote a placement row, and concluded, arming no window, when it did not.
 */
export const releaseHeld = (
  limit: number = RELEASE_PER_PASS,
): Effect.Effect<
  ReleaseReport,
  StoreUnavailable,
  Admission | IntakeConfig | IntakeStore | HeldCheckReporter
> =>
  Effect.gen(function* () {
    const store = yield* IntakeStore;
    const admission = yield* Admission;
    const config = yield* IntakeConfig;
    const checks = yield* HeldCheckReporter;
    const now = yield* Clock.currentTimeMillis;
    const due = yield* store.due(now, limit);
    let admitted = 0;
    let concluded = 0;
    let duplicate = 0;
    let unavailable = 0;
    for (const held of due) {
      const id = held.admit.executionId;
      const record = yield* store.get(id);
      if (record === null)
        return yield* new StoreUnavailable({ message: `held release: no intake record ${id}` });
      // An older hold predates the refusal field. Recheck its migrated facts and the grants actually stored in the
      // held admission, so unknown legacy input cannot gain outbound authority when a cooldown ends after upgrade.
      const refusal =
        held.admit.refusal ??
        dataClassRefusal(
          config.profile,
          {
            repo: record.repo,
            trigger: record.trigger,
            repositoryPublic: record.repositoryPublic,
            inputAssociations: record.inputAssociations,
            run: { grants: held.admit.grants },
          },
          config.confidentiality(record.repo),
        );
      const result: Answer | null = yield* admission
        .admit({ ...held.admit, enqueuedAtMs: now, refusal })
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
      const dropped = (answeredBy: string) =>
        Effect.gen(function* () {
          const check = heldCheckOf(held.admit);
          if (check !== null) yield* checks.dropped(check, answeredBy);
          yield* store.release(id);
          yield* store.drop(id);
          duplicate++;
        });
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
          executionId === id ? answered : dropped(executionId),
        ),
        Match.tag("Conflict", ({ executionId }) => dropped(executionId)),
        Match.exhaustive,
      );
    }
    return { admitted, concluded, duplicate, unavailable, more: due.length === limit };
  });
