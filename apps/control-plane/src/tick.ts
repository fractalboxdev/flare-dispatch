// The minute tick's composition: the operability package's tick with the GitHub applier draining the outbox, the
// GitHub probes under the App, the admission of held requests, the enqueue of intake's sweep and schedule units for
// every installation of the App, and the conclusions of ended fan-out parents' children.
import {
  GithubApp,
  insertChildConclusions,
  listAppDeliveries,
  listAppInstallations,
  readAppInstallation,
} from "@fractalboxdev/flare-dispatch-github";
import { planTick, releaseHeld } from "@fractalboxdev/flare-dispatch-intake";
import {
  FixtureInstallationMissing,
  GithubAppReadFailed,
  GithubAppReads,
  tickDepsFromEnv,
  type ProbeConfig,
  type TickDeps,
  type TickStep,
} from "@fractalboxdev/flare-dispatch-ops";
import {
  startStaleExecutions,
  startUnstartedExecutions,
  type ExecutionPayload,
} from "@fractalboxdev/mameko-coordinator";
import { wakeStandingClaims } from "@fractalboxdev/mameko-host-cloudflare";
import { d1ExecutionStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import type { ActuatorRateLimit, Actuators } from "@fractalboxdev/mameko-ports";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { isolateServices } from "./composition.ts";
import { channelConfig, concludeKindOf, profileOf, type ControlPlaneEnv } from "./config.ts";
import { appOptionsOf } from "./github.ts";

/** Installations whose `IntakeUnits` object refused the minute's enqueue; every other installation's units are queued. */
export class IntakeEnqueueFailed extends Schema.TaggedError<IntakeEnqueueFailed>()(
  "IntakeEnqueueFailed",
  {
    failed: Schema.Array(Schema.Struct({ installation: Schema.Number, cause: Schema.String })),
    enqueued: Schema.Array(Schema.Number),
  },
) {}

/**
 * The tick's intake step only enqueues (FD-INT-067): each installation's planned units go to its `IntakeUnits` object,
 * whose alarms run them one at a time, each continuation in an alarm of its own. Every installation's enqueue is
 * attempted; the step fails after them all, naming the installations whose object refused.
 */
export const intakeUnits = (env: Pick<ControlPlaneEnv, "INTAKE_UNITS">, now: number) =>
  Effect.gen(function* () {
    const installations = yield* (yield* GithubApp).installations;
    const results = yield* Effect.forEach(
      installations,
      (installation) => {
        const units = planTick(now, [installation]);
        const queue = env.INTAKE_UNITS.get(env.INTAKE_UNITS.idFromName(String(installation)));
        return Effect.tryPromise(() => queue.enqueue(units)).pipe(
          Effect.exit,
          Effect.map((exit) => ({ installation, units: units.map((u) => u._tag), exit })),
        );
      },
      { concurrency: "unbounded" },
    );
    const failed = results.flatMap(({ installation, exit }) =>
      Exit.isFailure(exit) ? [{ installation, cause: Cause.pretty(exit.cause) }] : [],
    );
    const report = results.flatMap(({ installation, units, exit }) =>
      Exit.isSuccess(exit) ? [{ installation, units, added: exit.value }] : [],
    );
    if (failed.length > 0)
      return yield* new IntakeEnqueueFailed({
        failed,
        enqueued: report.map((r) => r.installation),
      });
    return report;
  });

/**
 * The probes' App-JWT reads over the isolate's GitHub App: the App's installations, each installation's
 * `GET /app/installations/{installation_id}` and the webhook deliveries (FD-OPS-041, FD-OPS-044). A GitHub or key
 * failure fails the read, so the probe's step fails for that tick and no answer is invented.
 */
export const githubAppReadsLayer = Layer.effect(
  GithubAppReads,
  Effect.gen(function* () {
    const app = yield* GithubApp;
    const failed = <A, E extends { readonly message: string }>(read: Effect.Effect<A, E>) =>
      read.pipe(Effect.mapError((e) => new GithubAppReadFailed({ message: e.message })));
    return {
      installations: failed(listAppInstallations(app)),
      installation: (installationId) => failed(readAppInstallation(app, installationId)),
      deliveries: (since) => failed(listAppDeliveries(app, since)),
    };
  }),
);

/**
 * The limit key of the App-JWT `delivery.redeliver` row: its own `InstallationQuota` object, apart from every
 * installation's (FD-ARCH-003, FD-OPS-045).
 */
export const APP_LIMIT_KEY = "app";

/**
 * The canary's configuration: the operator overlay's `github.fixtureRepo`, and the installation the App maps it to,
 * whose `InstallationQuota` permit the push takes (FD-OPS-038, FD-ARCH-003).
 */
export const probeConfigOf = (fixtureRepo: string, webhookSilentHours: number) =>
  Effect.gen(function* () {
    const installation = yield* (yield* GithubApp).installationFor(fixtureRepo);
    if (installation === null)
      return yield* new FixtureInstallationMissing({ repository: fixtureRepo });
    return {
      fixtureRepo,
      fixtureInstallation: String(installation),
      webhookSilentHours,
    } satisfies ProbeConfig;
  });

/**
 * mameko's two start sweeps: an execution past its `stale_at` with no engine execution (MAMEKO-ARCH-038), and an
 * admitted execution whose workflow start failed (the admission sweep). Each starts the `Execution` workflow in its
 * `ExecutionEngine` object, as admission and the executor channel do.
 */
export const startSweeps = (env: ControlPlaneEnv, now: number): readonly TickStep[] => {
  const profile = profileOf(env);
  const deferredClasses = channelConfig(profile).deferredClasses ?? [];
  const start = (payload: ExecutionPayload) =>
    Effect.promise(() =>
      env.EXECUTION.get(env.EXECUTION.idFromName(payload.executionId)).start(payload),
    );
  const store = d1ExecutionStore(env.DB);
  return [
    {
      step: "stale-start",
      effect: startStaleExecutions(now, { deferredClasses, start }).pipe(Effect.provide(store)),
    },
    {
      step: "admission-sweep",
      effect: startUnstartedExecutions(now, {
        catalogue: profile.classes,
        deferredClasses,
        start,
        wake: (placement) =>
          Effect.promise(() => wakeStandingClaims(env.DB, env.CHANNEL, placement)),
      }).pipe(Effect.provide(store)),
    },
  ];
};

/**
 * Every child check run an ended fan-out parent left open gets its `check.conclude` intent, which the next tick's drain
 * applies (FD-GH-020). Each pass stages a bounded batch of the oldest unreported children, without an age cutoff;
 * a child already given its durable row is skipped, so an outage cannot discard the backlog.
 */
export const childConclusionsStep = (env: ControlPlaneEnv, now: number): TickStep => ({
  step: "child-conclusions",
  effect: insertChildConclusions(env.DB, concludeKindOf(profileOf(env)), now),
});

export const tickDeps = (
  env: ControlPlaneEnv,
  steps: (now: number) => readonly TickStep[] = () => [],
): TickDeps => {
  const services = Layer.effectContext(Effect.promise(() => isolateServices(env)));
  const withApp = appOptionsOf(env) !== undefined;
  const fixtureRepo = env.GITHUB_FIXTURE_REPO?.trim() ?? "";
  const base = tickDepsFromEnv(env as unknown as Parameters<typeof tickDepsFromEnv>[0], {
    profile: profileOf(env),
  });
  return {
    ...base,
    ...(withApp
      ? {
          appliers: services as unknown as Layer.Layer<Actuators | ActuatorRateLimit>,
          // The installation and delivery probes, every 15 min under the App JWT (FD-OPS-041, FD-OPS-044).
          githubReads: githubAppReadsLayer.pipe(
            Layer.provide(services as never),
          ) as Layer.Layer<GithubAppReads>,
          appLimitKey: APP_LIMIT_KEY,
        }
      : {}),
    ...(withApp && fixtureRepo !== ""
      ? {
          // The synthetic webhook canary and its check (FD-OPS-038, FD-OPS-040).
          probes: probeConfigOf(fixtureRepo, base.webhookSilentHours).pipe(
            Effect.provide(services as never),
          ) as Effect.Effect<ProbeConfig, unknown>,
        }
      : {}),
    units: (now) => [
      // Held requests whose cooldown window ended are admitted on every tick, whatever triggered them (FD-INT-057).
      {
        step: "intake-release",
        effect: releaseHeld().pipe(Effect.provide(services as never)) as Effect.Effect<
          unknown,
          unknown
        >,
      },
      ...(withApp
        ? [
            {
              step: "intake-units",
              effect: intakeUnits(env, now).pipe(
                Effect.provide(services as never),
              ) as Effect.Effect<unknown, unknown>,
            },
          ]
        : []),
      ...startSweeps(env, now),
      childConclusionsStep(env, now),
      ...steps(now),
    ],
  };
};
