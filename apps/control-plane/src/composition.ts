// The services one isolate builds once and every request and tick reads: the GitHub services, intake's Layers and the
// application ports mameko's validation counts (MAMEKO-HOST-046). A cache or token held here outlives one request.
import {
  CacheClock,
  isReproduction,
  ObjectStorePresignerLive,
  R2Presigner,
  R2PresignerLive,
  reproductionGuardedActuators,
} from "@fractalboxdev/flare-dispatch-cache";
import { FollowOnSubmitter } from "@fractalboxdev/flare-dispatch-github";
import { catalogRuns, followOnSubmitterLayer } from "@fractalboxdev/flare-dispatch-intake";
import {
  d1Admission,
  d1IntakeStore,
  d1ShedRecorder,
  ExecutionStartFailed,
  HeldCheckReporter,
  InstallationEviction,
  IntakeConfig,
  intakeLayer,
  IntakeStore,
  ManifestReporter,
  manifestSourceLayer,
  profileClassResolver,
  protectionSnapshotsLayer,
  type AdmissionPorts,
  type IntakeSettings,
} from "@fractalboxdev/flare-dispatch-intake";
import { alarmPortFromEnv, recordDeliveryTime } from "@fractalboxdev/flare-dispatch-ops";
import {
  type Actuator,
  Actuators,
  actuatorRegistry,
  ObjectStorePresigner,
} from "@fractalboxdev/mameko-ports";
import { GateDecisionSourceLive, repositoryRules } from "@fractalboxdev/flare-dispatch-profile";
import type { ExecutionPayload } from "@fractalboxdev/mameko-coordinator";
import { wakeStandingClaims } from "@fractalboxdev/mameko-host-cloudflare";
import { d1Sql } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { cancelledLease } from "@fractalboxdev/mameko-store-sqlite";
import { Context, Effect, Layer, Scope } from "effect";
import {
  configurationSourceOf,
  deployment,
  presignerConfigOf,
  presignerMissingOf,
  profileOf,
  type ControlPlaneEnv,
} from "./config.ts";
import { repositoryConfidentiality } from "./dev-repository.ts";
import { policyRulesOf } from "./policy.ts";
import { resultAcceptanceLayer } from "./provenance-records.ts";
import {
  gitData,
  gitDataWithoutApp,
  localPorts,
  writebackApplier,
  writebackRecords,
  writeCredentialIn,
} from "./agentic.ts";
import { appLoginOf, appOptionsOf, appServices, botLoginOf, readsWithoutApp } from "./github.ts";

/**
 * The rendered `{{intake.webhookEvents}}`: `null` or unset admits every supported event, and a list admits only its
 * events, so an empty list admits none (FD-INT-027). Wrangler delivers a JSON var as its value, a `.dev.vars` entry as
 * its JSON text. A value that is neither admits none, so a malformed var never widens what intake admits.
 */
export const webhookEventsOf = (value: unknown): readonly string[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  if (value.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed === null ? undefined : Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/**
 * Each repository's synced policy rules, the `policy-rules` input of class resolution (FD-PROF-025), its name matched
 * in any letter case.
 */
const policyRulesFor = (env: ControlPlaneEnv) => {
  const rules = policyRulesOf(env);
  return (repo: string) => repositoryRules(rules, repo);
};

/** Intake's configuration from the bindings; every repository may run every run its manifest lists. */
export const intakeSettings = (env: ControlPlaneEnv): IntakeSettings => {
  const raw = env as unknown as Readonly<Record<string, unknown>>;
  const events = webhookEventsOf(raw["WEBHOOK_EVENTS"]);
  return {
    catalog: catalogRuns(deployment(env)),
    profile: profileOf(env),
    appId: Number(env.GITHUB_APP_ID ?? 0),
    appLogin: appLoginOf(env),
    webhookSecret: env.WEBHOOK_SECRET === "" ? undefined : env.WEBHOOK_SECRET,
    webhookEvents: events,
    allows: () => true,
    confidentiality: repositoryConfidentiality(env),
    policyRules: policyRulesFor(env),
    writeCredentialIn: writeCredentialIn(env),
  };
};

/**
 * A queued admission wakes the standing claims of the class's device executors (MAMEKO-ARCH-037). The execution is
 * already admitted, so a wake that fails, such as a grant the channel refuses, is logged and the request still answers
 * with the execution it admitted.
 */
const wake = (env: ControlPlaneEnv) => (className: string) =>
  Effect.tryPromise(() =>
    wakeStandingClaims(env.DB, env.CHANNEL, { className, eligibleKinds: ["device"] }),
  ).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logWarning("standing claim wake failed after admission", { className, cause }),
    ),
  );

/**
 * The `ExecutionEngine` start of an admitted execution whose class does not defer its workflow (MAMEKO-ADM-029). A
 * rejected start is `ExecutionStartFailed`: the execution stays queued, and the admission sweep starts it.
 */
