// The minute tick: the Worker's one cron trigger (FD-INT-050). Each tick records its time, starts the liveness
// monitor, drains the outbox once, once a day reads the kill lines (FD-VER-030), and every 15 min runs the GitHub
// probes; 5 min after a canary push it reads the canary's check. Each step runs on its own, so one failing step leaves the others running.
import type { Profile } from "@fractalboxdev/flare-dispatch-profile";
import { actuatorBindings, drainOnce } from "@fractalboxdev/mameko-coordinator";
import { d1OutboxStore, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import type { ActuatorRateLimit, Actuators, AlarmPort } from "@fractalboxdev/mameko-ports";
import { Cause, Effect, Layer } from "effect";
import { KILL_LINE_INTERVAL_MS, killLineMonitor } from "./kill-lines.ts";
import { lastTick, recordTick, runOpsMigrations } from "./liveness.ts";
import {
  CANARY_DEADLINE_MS,
  canaryUncovered,
  checkCanary,
  checkWebhookSilence,
  FixtureInstallationMissing,
  GithubAppReads,
  lastCanaryPush,
  PROBE_INTERVAL_MS,
  probeDeliveries,
  probeInstallations,
  pushCanary,
  recordCanaryPush,
  type ProbeConfig,
} from "./probes.ts";
import { raiseOnce, resolveAlarm } from "./raise.ts";

/** The `LivenessMonitor` namespace binding; one object per control plane. */
export interface MonitorNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { start(): Promise<void> };
}

/** The bindings the tick reads. */
export interface TickEnv {
  readonly DB: D1Like;
  readonly MONITOR: MonitorNamespace;
}

/** What the tick composes beside the bindings. */
export interface TickDeps {
  readonly profile: Profile;
  readonly alarmPort: Layer.Layer<AlarmPort>;
  /**
   * The GitHub App package's actuators, one per binding the profile's intent kinds name, and its `InstallationQuota`
   * rate limit; without them the tick drains nothing.
   */
  readonly appliers?: Layer.Layer<Actuators | ActuatorRateLimit>;
  /** The App-JWT reads; without them the installation and delivery probes do not run. */
  readonly githubReads?: Layer.Layer<GithubAppReads>;
  /**
   * The canary's fixture repository and installation, or the read that resolves them, such as the App's lookup of the
   * fixture repository's installation; without them no canary is pushed. The push resolves them once and records them,
   * and the check reads that record. A failed read fails the canary step of that tick alone; a read that fails with
   * `FixtureInstallationMissing` also raises `canary-missed` at the push stage.
   */
  readonly probes?: ProbeConfig | Effect.Effect<ProbeConfig, unknown>;
  /** The limit key the App-JWT `delivery.redeliver` intents take. */
  readonly appLimitKey?: string;
  readonly webhookSilentHours: number;
  /**
   * The units another area runs on the tick, each its own step: intake's sweep and schedule units, the cache, artifact
   * and log retention sweeps.
   */
  readonly units?: (now: number) => readonly TickStep[];
}

/** One unit of work the tick runs as its own step. */
export interface TickStep {
  readonly step: string;
  readonly effect: Effect.Effect<unknown, unknown>;
}

/** The name the one `LivenessMonitor` object is addressed by. */
export const MONITOR_NAME = "control-plane";

/** One step's outcome: ran, skipped for a missing dependency, or failed with its cause. */
export type StepOutcome =
  | { readonly step: string; readonly status: "ran"; readonly detail?: unknown }
  | { readonly step: string; readonly status: "skipped"; readonly reason: string }
  | { readonly step: string; readonly status: "failed"; readonly cause: string };

const run = <A, R>(step: string, effect: Effect.Effect<A, unknown, R>) =>
  effect.pipe(
    Effect.map((detail): StepOutcome => ({ step, status: "ran", detail })),
    Effect.catchCause((cause) =>
      Effect.succeed<StepOutcome>({ step, status: "failed", cause: Cause.pretty(cause) }),
    ),
  );

const skipped = (step: string, reason: string) =>
  Effect.succeed<StepOutcome>({ step, status: "skipped", reason });

const probeConfigOf = (probes: ProbeConfig | Effect.Effect<ProbeConfig, unknown>) =>
  Effect.isEffect(probes) ? probes : Effect.succeed(probes);

/** Whether `now` falls in the first minute of a 15 min window. */
export const isProbeMinute = (now: number): boolean => now % PROBE_INTERVAL_MS < 60_000;

const readKey = (db: D1Like, key: string) =>
  Effect.promise(async () => {
    const { results } = await db
      .prepare("select at from fd_liveness where key = ?")
      .bind(key)
      .all();
    return (results[0] as { at: number } | undefined)?.at ?? null;
  });

const writeKey = (db: D1Like, key: string, at: number) =>
  Effect.promise(() =>
    db
      .prepare(
        "insert into fd_liveness (key, at) values (?, ?) on conflict (key) do update set at = excluded.at",
      )
      .bind(key, at)
      .run(),
  );

/**
 * One minute tick at `now`. Its report names each step and whether it ran, was skipped for a dependency the
 * composition does not supply, or failed.
 */
