// The liveness record FlareDispatch keeps beside mameko's stores: the minute tick's last time, each installation's
// status and last verified webhook delivery, and the GitHub probes' latest results; and the liveness report
// `GET /v1/ops/health` serves (FD-OPS-036, MAMEKO-OPS-007).
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { ADVISORY_SNAPSHOTS_MIGRATION } from "./advisory.ts";
import { ALARM_TRANSITIONS_MIGRATIONS, ALARMS_MIGRATION } from "./alarms.ts";

/** FlareDispatch's own tables, created if absent; each statement is idempotent. */
export const OPS_MIGRATIONS: readonly string[] = [
  ALARMS_MIGRATION,
  ...ALARM_TRANSITIONS_MIGRATIONS,
  "create table if not exists fd_liveness (key text primary key, at integer not null)",
  `create table if not exists fd_installations (
    installation_id text primary key,
    account_login text not null,
    status text not null check (status in ('active', 'suspended', 'lost')),
    enrolled integer not null default 0 check (enrolled in (0, 1)),
    checked_at integer,
    last_verified_delivery_at integer)`,
  `create table if not exists fd_probes (
    name text primary key,
    ok integer not null check (ok in (0, 1)),
    detail_json text not null,
    at integer not null)`,
  `create table if not exists fd_canary_push (
    slot integer primary key check (slot = 1),
    pushed_at integer not null,
    fixture_repo text not null,
    fixture_installation text not null)`,
  `create table if not exists fd_install_states (
    state text primary key,
    session text not null,
    created_at integer not null,
    used_at integer)`,
  ADVISORY_SNAPSHOTS_MIGRATION,
];

/** Applies FlareDispatch's tables to the control plane's D1 database. */
export const runOpsMigrations = async (db: D1Like): Promise<void> => {
  for (const sql of OPS_MIGRATIONS) await db.prepare(sql).run();
};

const TICK = "tick";

/** Records the minute tick's time (the record MAMEKO-OPS-008 keeps in the liveness monitor). */
export const recordTick = (db: D1Like, now: number) =>
  db
    .prepare(
      "insert into fd_liveness (key, at) values (?, ?) on conflict (key) do update set at = excluded.at",
    )
    .bind(TICK, now)
    .run();

/** The last recorded tick time, or null before the first tick. */
export const lastTick = async (db: D1Like): Promise<number | null> => {
  const { results } = await db.prepare("select at from fd_liveness where key = ?").bind(TICK).all();
  return (results[0] as { at: number } | undefined)?.at ?? null;
};

/**
 * Records a verified webhook delivery for an installation, which `webhook-silent` reads (FD-INT-031, FD-OPS-089).
 * Intake calls it once the signature verifies.
 */
export const recordVerifiedDelivery = (
  db: D1Like,
  installation: { readonly id: string; readonly accountLogin: string; readonly enrolled?: boolean },
  now: number,
) =>
  db
    .prepare(
      `insert into fd_installations (installation_id, account_login, status, enrolled, last_verified_delivery_at)
       values (?, ?, 'active', ?, ?)
       on conflict (installation_id) do update set
         account_login = excluded.account_login, last_verified_delivery_at = excluded.last_verified_delivery_at,
         enrolled = max(fd_installations.enrolled, excluded.enrolled)`,
    )
    .bind(installation.id, installation.accountLogin, installation.enrolled === true ? 1 : 0, now)
    .run();

/** Registers an installation the App lists, as `active`; a registered installation keeps its row (FD-OPS-041). */
export const registerInstallation = (db: D1Like, id: string, accountLogin: string) =>
  db
    .prepare(
      `insert into fd_installations (installation_id, account_login, status) values (?, ?, 'active')
       on conflict (installation_id) do nothing`,
    )
    .bind(id, accountLogin)
    .run();

/**
 * Records a verified webhook delivery's time on a registered installation, which the canary's stage read and
 * `webhook-silent` take (FD-OPS-040, FD-OPS-089); an installation not yet registered records nothing.
 */
export const recordDeliveryTime = (db: D1Like, id: string, at: number) =>
  db
    .prepare(
      `update fd_installations set last_verified_delivery_at = max(coalesce(last_verified_delivery_at, 0), ?)
       where installation_id = ?`,
    )
    .bind(at, id)
    .run();

/** One installation as the probes and the report see it. */
export interface InstallationRow {
  readonly installationId: string;
  readonly accountLogin: string;
  readonly status: "active" | "suspended" | "lost";
  readonly enrolled: boolean;
  readonly checkedAt: number | null;
  readonly lastVerifiedDeliveryAt: number | null;
}