export const startExecutionOf =
  (env: Pick<ControlPlaneEnv, "EXECUTION">) =>
  (payload: ExecutionPayload): Effect.Effect<void, ExecutionStartFailed> =>
    Effect.tryPromise({
      try: () => env.EXECUTION.get(env.EXECUTION.idFromName(payload.executionId)).start(payload),
      catch: (cause) =>
        new ExecutionStartFailed({
          executionId: payload.executionId,
          className: payload.className,
          cause: String(cause),
        }),
    }).pipe(Effect.asVoid);

/**
 * The cancel of an execution a supersession, a group cancel or a per-execution cancel recorded `cancelled`: its
 * `ExecutionEngine` records the cancel, which ends its wait for a lease or a result (MAMEKO-ADM-064), and a leased
 * execution's executor gets `exec.cancel` over its channel (MAMEKO-ADM-068).
 */
export const cancelExecutionOf =
  (env: Pick<ControlPlaneEnv, "DB" | "EXECUTION" | "CHANNEL">) =>
  (executionId: string, cause: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        env.EXECUTION.get(env.EXECUTION.idFromName(executionId)).cancel(executionId, cause),
      );
      const lease = yield* cancelledLease(executionId, cause).pipe(
        Effect.provide(d1Sql(env.DB)),
        Effect.orDie,
      );
      if (lease !== null)
        yield* Effect.promise(() =>
          env.CHANNEL.get(env.CHANNEL.idFromName(lease.executorId)).cancelLease(lease.frame),
        );
    });

/**
 * What admission needs of the Worker: the wake-up after a queued admission, the workflow start, the cancel of a
 * superseded or cancelled execution's workflow and lease, and the alarm sink.
 */
const admissionPorts = (env: ControlPlaneEnv, alarms: AdmissionPorts["alarms"]) => ({
  queued: wake(env),
  startExecution: startExecutionOf(env),
  cancelExecution: cancelExecutionOf(env),
  alarms,
});

/** Without the App no check run can be written; the shed row already records the invalid manifest (FD-INT-018). */
const manifestReporterWithoutApp = Layer.succeed(ManifestReporter, {
  invalid: (repo, sha, errors) =>
    Effect.logWarning("manifest check run not written: no GitHub App", {
      repo,
      sha,
      errors: errors.length,
    }),
});

/**
 * Without the App no check run can be written; the held request's record and hold already show it waits for its
 * cooldown window (FD-INT-057).
 */
const heldCheckReporterWithoutApp = Layer.succeed(HeldCheckReporter, {
  queued: (check) =>
    Effect.logWarning("held check run not posted: no GitHub App", {
      executionId: check.executionId,
    }),
  dropped: () => Effect.void,
});

/** Without the App no installation state is cached, so there is nothing to evict. */
const evictionWithoutApp = Layer.succeed(InstallationEviction, {
  installation: () => Effect.void,
  repositories: () => Effect.void,
});

/**
 * The drainer's actuators with intake's follow-on submitter in reach: a `dispatch.followOn` row's applier submits its
 * request to admission, keyed `<execution_id>/<intent_key>`, so a repeated apply starts no second execution
 * (FD-GH-088). The submitter reads intake's services, which the GitHub services underneath build first.
 */
export const followOnActuators = Layer.effect(
  Actuators,
  Effect.gen(function* () {
    const base = yield* Actuators;
    const submitter = yield* FollowOnSubmitter;
    const provide = Effect.provideService(FollowOnSubmitter, submitter);
    const wrap = ({ apply, lookup, reconcile }: Actuator): Actuator => ({
      apply: (row) => provide(apply(row)),
      ...(lookup === undefined ? {} : { lookup: (row) => provide(lookup(row)) }),
      ...(reconcile === undefined ? {} : { reconcile: (row) => provide(reconcile(row)) }),
    });
    return actuatorRegistry(
      Object.fromEntries(base.names().map((name) => [name, wrap(base.get(name)!)])),
    );
  }),
).pipe(Layer.provide(followOnSubmitterLayer));

/**
 * The actuators with every outbox row of a reproduction execution refused: the control plane applies no intent of it
 * other than its statement's log append, which is no outbox row (FD-PROV-065). Intake's record names a reproduction by
 * its `reproduction` placement constraint.
 */
export const reproductionGuard = Layer.effect(
  Actuators,
  Effect.gen(function* () {
    const base = yield* Actuators;
    const store = yield* IntakeStore;
    return reproductionGuardedActuators(base, (executionId) =>
      store
        .get(executionId)
        .pipe(
          Effect.map(
            (record) =>
              record !== null &&
              isReproduction(
                record.placementConstraint === null ? [] : [record.placementConstraint],
              ),
          ),
        ),
    );
  }),
);

/**
 * Intake's record of a verified webhook delivery reaches the operability record of a registered installation too,
 * which the canary's stage read and `webhook-silent` take (FD-INT-031, FD-OPS-040). A write that fails is logged, and
 * the webhook still answers.
 */
