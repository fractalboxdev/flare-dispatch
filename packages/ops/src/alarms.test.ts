import { AlarmPort, type Alarm } from "@fractalboxdev/mameko-ports";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, recordingAlarms, type TestDb } from "./d1.test-support.ts";
import {
  activeAlarms,
  alarmMessage,
  alarmPortLayer,
  raiseOnce,
  REPEAT_AFTER_MS,
  resolveAlarm,
  RUNBOOK,
} from "./index.ts";

let t: TestDb;
beforeEach(async () => {
  t = await freshDb();
});
afterEach(() => t.dispose());

const page: Alarm = {
  name: "canary-missed",
  severity: "page",
  dedupeKey: "canary-missed",
  state: "raised",
  detail: { last_stage: "intake" },
};

const deliver = (layer: ReturnType<typeof alarmPortLayer>, alarm: Alarm) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* AlarmPort).deliver(alarm);
    }).pipe(Effect.provide(layer)),
  );

describe("alarm port", () => {
  it("[FD-OPS-053] records every alarm for the dashboard and posts it to the overlay's webhook sink", async () => {
    const posted: { url: string; body: unknown }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await deliver(
      alarmPortLayer({
        db: t.db,
        sink: "https://alerts.example.com/hook",
        fetch: fetcher,
        now: () => 1000,
      }),
      page,
    );
    expect(posted).toEqual([
      {
        url: "https://alerts.example.com/hook",
        body: expect.objectContaining({
          alarm: "canary-missed",
          severity: "page",
          state: "raised",
          runbook: "R1",
        }),
      },
    ]);
    expect(await activeAlarms(t.db)).toEqual([
      expect.objectContaining({
        name: "canary-missed",
        severity: "page",
        runbook: "R1",
        firstRaisedAt: 1000,
      }),
    ]);
    await deliver(
      alarmPortLayer({
        db: t.db,
        sink: "https://alerts.example.com/hook",
        fetch: fetcher,
        now: () => 2000,
      }),
      { ...page, state: "resolved" },
    );
    expect(await activeAlarms(t.db)).toEqual([]);
  });

  it("[FD-OPS-053] sends to an email sink through the email binding, and fails a delivery it cannot make", async () => {
    const sent: string[] = [];
    await deliver(
      alarmPortLayer({
        db: t.db,
        sink: "ops@example.com",
        email: { send: async (to, subject) => void sent.push(`${to}:${subject}`) },
      }),
      page,
    );
    expect(sent).toEqual(["ops@example.com:canary-missed raised"]);
    const noEmail = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          return yield* (yield* AlarmPort).deliver(page);
        }).pipe(Effect.provide(alarmPortLayer({ db: t.db, sink: "ops@example.com" }))),
      ),
    );
    expect(noEmail.reason).toContain("no email sender");
    const failing = (async () => new Response("down", { status: 502 })) as unknown as typeof fetch;
    const err = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          return yield* (yield* AlarmPort).deliver(page);
        }).pipe(
          Effect.provide(
            alarmPortLayer({ db: t.db, sink: "https://alerts.example.com", fetch: failing }),
          ),
        ),
      ),
    );
    expect(err.reason).toBe("webhook answered 502");
  });

  it("[FD-OPS-057] every page message names the runbook entry that handles it", () => {
    for (const [name, entry] of Object.entries(RUNBOOK))
      expect(alarmMessage({ ...page, name })).toContain(`runbook ${entry}`);
    expect(alarmMessage({ ...page, severity: "notify", name: "drift" })).not.toContain("runbook");
    expect(RUNBOOK["deploy-probe-failed"]).toBe("R4");
    expect(RUNBOOK["floor-canary-failed"]).toBe("R5");
    expect(RUNBOOK["placement-stalled"]).toBe("R6");
    expect(RUNBOOK["installation-lost"]).toBe("R2");
  });

  it("raises once per dedupe key per 24 h and sends one resolved when the condition clears", async () => {
    const { delivered, layer } = recordingAlarms();
    const raise = (now: number) =>
      Effect.runPromise(raiseOnce(t.db, page, now).pipe(Effect.provide(layer)));
    expect(await raise(0)).toBe("sent");
    expect(await raise(60_000)).toBe("quiet");
    expect(await raise(REPEAT_AFTER_MS)).toBe("sent");
    expect(
      await Effect.runPromise(
        resolveAlarm(t.db, page, REPEAT_AFTER_MS + 1).pipe(Effect.provide(layer)),
      ),
    ).toBe("sent");
    expect(
      await Effect.runPromise(
        resolveAlarm(t.db, page, REPEAT_AFTER_MS + 2).pipe(Effect.provide(layer)),
      ),
    ).toBe("quiet");
    expect(delivered.map((a) => a.state)).toEqual(["raised", "raised", "resolved"]);
  });
});
