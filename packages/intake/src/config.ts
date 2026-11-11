// What intake is configured with and the ports it calls: mameko's admission
// function, class resolution and the error every refusal becomes.
import {
  classNamed,
  type ConfidentialityMode,
  type Profile,
} from "@fractalboxdev/flare-dispatch-profile";
import {
  admit,
  type AdmitAnswer,
  type ConstraintParams,
  type ExecutionPayload,
  type RequestFacts,
  type Resolution,
} from "@fractalboxdev/mameko-coordinator";
import { d1ExecutionStore, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { AlarmPort } from "@fractalboxdev/mameko-ports";
import { Context, Effect, Layer, Schema } from "effect";
import type { Caller, RecordedTrigger } from "./event.ts";
import type { IntakeRun, RunCatalog } from "./runs.ts";

/** A refusal as the HTTP API answers it: a status and a code from the error-model table (FD-IFC-009). */
export class IntakeError extends Schema.TaggedError<IntakeError>()("IntakeError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
  /** The existing execution a `conflict` names (FD-INT-003). */
  executionId: Schema.optionalKey(Schema.String),
}) {}

export const intakeError = (status: number, code: string, message: string, executionId?: string) =>
  new IntakeError({
    status,
    code,
    message,
    ...(executionId === undefined ? {} : { executionId }),
  });

export interface IntakeSettings {
  readonly catalog: RunCatalog;
  readonly profile: Profile;
  /** The GitHub App's id; a check run of another App is foreign (FD-INT-055). */
  readonly appId: number;
  /** Unset when the deployment holds no webhook secret (FD-INT-022). */
  readonly webhookSecret: string | undefined;
  /** `intake.webhookEvents`; undefined admits every supported event (FD-INT-027). */
  readonly webhookEvents: readonly string[] | undefined;
  /** `dispatch.oidcAudience`; unset refuses every Actions token. */
  readonly oidcAudience: string | undefined;
  /** Access identities that may dispatch (FD-IFC-027). */
  readonly dispatchers: readonly string[];
  /** The operator policy: whether a repository may run a run at all (FD-INT-015). */
  readonly allows: (repo: string, run: string) => boolean;
  /**
   * A repository's confidentiality mode, which the placement's isolation reads (MAMEKO-LEASE-083). No policy rule sets
   * one yet, so a deployment answers `unclassified`, mameko's fail-closed default, for every repository it does not
   * know to be `non-confidential`.
   */
  readonly confidentiality: (repo: string) => ConfidentialityMode;
  /**
   * The path of the first field of a request's inputs that holds a write credential the control plane never sends to
   * an executor, or null when none does. A request with a hit is refused before admission (FD-AGT-008).
   */
  readonly writeCredentialIn: (inputs: unknown) => string | null;
}

export class IntakeConfig extends Context.Service<IntakeConfig, IntakeSettings>()(
  "@fractalboxdev/flare-dispatch-intake/IntakeConfig",
) {}

/**
 * One request as intake hands it to mameko's `admit`: the id intake writes its record under, the class and labels
 * intake's class resolution returned, the dedup key, the placement facts and the run's limits. It is plain data, so a
 * request held for its cooldown window is admitted later from the stored value under the same id (MAMEKO-ADM-104).
 */