export const minuteTick = (env: TickEnv, deps: TickDeps, now: number) =>
  Effect.gen(function* () {
    const db = env.DB;
    yield* Effect.promise(() => runOpsMigrations(db));
    const steps: StepOutcome[] = [];

    // The tick's own record; a tick after a silence resolves `cron-silent`, which the monitor's wake raised.
    steps.push(
      yield* run(
        "record-tick",
        Effect.gen(function* () {
          const previous = yield* Effect.promise(() => lastTick(db));
          yield* Effect.promise(() => recordTick(db, now));
          yield* resolveAlarm(
            db,
            { name: "cron-silent", severity: "notify", dedupeKey: "cron-silent", detail: null },
            now,
          );
          return { previous };
        }),
      ),
    );

    steps.push(
      yield* run(
        "liveness-monitor",
        Effect.promise(() => env.MONITOR.get(env.MONITOR.idFromName(MONITOR_NAME)).start()),
      ),
    );

    steps.push(
      deps.appliers === undefined
        ? yield* skipped("drain", "no actuator or actuator rate limit Layer")
        : yield* run(
            "drain",
            drainOnce({
              now,
              token: () => crypto.randomUUID(),
              random: Math.random,
              actuatorOf: actuatorBindings(deps.profile.intent_kinds),
            }).pipe(Effect.provide(Layer.merge(d1OutboxStore(db), deps.appliers))),
          ),
    );

    for (const unit of deps.units?.(now) ?? []) steps.push(yield* run(unit.step, unit.effect));

    // The daily kill-line read. A failed read, or a `kill-line` notification whose delivery failed, records no time, so
    // the next tick reads again and resends it (MAMEKO-OPS-026).
    const killLinesRead = yield* readKey(db, "kill-lines-read");
    if (killLinesRead === null || now - killLinesRead >= KILL_LINE_INTERVAL_MS)
      steps.push(
        yield* run(
          "kill-lines",
          Effect.gen(function* () {
            const report = yield* killLineMonitor(db, now);
            if (!report.raised.some((r) => r.result === "failed"))
              yield* writeKey(db, "kill-lines-read", now);
            return report;
          }),
        ),
      );

    if (isProbeMinute(now)) {
      steps.push(
        deps.probes === undefined
          ? yield* skipped("canary-push", "no fixture repository or installation")
          : yield* run(
              "canary-push",
              Effect.gen(function* () {
                // A fixture repository no installation covers is GitHub's definite answer, not a transient failure: it
                // raises `canary-missed` at the push stage and records the probe not ok, and the step still fails.
                const config = yield* probeConfigOf(deps.probes!).pipe(
                  Effect.tapError((e) =>
                    e instanceof FixtureInstallationMissing
                      ? canaryUncovered(db, e.repository, now)
                      : Effect.void,
                  ),
                );
                const key = yield* pushCanary(db, deps.profile, config, now);
                // The check reads the fixture the push resolved, so it makes no GitHub read of its own.
                yield* recordCanaryPush(db, config, now);
                return key;
              }),
            ),
      );
      if (deps.githubReads === undefined) {
        steps.push(yield* skipped("installation-probe", "no GitHub App reads Layer"));
        steps.push(yield* skipped("delivery-probe", "no GitHub App reads Layer"));
      } else {
        steps.push(
          yield* run(
            "installation-probe",
            probeInstallations(db, now).pipe(Effect.provide(deps.githubReads)),
          ),
        );
        steps.push(
          deps.appLimitKey === undefined
            ? yield* skipped("delivery-probe", "no App limit key")
            : yield* run(
                "delivery-probe",
                probeDeliveries(db, deps.profile, deps.appLimitKey, now).pipe(
                  Effect.provide(deps.githubReads),
                ),
              ),
        );
      }
      steps.push(
        yield* run("webhook-silence", checkWebhookSilence(db, deps.webhookSilentHours, now)),
      );
    }

    if (deps.probes !== undefined) {
      const push = yield* lastCanaryPush(db);
      const checked = yield* readKey(db, "canary-checked");
      if (
        push !== null &&
        now - push.pushedAt >= CANARY_DEADLINE_MS &&
        (checked === null || checked < push.pushedAt)
      )
        steps.push(
          yield* run(
            "canary-check",
            Effect.gen(function* () {
              const stage = yield* checkCanary(db, push, push.pushedAt, now);
              yield* writeKey(db, "canary-checked", push.pushedAt);
              return { stage };
            }),
          ),
        );
    }
    return { at: now, steps };
  }).pipe(Effect.provide(deps.alarmPort));

/** The tick age past which the monitor's wake raises `cron-silent` (MAMEKO-OPS-010). */
export const CRON_SILENT_AFTER_MS = 120_000;

/**
 * The `cron-silent` check the liveness monitor's timed wake runs: the notify alarm while the recorded tick is older
 * than 2 min (MAMEKO-OPS-010). The next tick resolves it.
 */
export const checkCronSilent = (db: D1Like, now: number) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => runOpsMigrations(db));
    const last = yield* Effect.promise(() => lastTick(db));
    if (last === null || now - last <= CRON_SILENT_AFTER_MS) return false;
    yield* raiseOnce(
      db,
      {
        name: "cron-silent",
        severity: "notify",
        dedupeKey: "cron-silent",
        detail: { last_tick_age_ms: now - last },
      },
      now,
    );
    return true;
  });

/** The Worker's `scheduled` export: one tick per cron event, kept alive by `waitUntil`. */
export const scheduledHandler =
  <Env extends TickEnv>(deps: (env: Env) => TickDeps) =>
  (
    controller: { readonly scheduledTime: number },
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ) => {
    ctx.waitUntil(
      Effect.runPromise(
        minuteTick(env, deps(env), controller.scheduledTime).pipe(
          Effect.tap((report) =>
            Effect.sync(() => {
              for (const s of report.steps)
                if (s.status === "failed") console.error(`tick ${report.at} ${s.step}: ${s.cause}`);
            }),
          ),
        ),
      ),
    );
  };