export const installations = async (db: D1Like): Promise<readonly InstallationRow[]> => {
  const { results } = await db
    .prepare(
      "select installation_id, account_login, status, enrolled, checked_at, last_verified_delivery_at from fd_installations order by installation_id",
    )
    .all();
  return (results as Record<string, unknown>[]).map((r) => ({
    installationId: r["installation_id"] as string,
    accountLogin: r["account_login"] as string,
    status: r["status"] as InstallationRow["status"],
    enrolled: r["enrolled"] === 1,
    checkedAt: (r["checked_at"] as number | null) ?? null,
    lastVerifiedDeliveryAt: (r["last_verified_delivery_at"] as number | null) ?? null,
  }));
};

export const setInstallationStatus = (
  db: D1Like,
  id: string,
  accountLogin: string,
  status: InstallationRow["status"],
  now: number,
) =>
  db
    .prepare(
      `insert into fd_installations (installation_id, account_login, status, checked_at) values (?, ?, ?, ?)
       on conflict (installation_id) do update set status = excluded.status, checked_at = excluded.checked_at,
         account_login = excluded.account_login`,
    )
    .bind(id, accountLogin, status, now)
    .run();

/** Stores one probe's latest result, which the `ok` heartbeat carries once mameko registers probes (MAMEKO-OPS-011). */
export const recordProbe = (db: D1Like, name: string, ok: boolean, detail: unknown, now: number) =>
  db
    .prepare(
      `insert into fd_probes (name, ok, detail_json, at) values (?, ?, ?, ?)
       on conflict (name) do update set ok = excluded.ok, detail_json = excluded.detail_json, at = excluded.at`,
    )
    .bind(name, ok ? 1 : 0, JSON.stringify(detail ?? null), now)
    .run();

/** The latest result of every probe. */
export const probeResults = async (db: D1Like) => {
  const { results } = await db
    .prepare("select name, ok, detail_json, at from fd_probes order by name")
    .all();
  return (results as Record<string, unknown>[]).map((r) => ({
    name: r["name"] as string,
    ok: r["ok"] === 1,
    detail: JSON.parse(r["detail_json"] as string) as unknown,
    at: r["at"] as number,
  }));
};

/** mameko's liveness report (MAMEKO-OPS-007) with FlareDispatch's installation fields (FD-OPS-036). */
export interface LivenessReport {
  readonly tick_age_ms: number | null;
  readonly executors: readonly {
    readonly executor_id: string;
    readonly heartbeat_age_ms: number | null;
  }[];
  readonly outbox_depth: number;
  readonly oldest_open_execution_age_ms: number | null;
  /** The coordinator's control state; null while mameko exposes no control-state read. */
  readonly control_state: string | null;
  readonly installations: readonly {
    readonly installation_id: string;
    readonly account_login: string;
    readonly status: string;
    readonly last_delivery_age_ms: number | null;
  }[];
  readonly probes: Awaited<ReturnType<typeof probeResults>>;
}

const age = (now: number, at: number | null | undefined) =>
  at === null || at === undefined ? null : now - at;

/** The liveness report, read from the control plane's D1 tables. */
export const livenessReport = async (db: D1Like, now: number): Promise<LivenessReport> => {
  const tick = await lastTick(db);
  const { results: hb } = await db
    .prepare("select executor_id, last_heartbeat_at from executor_heartbeats order by executor_id")
    .all();
  const { results: depth } = await db
    .prepare(
      "select count(*) as n from outbox where state in ('gated', 'pending', 'in_flight', 'ambiguous')",
    )
    .all();
  const { results: oldest } = await db
    .prepare("select min(enqueued_at) as at from executions where status in ('pending', 'running')")
    .all();
  return {
    tick_age_ms: age(now, tick),
    executors: (hb as { executor_id: string; last_heartbeat_at: number | null }[]).map((r) => ({
      executor_id: r.executor_id,
      heartbeat_age_ms: age(now, r.last_heartbeat_at),
    })),
    outbox_depth: (depth[0] as { n: number }).n,
    oldest_open_execution_age_ms: age(now, (oldest[0] as { at: number | null }).at),
    control_state: null,
    installations: (await installations(db)).map((i) => ({
      installation_id: i.installationId,
      account_login: i.accountLogin,
      status: i.status,
      last_delivery_age_ms: age(now, i.lastVerifiedDeliveryAt),
    })),
    probes: await probeResults(db),
  };
};

/** `GET /v1/ops/health`, for an identity the operator gate has passed (FD-OPS-036). */
export const healthRoute = async (db: D1Like, now: number): Promise<Response> =>
  Response.json(await livenessReport(db, now));