export const withDeliveryTimes = (env: Pick<ControlPlaneEnv, "DB">) =>
  Layer.effect(
    IntakeStore,
    Effect.gen(function* () {
      const store = yield* IntakeStore;
      return {
        ...store,
        recordDelivery: (installation: number, at: number) =>
          store.recordDelivery(installation, at).pipe(
            Effect.andThen(
              Effect.tryPromise(() => recordDeliveryTime(env.DB, String(installation), at)).pipe(
                Effect.asVoid,
                Effect.catch((cause) =>
                  Effect.logWarning("delivery time not recorded on the installation", {
                    installation,
                    cause: String(cause),
                  }),
                ),
              ),
            ),
          ),
      };
    }),
  );

/**
 * The presigner on a deploy missing the presign token, the account id or the bucket name: it signs no URL. `suppliedPorts`
 * leaves `object-store-presigner` out for such a deploy, and nothing in phase 0 presigns yet, so a presign that reaches
 * this Layer dies naming the values the deploy leaves unset.
 */
const presignerUnconfigured = (missing: ReadonlyArray<string>) => {
  const refuse = () =>
    Effect.die(
      `object-store presigner: this deploy leaves ${missing.join(", ")} unset, so it signs no URL`,
    );
  return Layer.mergeAll(
    Layer.succeed(R2Presigner, { presign: refuse }),
    Layer.succeed(ObjectStorePresigner, { presign: refuse }),
  );
};

/**
 * The object-store presigner (MAMEKO-HOST-051): the cache package's signer over the presign token, on the bucket's S3
 * endpoint `<account_id>.r2.cloudflarestorage.com` and never a custom domain (FD-CACHE-091).
 */
export const presignerLayer = (env: ControlPlaneEnv) => {
  const config = presignerConfigOf(env);
  if (config === undefined) return presignerUnconfigured(presignerMissingOf(env));
  return ObjectStorePresignerLive.pipe(
    Layer.provideMerge(R2PresignerLive(config)),
    Layer.provide(Layer.succeed(CacheClock, { now: () => Date.now() })),
  );
};

/**
 * The isolate's services: intake's and the GitHub services, the presigner, and the result-acceptance check over the
 * D1 statement records, which raises its quarantine alarm through the services' alarm port (MAMEKO-LEASE-093).
 */
const isolateLayer = (env: ControlPlaneEnv) =>
  Layer.merge(
    resultAcceptanceLayer(env).pipe(
      Layer.provideMerge(withDeliveryTimes(env).pipe(Layer.provideMerge(servicesLayer(env)))),
    ),
    presignerLayer(env),
  );

const servicesLayer = (env: ControlPlaneEnv) => {
  const settings = intakeSettings(env);
  const alarms = alarmPortFromEnv(env);
  const app = appOptionsOf(env);
  const common = Layer.mergeAll(alarms, configurationSourceOf(env), GateDecisionSourceLive);
  if (app !== undefined) {
    const github = appServices(env, app, alarms);
    // The agentic appliers for `pr.propose` and `pr.close` over the GitHub package's applier; it wins the tag.
    const support = Layer.mergeAll(gitData, writebackRecords(env)).pipe(Layer.provideMerge(github));
    const applier = writebackApplier(botLoginOf(app)).pipe(Layer.provideMerge(support));
    // The local registration port submits through intake, so it sits over intake's services.
    const services = localPorts(env).pipe(
      Layer.provideMerge(
        profileClassResolver.pipe(
          Layer.provideMerge(intakeLayer({ db: env.DB, settings, ...admissionPorts(env, alarms) })),
        ),
      ),
      Layer.provideMerge(applier),
      Layer.provideMerge(common),
    );
    // The follow-on wrapper wins the `Actuators` tag over the agentic appliers underneath, and the reproduction guard
    // wins it over both.
    return reproductionGuard.pipe(
      Layer.provideMerge(followOnActuators.pipe(Layer.provideMerge(services))),
    );
  }
  const intake = Layer.mergeAll(
    Layer.succeed(IntakeConfig, settings),
    d1Admission(env.DB, settings.profile, admissionPorts(env, alarms)),
    d1IntakeStore(env.DB),
    d1ShedRecorder(env.DB),
    manifestSourceLayer,
    manifestReporterWithoutApp,
    heldCheckReporterWithoutApp,
    evictionWithoutApp,
    profileClassResolver.pipe(
      Layer.provideMerge(protectionSnapshotsLayer),
      Layer.provide(Layer.succeed(IntakeConfig, settings)),
    ),
  );
  return localPorts(env).pipe(
    Layer.provideMerge(intake),
    Layer.provideMerge(Layer.merge(readsWithoutApp(env), gitDataWithoutApp)),
    Layer.provideMerge(common),
  );
};

export type IsolateServices = Layer.Success<ReturnType<typeof isolateLayer>>;

const built = new WeakMap<object, Promise<Context.Context<IsolateServices>>>();

/** The isolate's services, built on first use for this binding set and kept for the isolate's lifetime. */
export const isolateServices = (
  env: ControlPlaneEnv,
): Promise<Context.Context<IsolateServices>> => {
  let services = built.get(env);
  if (services === undefined) {
    services = Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        return yield* Layer.buildWithScope(isolateLayer(env), scope);
      }),
    ) as Promise<Context.Context<IsolateServices>>;
    services.catch(() => built.delete(env));
    built.set(env, services);
  }
  return services;
};
