// FlareDispatch's alarm port: each alarm the coordinator raises is recorded for the dashboard and sent to the alert
// sink the operator overlay names (FD-OPS-053). mameko's coordinator decides when an alarm is raised, repeated,
// resolved and retried (MAMEKO-OPS-022 to MAMEKO-OPS-028); this port records and sends what it is given.
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { AlarmDeliveryFailed, AlarmPort, type Alarm } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";

/** The runbook entry that handles each alarm of specs/operability.md § Liveness and alerts. */
export const RUNBOOK: Readonly<Record<string, string>> = {
  "canary-missed": "R1",
  "delivery-failing": "R1",
  "webhook-silent": "R1",
  "installation-lost": "R2",
  drift: "R3",
  "deploy-probe-failed": "R4",
  "floor-canary-failed": "R5",
  "placement-stalled": "R6",
  "cron-silent": "R7",
  "executions-lost": "R8",
  "operator-control": "R9",
  "delivery-key-paused": "R15",
};

/** The D1 table the dashboard reads active alarms from. */
export const ALARMS_MIGRATION = `create table if not exists fd_alarms (
  dedupe_key text primary key,
  name text not null,
  severity text not null check (severity in ('page', 'notify')),
  state text not null check (state in ('raised', 'resolved', 'ok')),
  detail_json text not null,
  first_raised_at integer not null,
  updated_at integer not null)`;

/**
 * Each change of an alarm's state, which `fd_alarms` overwrites: the phase gate reads every raise and resolve of its
 * window from it (specs/verification.md FD-VER-029). The triggers write a row on every `fd_alarms` write that sets a
 * new state, so each writer of `fd_alarms` records its transitions; a row `fd_alarms` held before the triggers existed
 * is copied once, stamped with its first raise.
 */
export const ALARM_TRANSITIONS_MIGRATIONS: readonly string[] = [
  `create table if not exists fd_alarm_transitions (
  dedupe_key text not null,
  name text not null,
  severity text not null,
  state text not null,
  at integer not null)`,
  "create index if not exists fd_alarm_transitions_key on fd_alarm_transitions (dedupe_key, at)",
  `create trigger if not exists fd_alarms_inserted after insert on fd_alarms begin
  insert into fd_alarm_transitions (dedupe_key, name, severity, state, at)
  values (new.dedupe_key, new.name, new.severity, new.state, new.updated_at);
end`,
  `create trigger if not exists fd_alarms_state_changed after update of state on fd_alarms
  when new.state <> old.state begin
  insert into fd_alarm_transitions (dedupe_key, name, severity, state, at)
  values (new.dedupe_key, new.name, new.severity, new.state, new.updated_at);
end`,
  `insert into fd_alarm_transitions (dedupe_key, name, severity, state, at)
  select a.dedupe_key, a.name, a.severity, a.state, a.first_raised_at from fd_alarms a
  where not exists (select 1 from fd_alarm_transitions t where t.dedupe_key = a.dedupe_key)`,
];

/** Sends an email; the Worker supplies it over its `send_email` binding. */
export interface EmailSender {
  readonly send: (to: string, subject: string, text: string) => Promise<void>;
}

/** Where the alarm port sends: the overlay's `alerts.sink`. */
export interface AlarmPortConfig {
  readonly db: D1Like;
  readonly sink: string;
  readonly fetch?: typeof fetch;
  readonly email?: EmailSender;
  readonly now?: () => number;
}

/**
 * The message text: the alarm, its state and detail, and for a page the runbook entry that handles it
 * (FD-OPS-057).
 */
export const alarmMessage = (alarm: Alarm): string => {
  const head = `[${alarm.severity}] ${alarm.name} ${alarm.state}`;
  const runbook =
    alarm.severity === "page"
      ? ` · runbook ${RUNBOOK[alarm.name] ?? "entry: none listed for this alarm"}`
      : "";
  const detail =
    alarm.detail === null || alarm.detail === undefined ? "" : ` · ${JSON.stringify(alarm.detail)}`;
  return `${head}${runbook}${detail}`;
};

const isEmail = (sink: string) => !sink.startsWith("https://") && sink.includes("@");

const failWith = (reason: string) => (e: unknown) =>
  new AlarmDeliveryFailed({ reason: `${reason}: ${e instanceof Error ? e.message : String(e)}` });

/** Records the alarm, then sends it to the sink; a failed send is `AlarmDeliveryFailed`, which the coordinator retries. */
export const deliverAlarm = (config: AlarmPortConfig, alarm: Alarm) =>
  Effect.gen(function* () {
    const now = (config.now ?? Date.now)();
    yield* Effect.tryPromise({
      try: () =>
        config.db
          .prepare(
            `insert into fd_alarms (dedupe_key, name, severity, state, detail_json, first_raised_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?)
             on conflict (dedupe_key) do update set
               state = excluded.state, detail_json = excluded.detail_json, severity = excluded.severity,
               updated_at = excluded.updated_at`,
          )
          .bind(
            alarm.dedupeKey,
            alarm.name,
            alarm.severity,
            alarm.state,
            JSON.stringify(alarm.detail ?? null),
            now,
            now,
          )
          .run(),
      catch: failWith("record"),
    });
    const message = alarmMessage(alarm);
    if (isEmail(config.sink)) {
      const email = config.email;
      if (email === undefined)
        return yield* new AlarmDeliveryFailed({
          reason: "the sink is an email address and no email sender is bound",
        });
      yield* Effect.tryPromise({
        try: () => email.send(config.sink, `${alarm.name} ${alarm.state}`, message),
        catch: failWith("email"),
      });
      return;
    }
    const response = yield* Effect.tryPromise({
      try: () =>
        (config.fetch ?? fetch)(config.sink, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            alarm: alarm.name,
            severity: alarm.severity,
            state: alarm.state,
            dedupe_key: alarm.dedupeKey,
            runbook: alarm.severity === "page" ? (RUNBOOK[alarm.name] ?? null) : null,
            detail: alarm.detail ?? null,
            message,
          }),
        }),
      catch: failWith("webhook"),
    });
    if (!response.ok)
      return yield* new AlarmDeliveryFailed({ reason: `webhook answered ${response.status}` });
  });

/** The alarm port Layer the composed control plane supplies (MAMEKO-HOST-046 requires it in every phase). */
export const alarmPortLayer = (config: AlarmPortConfig) =>
  Layer.succeed(AlarmPort, { deliver: (alarm) => deliverAlarm(config, alarm) });

/** An active alarm as the dashboard shows it. */
export interface ActiveAlarm {
  readonly name: string;
  readonly severity: "page" | "notify";
  readonly dedupeKey: string;
  readonly detail: unknown;
  readonly firstRaisedAt: number;
  readonly updatedAt: number;
  readonly runbook: string | null;
}

/** Every alarm whose last recorded state is `raised`, newest first. */
export const activeAlarms = async (db: D1Like): Promise<readonly ActiveAlarm[]> => {
  const { results } = await db
    .prepare(
      "select dedupe_key, name, severity, detail_json, first_raised_at, updated_at from fd_alarms where state = 'raised' order by updated_at desc",
    )
    .all();
  return (results as Record<string, unknown>[]).map((r) => ({
    name: r["name"] as string,
    severity: r["severity"] as "page" | "notify",
    dedupeKey: r["dedupe_key"] as string,
    detail: JSON.parse(r["detail_json"] as string) as unknown,
    firstRaisedAt: r["first_raised_at"] as number,
    updatedAt: r["updated_at"] as number,
    runbook: RUNBOOK[r["name"] as string] ?? null,
  }));
};
