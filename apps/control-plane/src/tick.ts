// The minute tick's composition: the operability package's tick with the GitHub applier draining the outbox, the
// admission of held requests, and intake's sweep and schedule units for every installation of the App.
import { GithubApp } from "@fractalboxdev/flare-dispatch-github";
import { planTick, releaseHeld, runTickUnit } from "@fractalboxdev/flare-dispatch-intake";
import { tickDepsFromEnv, type TickDeps, type TickStep } from "@fractalboxdev/flare-dispatch-ops";
import type { ActuatorRateLimit, Actuators } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { isolateServices } from "./composition.ts";
import { profileOf, type ControlPlaneEnv } from "./config.ts";
import { appOptionsOf } from "./github.ts";

/**
 * One pass of every installation's units for the minute. A unit that stops at its subrequest budget reports that it
 * continues; its continuation waits for the next pass, since no Queue carries it.
 */
export const intakeUnits = (now: number) =>
  Effect.gen(function* () {
    const installations = yield* (yield* GithubApp).installations;
    const report = [];
    for (const unit of planTick(now, installations)) {
      const result = yield* runTickUnit(unit);
      report.push({
        unit: unit._tag,
        installation: unit.installation,
        executions: result.outcome.executions.length,
        continues: result.next !== null,
        skipped: result.skipped,
      });
    }
    return report;
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
              effect: intakeUnits(now).pipe(Effect.provide(services as never)) as Effect.Effect<
                unknown,
                unknown
              >,
            },
          ]
        : []),
      ...steps(now),
    ],
  });
};
