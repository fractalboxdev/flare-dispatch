// The minute tick's intake step only enqueues: each installation's planned units go to its own `IntakeUnits` object,
// whose alarms run them (specs/intake.md FD-INT-067).
import { GithubApp } from "@fractalboxdev/flare-dispatch-github";
import type { TickUnit } from "@fractalboxdev/flare-dispatch-intake";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { intakeUnits } from "../src/tick.ts";

/** An `INTAKE_UNITS` namespace that records each object's enqueued units. */
const namespace = () => {
  const enqueued: { object: string; units: readonly TickUnit[] }[] = [];
  return {
    enqueued,
    INTAKE_UNITS: {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({
        enqueue: async (units: readonly TickUnit[]) => {
          enqueued.push({ object: String(id), units });
          return units.length;
        },
      }),
    },
  };
};

/** The App's installations; any other App call fails the test. */
const app = (installations: readonly number[]) =>
  Effect.provideService(GithubApp, {
    installations: Effect.succeed(installations),
  } as unknown as GithubApp["Service"]);

describe("the tick's intake step", () => {
  it("[FD-INT-067] enqueues each installation's units on its own object and runs none of them", async () => {
    const env = namespace();
    const at = Date.UTC(2026, 10, 4, 12, 0);
    const report = await Effect.runPromise(intakeUnits(env, at).pipe(app([7, 8])));
    expect(env.enqueued).toEqual([
      {
        object: "7",
        units: [
          { _tag: "schedules", installation: 7, scheduledAt: at, repoIndex: 0 },
          {
            _tag: "sweep",
            installation: 7,
            scheduledAt: at,
            repoIndex: 0,
            pullsSeen: 0,
          },
        ],
      },
      {
        object: "8",
        units: [
          { _tag: "schedules", installation: 8, scheduledAt: at, repoIndex: 0 },
          {
            _tag: "sweep",
            installation: 8,
            scheduledAt: at,
            repoIndex: 0,
            pullsSeen: 0,
          },
        ],
      },
    ]);
    expect(report).toEqual([
      { installation: 7, units: ["schedules", "sweep"], added: 2 },
      { installation: 8, units: ["schedules", "sweep"], added: 2 },
    ]);
  });

  it("[FD-INT-067] a minute off the sweep's tenth enqueues the schedules unit alone", async () => {
    const env = namespace();
    const at = Date.UTC(2026, 10, 4, 12, 1);
    await Effect.runPromise(intakeUnits(env, at).pipe(app([7])));
    expect(env.enqueued.map((e) => e.units.map((u) => u._tag))).toEqual([["schedules"]]);
  });

  it("[FD-INT-067] an object that refuses the enqueue fails the step after every other installation is enqueued", async () => {
    const env = namespace();
    const get = env.INTAKE_UNITS.get;
    env.INTAKE_UNITS.get = (id: unknown) =>
      String(id) === "7"
        ? { enqueue: () => Promise.reject(new Error("object unavailable")) }
        : get(id);
    const exit = await Effect.runPromiseExit(
      intakeUnits(env, Date.UTC(2026, 10, 4, 12, 1)).pipe(app([7, 8])),
    );
    expect(env.enqueued.map((e) => e.object)).toEqual(["8"]);
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
    expect(error).toMatchObject({
      _tag: "IntakeEnqueueFailed",
      failed: [{ installation: 7 }],
      enqueued: [8],
    });
  });
});
