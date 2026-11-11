// The three GitHub probes the control plane runs every 15 min: the synthetic webhook canary, the installation probe
// and the delivery probe, and the `webhook-silent` check (specs/operability.md § Liveness and alerts). The App-JWT
// reads go through `GithubAppReads`, which the GitHub App package supplies.
import type { Profile } from "@fractalboxdev/flare-dispatch-profile";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Context, Effect, Schema } from "effect";
import {
  installations,
  recordProbe,
  registerInstallation,
  setInstallationStatus,
} from "./liveness.ts";
import { insertOpsIntent } from "./ops-intents.ts";
import { raiseOnce, track } from "./raise.ts";

/** One installation as `GET /app/installations/{installation_id}` answers it. */
export type InstallationRead =
  | { readonly status: "active"; readonly accountLogin: string }
  | { readonly status: "suspended"; readonly accountLogin: string }
  | { readonly status: "not-found" };

/** One webhook delivery as `GET /app/hook/deliveries` lists it. */
export interface Delivery {
  /** GitHub's numeric delivery id, which `POST /app/hook/deliveries/{delivery_id}/attempts` takes. */
  readonly id: number;
  /** The webhook's GUID, shared by a delivery and its redeliveries. */
  readonly guid: string;
  readonly statusCode: number;
  readonly deliveredAt: number;
  readonly redelivery: boolean;
}

/** An App-JWT read did not answer: a network failure, a non-2xx other than an installation's `404`, or a bad key. */
export class GithubAppReadFailed extends Schema.TaggedError<GithubAppReadFailed>()(
  "GithubAppReadFailed",
  { message: Schema.String },
) {}

/** The App-JWT reads the probes make; the control plane composes the live Layer over the GitHub App. */
export class GithubAppReads extends Context.Service<
  GithubAppReads,
  {
    /** The App's installations, which the installation probe registers before it reads each. */
    readonly installations: Effect.Effect<
      readonly { readonly installationId: string; readonly accountLogin: string }[],
      GithubAppReadFailed
    >;
    readonly installation: (
      installationId: string,
    ) => Effect.Effect<InstallationRead, GithubAppReadFailed>;
    readonly deliveries: (since: number) => Effect.Effect<readonly Delivery[], GithubAppReadFailed>;
  }
>()("@fractalboxdev/flare-dispatch-ops/GithubAppReads") {}

/** The probe cadence. */
export const PROBE_INTERVAL_MS = 900_000;
/** The canary check must conclude this long after the push (FD-OPS-040). */
export const CANARY_DEADLINE_MS = 300_000;
const DAY_MS = 86_400_000;

/** The canary branch of the fixture repository. */
export const CANARY_BRANCH = "flare-dispatch-canary";
/** The run the canary webhook admits (FD-OPS-039). */
export const CANARY_RUN = "canary";

/** The configuration the probes read from the operator overlay. */
export interface ProbeConfig {
  readonly fixtureRepo: string;
  /** The fixture repository's installation, whose permit the canary push takes (FD-ARCH-003). */
  readonly fixtureInstallation: string;
  readonly webhookSilentHours: number;
}

/** The fixture repository names no installation of the App, so no canary can be pushed or read (FD-OPS-038). */
export class FixtureInstallationMissing extends Schema.TaggedError<FixtureInstallationMissing>()(
  "FixtureInstallationMissing",
  { repository: Schema.String },
) {}

/** The fixture repository and installation a canary's stage read takes. */
export type CanaryTarget = Pick<ProbeConfig, "fixtureRepo" | "fixtureInstallation">;

/** The latest canary push: its tick time and the fixture repository and installation the push resolved. */
export interface CanaryPush extends CanaryTarget {
  readonly pushedAt: number;
}

/** Records the latest canary push, which the check 5 min later reads instead of resolving the fixture again. */
export const recordCanaryPush = (db: D1Like, target: CanaryTarget, pushedAt: number) =>
  Effect.promise(() =>
    db
      .prepare(
        `insert into fd_canary_push (slot, pushed_at, fixture_repo, fixture_installation) values (1, ?, ?, ?)
         on conflict (slot) do update set pushed_at = excluded.pushed_at, fixture_repo = excluded.fixture_repo,
           fixture_installation = excluded.fixture_installation`,
      )
      .bind(pushedAt, target.fixtureRepo, target.fixtureInstallation)
      .run(),
  );

/** The latest canary push, or null before the first. */
export const lastCanaryPush = (db: D1Like) =>
  Effect.promise(async (): Promise<CanaryPush | null> => {
    const { results } = await db
      .prepare(
        "select pushed_at, fixture_repo, fixture_installation from fd_canary_push where slot = 1",
      )
      .all();
    const row = results[0] as
      | { pushed_at: number; fixture_repo: string; fixture_installation: string }
      | undefined;
    return row === undefined
      ? null
      : {
          pushedAt: row.pushed_at,
          fixtureRepo: row.fixture_repo,
          fixtureInstallation: row.fixture_installation,
        };
  });