export interface IntakeAdmitInput {
  readonly executionId: string;
  readonly scopeId: string;
  readonly run: string;
  readonly className: string;
  /** The labels class resolution returned; `untrusted-input` and `local-only` are the only ones (FD-PROF-018). */
  readonly labels: readonly string[];
  readonly enqueuedAtMs: number;
  readonly dedup: {
    /** The SHA-256 of `canonical`, as `dedupKey` computes it and admission stores it (MAMEKO-ADM-034). */
    readonly sha256: string;
    readonly canonical: string;
    /** The SHA-256 of the dispatch body's canonical JSON, as admission stores it beside the key (MAMEKO-ADM-093). */
    readonly requestDigest: string | null;
    /** The dispatch body the digest covers; admission hashes its canonical JSON itself, so it gets the body, not the digest. */
    readonly digestBody: unknown;
    readonly onMismatch: "duplicate" | "conflict";
  };
  /** The request's facts and constraint parameters under its class, from the profile's placement. */
  readonly placement: {
    readonly facts: Omit<RequestFacts, "labels" | "deviceLocalInput">;
    readonly params: ConstraintParams;
  };
  readonly maxDurationSec: number;
  readonly grants: { readonly setup: readonly string[]; readonly agent: readonly string[] };
}

/** Admission did not answer: the store transaction failed, and nothing was written. */
export class IntakeUnavailable extends Schema.TaggedError<IntakeUnavailable>()(
  "IntakeUnavailable",
  {
    cause: Schema.String,
  },
) {}

/**
 * The `ExecutionEngine` start that follows admission's commit failed. The execution stays queued with no recorded engine
 * start, and the admission sweep starts it (MAMEKO-ADM-030).
 */
export class ExecutionStartFailed extends Schema.TaggedError<ExecutionStartFailed>()(
  "ExecutionStartFailed",
  {
    executionId: Schema.String,
    className: Schema.String,
    cause: Schema.String,
  },
) {}

/** mameko's admission function, and what follows a queued admission. */
export class Admission extends Context.Service<
  Admission,
  {
    readonly admit: (
      input: IntakeAdmitInput,
    ) => Effect.Effect<AdmitAnswer, IntakeUnavailable | ExecutionStartFailed>;
    /** Runs after a request is queued, for the caller to wake standing claims. */
    readonly queued: (className: string) => Effect.Effect<void>;
  }
>()("@fractalboxdev/flare-dispatch-intake/Admission") {}

/** What the Worker supplies to admission beside the database. */
export interface AdmissionPorts {
  /** Wakes the standing claims of the class's device executors after a queued admission. */
  readonly queued?: (className: string) => Effect.Effect<void>;
  /** Starts an admitted execution's `Execution` workflow in its `ExecutionEngine` object (MAMEKO-ADM-029). */
  readonly startExecution?: (
    payload: ExecutionPayload,
  ) => Effect.Effect<void, ExecutionStartFailed>;
  readonly alarms?: Layer.Layer<AlarmPort>;
  /**
   * Whether an operator has quarantined the repository (MAMEKO-ADM-037). The operator operations are not served yet,
   * so no repository is quarantined while this is absent.
   */
  readonly quarantined?: (scopeId: string) => Effect.Effect<boolean>;
}

/** Without an alarm sink an admission alarm is logged and delivered nowhere; admission does not decide on delivery. */
const loggedAlarms = Layer.succeed(AlarmPort, {
  deliver: (alarm) => Effect.logWarning("admission alarm with no alarm sink", alarm),
});

/**
 * Every request goes through mameko's one admission function (MAMEKO-ADM-023). Intake has already resolved the class,
 * so the class-resolution binding answers that class and its labels. The profile declares no capability labels per
 * executor kind, so each kind is taken to advertise the request's own labels, and placement is decided by the
 * constraint fold alone, as `eligibleKinds` decides it.
 */
