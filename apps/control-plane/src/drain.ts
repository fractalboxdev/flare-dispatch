// The settle-time drain (MAMEKO-HOST-064): the `ExecutionEngine` object calls this Worker's `MamekoDrain` entrypoint
// through the `MAMEKO_DRAIN` service binding when an execution settles, so its outcome rows reach GitHub then rather
// than at the next minute tick. The tick's drain still runs every minute and takes any row this pass leaves.
import { actuatorBindings, drainOnce } from "@fractalboxdev/mameko-coordinator";
import { DrainEntrypoint } from "@fractalboxdev/mameko-host-cloudflare";
import { d1OutboxStore, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Layer } from "effect";
import { profileOf, type ControlPlaneEnv } from "./config.ts";
import { tickDeps } from "./tick.ts";

/**
 * One execution's drain pass over the same actuators the tick's drain applies through. A deploy whose tick has no
 * actuator (no App) drains nothing here either.
 */
export const drainExecution =
  (env: ControlPlaneEnv) =>
  (executionId: string): Promise<void> => {
    const appliers = tickDeps(env).appliers;
    if (appliers === undefined) return Promise.resolve();
    return Effect.runPromise(
      drainOnce({
        now: Date.now(),
        token: () => crypto.randomUUID(),
        random: Math.random,
        actuatorOf: actuatorBindings(profileOf(env).intent_kinds),
        executionId,
      }).pipe(
        Effect.provide(Layer.merge(d1OutboxStore(env.DB as unknown as D1Like), appliers)),
        Effect.asVoid,
      ),
    );
  };

/** The named entrypoint the `MAMEKO_DRAIN` service binding names. */
export class MamekoDrain extends DrainEntrypoint<ControlPlaneEnv> {
  protected drain(env: ControlPlaneEnv): (executionId: string) => Promise<void> {
    return drainExecution(env);
  }
}
