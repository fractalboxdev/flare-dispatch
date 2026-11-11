// The minute tick's composition: the operability package's tick with the GitHub applier draining the outbox, the
// admission of held requests, the enqueue of intake's sweep and schedule units for every installation of the App, and
// the conclusions of ended fan-out parents' children.
import { GithubApp, insertChildConclusions } from "@fractalboxdev/flare-dispatch-github";
import { planTick, releaseHeld } from "@fractalboxdev/flare-dispatch-intake";
import { tickDepsFromEnv, type TickDeps, type TickStep } from "@fractalboxdev/flare-dispatch-ops";
import {
  startStaleExecutions,
  startUnstartedExecutions,
  type ExecutionPayload,
} from "@fractalboxdev/mameko-coordinator";
import { wakeStandingClaims } from "@fractalboxdev/mameko-host-cloudflare";
import { d1ExecutionStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import type { ActuatorRateLimit, Actuators } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { isolateServices } from "./composition.ts";
import { channelConfig, concludeKindOf, profileOf, type ControlPlaneEnv } from "./config.ts";
import { appOptionsOf } from "./github.ts";

/**
 * The tick's intake step only enqueues (FD-INT-067): each installation's planned units go to its `IntakeUnits` object,
 * whose alarms run them one at a time, each continuation in an alarm of its own.
 */
export const intakeUnits = (env: Pick<ControlPlaneEnv, "INTAKE_UNITS">, now: number) =>
  Effect.gen(function* () {
    const installations = yield* (yield* GithubApp).installations;
    const report = [];
    for (const installation of installations) {
      const units = planTick(now, [installation]);
      const queue = env.INTAKE_UNITS.get(env.INTAKE_UNITS.idFromName(String(installation)));
      const added = yield* Effect.tryPromise(() => queue.enqueue(units));
      report.push({ installation, units: units.map((u) => u._tag), added });
    }
    return report;
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
 * applies (FD-GH-020). A pass reads each parent for an hour after its end; a child already given its row is
 * skipped, so a repeat inserts nothing.
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
  return tickDepsFromEnv(env as unknown as Parameters<typeof tickDepsFromEnv>[0], {
    profile: profileOf(env),
    ...(withApp
      ? { appliers: services as unknown as Layer.Layer<Actuators | ActuatorRateLimit> }
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
  });
};