export const d1Admission = (db: D1Like, profile: Profile, ports: AdmissionPorts = {}) =>
  Layer.succeed(Admission, {
    queued: ports.queued ?? (() => Effect.void),
    admit: (input) =>
      Effect.gen(function* () {
        const quarantined =
          ports.quarantined === undefined ? false : yield* ports.quarantined(input.scopeId);
        const cls = classNamed(profile, input.className);
        const bounds =
          cls?.bounds === undefined
            ? { global: 0, perScope: 0 }
            : {
                global: cls.bounds.global,
                perScope:
                  "per_scope" in cls.bounds ? cls.bounds.per_scope : cls.bounds.per_run_scope,
              };
        const runLabels = input.placement.facts.runLabels;
        return yield* admit<IntakeAdmitInput>({
          request: input,
          executionId: input.executionId,
          scopeId: input.scopeId,
          run: input.run,
          now: input.enqueuedAtMs,
          random: Math.random,
          quarantined,
          inputs: {},
          resolution: {
            binding: (r) => ({ class: r.className, labels: r.labels, alarm: null }),
            catalogue: profile.classes as never,
            allowedLabels: input.labels,
          },
          parent: null,
          recipes: [
            {
              name: "intake",
              run: (r) => r.dedup.canonical,
              ...(input.dedup.requestDigest === null
                ? {}
                : { digest: (r: IntakeAdmitInput) => r.dedup.digestBody }),
              onMismatch: input.dedup.onMismatch,
            },
          ],
          placement: () => input.placement,
          pools: profile.pools.map((pool) => ({
            name: pool.name,
            classes: pool.classes.filter((c) => c.max > 0).map((c) => c.class),
            ...(pool.reserved_for === undefined ? {} : { reserved_for: pool.reserved_for }),
          })),
          advertised: Object.fromEntries(
            input.placement.params.kinds.map((kind) => [kind, runLabels]),
          ),
          limits: { maxDurationSec: input.maxDurationSec },
          schedule: null,
          defaults: { queueAgeSec: 3_600, bounds },
          estimatedCostMicroUsd: 0,
          outcomeIntent: null,
          // mameko's start port is infallible: a failed start ends admission after its commit and before it records the
          // engine start, and comes back out below as the typed failure.
          startExecution:
            ports.startExecution === undefined
              ? () => Effect.void
              : (payload) => Effect.orDie(ports.startExecution!(payload)),
          grants: input.grants,
        }).pipe(
          Effect.provide(Layer.merge(d1ExecutionStore(db), ports.alarms ?? loggedAlarms)),
          Effect.catch((cause) =>
            Effect.fail(new IntakeUnavailable({ cause: String(cause._tag ?? cause) })),
          ),
          Effect.catchDefect((defect) =>
            defect instanceof ExecutionStartFailed ? Effect.fail(defect) : Effect.die(defect),
          ),
        );
      }),
  });

/** The request class resolution sees (specs/profile.md § Class resolution). */
export interface ClassRequest {
  readonly run: IntakeRun;
  readonly trigger: RecordedTrigger;
  /** The webhook event name, or null for another trigger kind. */
  readonly event: string | null;
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
  /** The repository's default branch, when the trigger read it. */
  readonly defaultBranch: string | null;
  /**
   * The branch whose required set decides a gating run: a pull request's or a merge group's base, or the base of a
   * `gh-readonly-queue/*` push; null for every other trigger.
   */
  readonly targetBranch: string | null;
  /** Whether a ruleset or branch protection protects a push's ref; null when intake did not read it. */
  readonly refProtection: boolean | null;
  readonly checkName: string;
  /** A dispatch's or an MCP call's `class` input (FD-IFC-033). */
  readonly classInput: string | null;
  readonly caller: Caller | null;
}

/** The `resolveClass` binding, with its declared inputs already gathered. */
export class ClassResolver extends Context.Service<
  ClassResolver,
  { readonly resolve: (request: ClassRequest) => Effect.Effect<Resolution> }
>()("@fractalboxdev/flare-dispatch-intake/ClassResolver") {}

/** The class bounds admission enforces, from the profile's class entry. */
export const boundsOf = (profile: Profile, className: string) => {
  const bounds = classNamed(profile, className)?.bounds;
  if (bounds === undefined)
    return Effect.fail(intakeError(503, "misconfigured", `class ${className} declares no bounds`));
  return Effect.succeed({
    global: bounds.global,
    perScope: "per_scope" in bounds ? bounds.per_scope : bounds.per_run_scope,
  });
};
