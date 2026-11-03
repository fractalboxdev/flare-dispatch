import { profile } from "@fractalboxdev/flare-dispatch-profile";
import { AlarmPort } from "@fractalboxdev/mameko-ports";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "./d1.test-support.ts";
import { activeAlarms, alarmPortFromEnv, tickDepsFromEnv } from "./index.ts";

let t: TestDb;
beforeEach(async () => {
  t = await freshDb();
});
afterEach(() => t.dispose());

const alarm = {
  name: "drift",
  severity: "notify" as const,
  dedupeKey: "drift",
  state: "raised" as const,
  detail: null,
};

describe("mounts", () => {
  it("[FD-OPS-053] the alarm port from the env records and sends to the rendered alert sink", async () => {
    const sent: string[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* AlarmPort).deliver(alarm);
      }).pipe(
        Effect.provide(
          alarmPortFromEnv({
            DB: t.db,
            ALERT_SINK: "ops@example.com",
            ALERT_EMAIL: { send: async (to) => void sent.push(to) },
          }),
        ),
      ),
    );
    expect(sent).toEqual(["ops@example.com"]);
    expect((await activeAlarms(t.db)).map((a) => a.name)).toEqual(["drift"]);
  });

  it("an env with no sink fails each delivery, so the coordinator keeps the alarm active", async () => {
    const err = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          yield* (yield* AlarmPort).deliver(alarm);
        }).pipe(Effect.provide(alarmPortFromEnv({ DB: t.db }))),
      ),
    );
    expect(err.reason).toBe("the operator overlay names no alert sink");
  });

  it("the tick's dependencies read the silence window from the env", () => {
    expect(
      tickDepsFromEnv({ DB: t.db, WEBHOOK_SILENT_HOURS: "6" }, { profile }).webhookSilentHours,
    ).toBe(6);
    expect(tickDepsFromEnv({ DB: t.db }, { profile }).webhookSilentHours).toBe(24);
  });
});
