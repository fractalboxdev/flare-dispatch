// The Worker-only exports: they import `cloudflare:workers` through mameko's Durable Object classes, so only a
// Worker bundle loads this module. `FlareDispatchLivenessMonitor` is mameko's `LivenessMonitor` whose timed wake also
// raises `cron-silent` while the recorded minute tick is older than 2 min (MAMEKO-OPS-010).
import { LivenessMonitor, type LivenessMonitorEnv } from "@fractalboxdev/mameko-host-cloudflare";
import { Effect } from "effect";
import { alarmPortLayer, type EmailSender } from "./alarms.ts";
import { checkCronSilent } from "./tick.ts";

/** The monitor's bindings: mameko's, plus the alert sink var and an optional email binding. */
export type FlareDispatchMonitorEnv = LivenessMonitorEnv & {
  readonly ALERT_SINK?: string;
  readonly ALERT_EMAIL?: EmailSender;
};

export class FlareDispatchLivenessMonitor<
  Env extends FlareDispatchMonitorEnv = FlareDispatchMonitorEnv,
> extends LivenessMonitor<Env> {
  override async alarm(): Promise<void> {
    await super.alarm();
    const sink = this.env.ALERT_SINK;
    if (sink === undefined || sink === "") return;
    await Effect.runPromise(
      checkCronSilent(this.env.DB, Date.now()).pipe(
        Effect.provide(
          alarmPortLayer({
            db: this.env.DB,
            sink,
            ...(this.env.ALERT_EMAIL === undefined ? {} : { email: this.env.ALERT_EMAIL }),
          }),
        ),
        Effect.catchCause((cause) => Effect.logError("cron-silent check", cause)),
      ),
    );
  }
}
