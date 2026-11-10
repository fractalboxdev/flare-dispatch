// The services one isolate builds once and every request and tick reads: the GitHub services, intake's Layers and the
// application ports mameko's validation counts (MAMEKO-HOST-046). A cache or token held here outlives one request.
import { catalogRuns } from "@fractalboxdev/flare-dispatch-intake";
import {
  d1Admission,
  d1IntakeStore,
  d1ShedRecorder,
  ExecutionCanceller,
  InstallationEviction,
  IntakeConfig,
  intakeLayer,
  ManifestReporter,
  manifestSourceLayer,
  oidcVerifierLayer,
  profileClassResolver,
  protectionSnapshotsLayer,
  type AdmissionPorts,
  type IntakeSettings,
} from "@fractalboxdev/flare-dispatch-intake";
import { alarmPortFromEnv } from "@fractalboxdev/flare-dispatch-ops";
import {
  ConfigurationSourceLive,
  GateDecisionSourceLive,
} from "@fractalboxdev/flare-dispatch-profile";
import type { ExecutionPayload } from "@fractalboxdev/mameko-coordinator";
import { wakeStandingClaims } from "@fractalboxdev/mameko-host-cloudflare";
import { Context, Effect, Layer, Scope } from "effect";
import { deployment, profileOf, type ControlPlaneEnv } from "./config.ts";
import { devRepositoryOf } from "./dev-repository.ts";
import {
  gitData,
  gitDataWithoutApp,
  localPorts,
  writebackApplier,
  writebackRecordsDeferred,
} from "./agentic.ts";
import { appLoginOf, appOptionsOf, appServices, boundFetch, readsWithoutApp } from "./github.ts";

const listOf = (value: unknown): readonly string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/** Intake's configuration from the bindings; every repository may run every run its manifest lists. */
export const intakeSettings = (env: ControlPlaneEnv): IntakeSettings => {
  const raw = env as unknown as Readonly<Record<string, unknown>>;
  const events = listOf(raw["WEBHOOK_EVENTS"]);
  const dev = devRepositoryOf(env);
  return {
    catalog: catalogRuns(deployment(env)),
    profile: profileOf(env),
    appId: Number(env.GITHUB_APP_ID ?? 0),
    webhookSecret: env.WEBHOOK_SECRET === "" ? undefined : env.WEBHOOK_SECRET,
    webhookEvents: events.length === 0 ? undefined : events,
    oidcAudience: env.DISPATCH_OIDC_AUDIENCE === "" ? undefined : env.DISPATCH_OIDC_AUDIENCE,
    dispatchers: listOf(raw["DISPATCHERS"]).map((d) => d.trim().toLowerCase()),
    allows: () => true,
    // No policy rule classifies a repository yet; a development deployment's captured repository carries its own mode.
    confidentiality: (repo) =>
      (dev !== undefined && dev.repository === repo ? dev.confidentiality : undefined) ??
      "unclassified",
  };
};

/** A queued admission wakes the standing claims of the class's device executors (MAMEKO-ARCH-037). */
const wake = (env: ControlPlaneEnv) => (className: string) =>
  Effect.promise(() =>
    wakeStandingClaims(env.DB, env.CHANNEL, { className, eligibleKinds: ["device"] }),
  );

/**
 * What admission needs of the Worker: the wake-up after a queued admission, the `ExecutionEngine` start of an admitted
 * execution whose class does not defer its workflow (MAMEKO-ADM-030), and the alarm sink.
 */
const admissionPorts = (env: ControlPlaneEnv, alarms: AdmissionPorts["alarms"]) => ({
  queued: wake(env),
  startExecution: (payload: ExecutionPayload) =>
    Effect.promise(() =>
      env.EXECUTION.get(env.EXECUTION.idFromName(payload.executionId)).start(payload),
    ),
  alarms,
});

/**
 * mameko offers no cancel of an admitted execution, so a superseded merge group's execution runs to its end; the cancel
 * is a logged no-op, and nothing downstream decides on it.
 */
const cancellerDeferred = Layer.succeed(ExecutionCanceller, {
  cancel: (executionId, cause) =>
    Effect.logWarning("execution cancel needs mameko's cancel of an admitted execution", {
      executionId,
      cause,
    }),
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

/** Without the App no installation state is cached, so there is nothing to evict. */
const evictionWithoutApp = Layer.succeed(InstallationEviction, {
  installation: () => Effect.void,
  repositories: () => Effect.void,
});

const isolateLayer = (env: ControlPlaneEnv) => {
  const settings = intakeSettings(env);
  const alarms = alarmPortFromEnv(env);
  const app = appOptionsOf(env);
  const common = Layer.mergeAll(
    cancellerDeferred,
    alarms,
    ConfigurationSourceLive,
    GateDecisionSourceLive,
  );
  if (app !== undefined) {
    const github = appServices(env, app, alarms);
    // The agentic appliers for `pr.propose` and `pr.close` over the GitHub package's applier; it wins the tag.
    const support = Layer.mergeAll(gitData, writebackRecordsDeferred).pipe(
      Layer.provideMerge(github),
    );
    const applier = writebackApplier(appLoginOf(env)).pipe(Layer.provideMerge(support));
    return Layer.mergeAll(
      profileClassResolver.pipe(
        Layer.provideMerge(
          intakeLayer({ db: env.DB, settings, fetch: boundFetch, ...admissionPorts(env, alarms) }),
        ),
      ),
      localPorts(env),
    ).pipe(Layer.provideMerge(applier), Layer.provideMerge(common));
  }
  return Layer.mergeAll(
    Layer.succeed(IntakeConfig, settings),
    d1Admission(env.DB, settings.profile, admissionPorts(env, alarms)),
    d1IntakeStore(env.DB),
    d1ShedRecorder(env.DB),
    manifestSourceLayer,
    manifestReporterWithoutApp,
    evictionWithoutApp,
    oidcVerifierLayer(boundFetch),
    profileClassResolver.pipe(
      Layer.provideMerge(protectionSnapshotsLayer),
      Layer.provide(Layer.succeed(IntakeConfig, settings)),
    ),
    localPorts(env),
  ).pipe(
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
