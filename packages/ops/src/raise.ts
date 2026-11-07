// Raising and resolving an alarm through the alarm port, recorded first (MAMEKO-OPS-023), at most once per dedupe key
// per 24 h while its condition holds (MAMEKO-OPS-024), and one `resolved` when it clears (MAMEKO-OPS-025). mameko's
// coordinator exposes no alarm-raising operation at the pinned commit, so FlareDispatch's tick and probes raise their
// own alarms through these two functions.
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { AlarmPort, type Alarm } from "@fractalboxdev/mameko-ports";
import { Effect } from "effect";

/** How long one raised alarm stays quiet before the port is called again (MAMEKO-OPS-024). */
export const REPEAT_AFTER_MS = 86_400_000;

const lastState = (db: D1Like, key: string) =>
  Effect.promise(async () => {
    const { results } = await db
      .prepare("select state, updated_at from fd_alarms where dedupe_key = ?")
      .bind(key)
      .all();
    return results[0] as { state: string; updated_at: number } | undefined;
  });

/** What one raise or resolve did. */
export type RaiseResult = "sent" | "quiet" | "failed";

/** Records the alarm's state in the store before the port is called (MAMEKO-OPS-023). */
const record = (db: D1Like, alarm: Alarm, now: number) =>
  Effect.promise(() =>
    db
      .prepare(
        `insert into fd_alarms (dedupe_key, name, severity, state, detail_json, first_raised_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict (dedupe_key) do update set
           state = excluded.state, detail_json = excluded.detail_json, updated_at = excluded.updated_at`,
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
  );

const send = (db: D1Like, alarm: Alarm, now: number) =>
  Effect.gen(function* () {
    yield* record(db, alarm, now);
    const port = yield* AlarmPort;
    return yield* port.deliver(alarm).pipe(
      Effect.as("sent" as RaiseResult),
      // A failed delivery keeps the alarm recorded as active and changes no execution's outcome (MAMEKO-OPS-027,
      // MAMEKO-OPS-028); its `updated_at` of 0 lets the next tick send it again.
      Effect.catchTag("AlarmDeliveryFailed", (e) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(`alarm ${alarm.name}: ${e.reason}`);
          yield* Effect.promise(() =>
            db
              .prepare("update fd_alarms set updated_at = 0 where dedupe_key = ?")
              .bind(alarm.dedupeKey)
              .run(),
          );
          return "failed" as RaiseResult;
        }),
      ),
    );
  });

/** Raises `alarm` unless the same key was raised within 24 h. */
export const raiseOnce = (db: D1Like, alarm: Omit<Alarm, "state">, now: number) =>
  Effect.gen(function* () {
    const last = yield* lastState(db, alarm.dedupeKey);
    if (last?.state === "raised" && now - last.updated_at < REPEAT_AFTER_MS)
      return "quiet" as RaiseResult;
    return yield* send(db, { ...alarm, state: "raised" }, now);
  });

/** Sends one `resolved` for a key whose last state is `raised`. */
export const resolveAlarm = (db: D1Like, alarm: Omit<Alarm, "state">, now: number) =>
  Effect.gen(function* () {
    const last = yield* lastState(db, alarm.dedupeKey);
    if (last?.state !== "raised") return "quiet" as RaiseResult;
    return yield* send(db, { ...alarm, state: "resolved" }, now);
  });

/** Raises while `holds`, resolves once it clears. */
export const track = (db: D1Like, alarm: Omit<Alarm, "state">, holds: boolean, now: number) =>
  holds ? raiseOnce(db, alarm, now) : resolveAlarm(db, alarm, now);
