// The one-line mounts for the control plane Worker: the alarm port Layer from the Worker's env, and the minute tick's
// dependencies from the env and the profile.
//
//   config.ts:  const alarms = alarmPortFromEnv(env);
//   worker.ts:  scheduled: scheduledHandler((env) => tickDepsFromEnv(env, { profile: profileOf(env) })),
//               const ops = await opsFetch(request, env, { classes: CLASS_ORDER }); if (ops !== null) return ops;
import type { Profile } from "@fractalboxdev/flare-dispatch-profile";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { AlarmDeliveryFailed, AlarmPort } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { alarmPortLayer, type EmailSender } from "./alarms.ts";
import { opsConfigFrom, webhookSilentHours } from "./config.ts";
import type { TickDeps } from "./tick.ts";

/** The bindings the alarm port reads: the D1 database, the `alerts.sink` var and an optional email sender. */
export interface AlarmEnv {
  readonly DB: D1Like;
  readonly ALERT_SINK?: string;
  readonly ALERT_EMAIL?: EmailSender;
}

/**
 * The alarm port over the Worker's env. A deploy always carries a sink (FD-OPS-056); an env without one, a local run
 * included, fails each delivery with `AlarmDeliveryFailed`, so the coordinator keeps the alarm active.
 */
export const alarmPortFromEnv = (env: AlarmEnv): Layer.Layer<AlarmPort> =>
  env.ALERT_SINK === undefined || env.ALERT_SINK === ""
    ? Layer.succeed(AlarmPort, {
        deliver: () =>
          Effect.fail(
            new AlarmDeliveryFailed({ reason: "the operator overlay names no alert sink" }),
          ),
      })
    : alarmPortLayer({
        db: env.DB,
        sink: env.ALERT_SINK,
        ...(env.ALERT_EMAIL === undefined ? {} : { email: env.ALERT_EMAIL }),
      });

/** The tick's dependencies from the env; `extras` supplies the profile and each Layer the composition has. */
export const tickDepsFromEnv = (
  env: AlarmEnv & Readonly<Record<string, unknown>>,
  extras: Partial<TickDeps> & { readonly profile: Profile },
): TickDeps => {
  const silent = Effect.runSync(
    opsConfigFrom(env).pipe(
      Effect.map(webhookSilentHours),
      Effect.orElseSucceed(() => 24),
    ),
  );
  return { alarmPort: alarmPortFromEnv(env), webhookSilentHours: silent, ...extras };
};