/**
 * A fixture repository no installation covers: the canary probe reads not ok and `canary-missed` names the push stage
 * and the repository, since no canary can be pushed until the fixture is installed (FD-OPS-038, FD-OPS-040).
 */
export const canaryUncovered = (db: D1Like, repository: string, now: number) =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      recordProbe(
        db,
        "canary",
        false,
        { stage: "push", reason: `no installation covers ${repository}` },
        now,
      ),
    );
    yield* raiseOnce(
      db,
      {
        name: "canary-missed",
        severity: "page",
        dedupeKey: "canary-missed",
        detail: { last_stage: "push", repository },
      },
      now,
    );
  });

/**
 * Inserts the `canary.push` ops intent under the key `canary:<tick time>` (FD-OPS-038). Its payload is the one the
 * GitHub applier decodes: the branch, and the tick time as ISO 8601 text, which the commit message carries.
 */
export const pushCanary = (db: D1Like, profile: Profile, config: ProbeConfig, tick: number) =>
  insertOpsIntent(
    db,
    profile,
    {
      scopeId: config.fixtureRepo,
      intentKey: `canary:${tick}`,
      kind: "canary.push",
      payload: { branch: CANARY_BRANCH, tick_time: new Date(tick).toISOString() },
      limitKey: config.fixtureInstallation,
    },
    tick,
  );

/** The stages a canary passes, in order (FD-OPS-040). */
export const CANARY_STAGES = ["delivery", "intake", "placement", "verdict", "check"] as const;
export type CanaryStage = (typeof CANARY_STAGES)[number] | "push";

/** The last stage the canary pushed at `pushedAt` reached, read from the control plane's tables. */
export const canaryStage = async (
  db: D1Like,
  config: CanaryTarget,
  pushedAt: number,
): Promise<CanaryStage> => {
  const { results: delivered } = await db
    .prepare(
      "select last_verified_delivery_at as at from fd_installations where installation_id = ?",
    )
    .bind(config.fixtureInstallation)
    .all();
  const deliveredAt = (delivered[0] as { at: number | null } | undefined)?.at ?? null;
  if (deliveredAt === null || deliveredAt < pushedAt) return "push";
  const { results } = await db
    .prepare(
      `select e.id, e.status, e.surface_delivered_at, p.state as placement
       from executions e left join placements p on p.execution_id = e.id
       where e.run = ? and e.scope_id = ? and e.enqueued_at >= ? order by e.enqueued_at desc limit 1`,
    )
    .bind(CANARY_RUN, config.fixtureRepo, pushedAt)
    .all();
  const row = results[0] as
    | { status: string; surface_delivered_at: number | null; placement: string | null }
    | undefined;
  if (row === undefined) return "delivery";
  if (row.status !== "success") return row.placement === null ? "intake" : "placement";
  return row.surface_delivered_at === null ? "verdict" : "check";
};

/** Raises `canary-missed` naming the last stage when the canary has not concluded its check (FD-OPS-040). */
export const checkCanary = (db: D1Like, config: CanaryTarget, pushedAt: number, now: number) =>
  Effect.gen(function* () {
    const stage = yield* Effect.promise(() => canaryStage(db, config, pushedAt));
    const ok = stage === "check";
    yield* Effect.promise(() => recordProbe(db, "canary", ok, { pushed_at: pushedAt, stage }, now));
    yield* track(
      db,
      {
        name: "canary-missed",
        severity: "page",
        dedupeKey: "canary-missed",
        detail: { last_stage: stage },
      },
      !ok,
      now,
    );
    return stage;
  });

/**
 * Registers each installation the App lists, then reads each registered installation and raises `installation-lost`
 * for a 404 or a suspension (FD-OPS-041, FD-OPS-042). A registered installation stays registered once the App no
 * longer lists it, so its read answers the `404` that names it lost.
 */
export const probeInstallations = (db: D1Like, now: number) =>
  Effect.gen(function* () {
    const reads = yield* GithubAppReads;
    for (const i of yield* reads.installations)
      yield* Effect.promise(() => registerInstallation(db, i.installationId, i.accountLogin));
    const lost: string[] = [];
    for (const i of yield* Effect.promise(() => installations(db))) {
      const read = yield* reads.installation(i.installationId);
      const login = read.status === "not-found" ? i.accountLogin : read.accountLogin;
      const status =
        read.status === "active" ? "active" : read.status === "suspended" ? "suspended" : "lost";
      yield* Effect.promise(() => setInstallationStatus(db, i.installationId, login, status, now));
      if (status !== "active") lost.push(login);
      yield* track(
        db,
        {
          name: "installation-lost",
          severity: "page",
          dedupeKey: `installation-lost:${i.installationId}`,
          detail: { account_login: login, status: read.status },
        },
        status !== "active",
        now,
      );
    }
    yield* Effect.promise(() => recordProbe(db, "installation", lost.length === 0, { lost }, now));
    return lost;
  });

/** An `installation` event with action `deleted` or `suspend` raises `installation-lost` at once (FD-OPS-043). */
export const onInstallationEvent = (
  db: D1Like,
  event: {
    readonly action: string;
    readonly installationId: string;
    readonly accountLogin: string;
  },
  now: number,
) =>
  Effect.gen(function* () {
    if (event.action !== "deleted" && event.action !== "suspend") return false;
    yield* Effect.promise(() =>
      setInstallationStatus(
        db,
        event.installationId,
        event.accountLogin,
        event.action === "deleted" ? "lost" : "suspended",
        now,
      ),
    );
    yield* raiseOnce(
      db,
      {
        name: "installation-lost",
        severity: "page",
        dedupeKey: `installation-lost:${event.installationId}`,
        detail: { account_login: event.accountLogin, action: event.action },
      },
      now,
    );
    return true;
  });

const is2xx = (code: number) => code >= 200 && code < 300;

/**
 * The failed deliveries of the last 24 h with no later successful attempt of the same webhook, once the newest
 * delivery answered `2xx` (FD-OPS-045).
 */
export const deliveriesToRedeliver = (
  deliveries: readonly Delivery[],
  now: number,
): readonly Delivery[] => {
  const recent = deliveries.filter((d) => now - d.deliveredAt <= DAY_MS);
  const newest = [...recent].sort((a, b) => b.deliveredAt - a.deliveredAt)[0];
  if (newest === undefined || !is2xx(newest.statusCode)) return [];
  return recent.filter(
    (d) =>
      !is2xx(d.statusCode) &&
      !recent.some(
        (later) =>
          later.guid === d.guid && later.deliveredAt > d.deliveredAt && is2xx(later.statusCode),
      ),
  );
};

/**
 * Lists the last 24 h of deliveries, raises `delivery-failing` with the statuses and count of the failures in the
 * last 15 min (FD-OPS-044), and inserts one `delivery.redeliver` ops intent per failed delivery once the path answers
 * `2xx` (FD-OPS-045).
 */
export const probeDeliveries = (db: D1Like, profile: Profile, appLimitKey: string, now: number) =>
  Effect.gen(function* () {
    const reads = yield* GithubAppReads;
    const deliveries = yield* reads.deliveries(now - DAY_MS);
    const failing = deliveries.filter(
      (d) => now - d.deliveredAt <= PROBE_INTERVAL_MS && !is2xx(d.statusCode),
    );
    const statuses = [...new Set(failing.map((d) => d.statusCode))].sort();
    yield* track(
      db,
      {
        name: "delivery-failing",
        severity: "page",
        dedupeKey: "delivery-failing",
        detail: { count: failing.length, statuses },
      },
      failing.length > 0,
      now,
    );
    const redeliver = deliveriesToRedeliver(deliveries, now);
    for (const d of redeliver)
      yield* insertOpsIntent(
        db,
        profile,
        {
          scopeId: "app",
          intentKey: `redeliver:${d.id}`,
          kind: "delivery.redeliver",
          payload: { delivery_id: d.id },
          limitKey: appLimitKey,
        },
        now,
      );
    yield* Effect.promise(() =>
      recordProbe(db, "delivery", failing.length === 0, { failing: failing.length, statuses }, now),
    );
    return { failing: failing.length, redelivered: redeliver.map((d) => d.id) };
  });

/**
 * Raises `webhook-silent` for each installation with an enrolled repository and no verified delivery for
 * `alerts.webhookSilentHours` (FD-OPS-089).
 */
export const checkWebhookSilence = (db: D1Like, silentHours: number, now: number) =>
  Effect.gen(function* () {
    const silentMs = silentHours * 3_600_000;
    const silent: string[] = [];
    for (const i of yield* Effect.promise(() => installations(db))) {
      if (!i.enrolled) continue;
      const quiet = i.lastVerifiedDeliveryAt === null || now - i.lastVerifiedDeliveryAt >= silentMs;
      if (quiet) silent.push(i.accountLogin);
      yield* track(
        db,
        {
          name: "webhook-silent",
          severity: "notify",
          dedupeKey: `webhook-silent:${i.installationId}`,
          detail: { account_login: i.accountLogin, silent_hours: silentHours },
        },
        quiet,
        now,
      );
    }
    return silent;
  });
