// A `verdict.record` row whose first delivery loses its answer, drained again over one SQLite D1 outbox through the
// GitHub actuators and the actuator rate limit (specs/github-output.md § Job and verdict records). The drainer marks the
// row ambiguous, sends the replay-safe row again, and the records endpoint receives both attempts under one delivery id.
import { createHmac } from "node:crypto";
import { buildProfile, deliveryLimitKey } from "@fractalboxdev/flare-dispatch-profile";
import { actuatorBindings, drainOnce } from "@fractalboxdev/mameko-coordinator";
import {
  d1OutboxStore,
  insertOutboxRows,
  runD1Migrations,
} from "@fractalboxdev/mameko-host-cloudflare/d1";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { AlarmPort } from "@fractalboxdev/mameko-ports";
import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { GithubApp } from "../../src/app.ts";
import { InstallationDirectory } from "../../src/applier.ts";
import { fakeSide, fakeWritesLayer } from "../../src/fake-writes.test-support.ts";
import { fakeConcludeFacts, fakeGithub, fakeGithubLayers } from "../../src/fake.test-support.ts";
import { GithubApplierLive } from "../../src/github-applier.ts";
import { ActuatorRateLimitLive, InstallationQuota } from "../../src/rate-limit.ts";
import { VERDICT_RECORD_SCHEMA, type VerdictRecordPayload } from "../../src/records.ts";
import { SideOutputConfig } from "../../src/side-ports.ts";
import { sqliteD1 } from "./github.replay.ts";

const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const MINUTE_MS = 60_000;
const RECORDS_URL = "https://records.example.com/hook";
const SECRET = "records-secret";
const EXECUTION = "exec-terminal-1";
const INTENT_KEY = `ops:verdict-record:${EXECUTION}`;
const profile = buildProfile("production", 2, { records: true });

const payload: VerdictRecordPayload = {
  schema: VERDICT_RECORD_SCHEMA,
  execution_id: EXECUTION,
  epoch: 1,
  run: "ci",
  repository: "acme/app",
  commit_sha: "b".repeat(40),
  ref: "refs/heads/main",
  class: "required",
  trigger: "webhook",
  verdict: "success",
  reason: null,
  conclusion: "success",
  check_name: "flare-dispatch/ci",
};

interface Post {
  readonly at: number;
  readonly headers: Headers;
  readonly body: string;
}

const unused = () => Effect.die("not used by a record row");

/** One outbox over SQLite, the GitHub actuators and the rate limit, and a records endpoint that drops its first answer. */
const plane = async () => {
  const db = sqliteD1();
  await runD1Migrations(db);
  const posts: Post[] = [];
  const quotaCalls: string[] = [];
  let now = T0;
  let dropNext = true;
  const ports = Layer.mergeAll(
    fakeGithubLayers(fakeGithub()),
    fakeConcludeFacts(fakeGithub()),
    fakeWritesLayer(fakeSide()),
    Layer.succeed(InstallationDirectory, { installationFor: unused }),
    Layer.succeed(AlarmPort, { deliver: unused }),
    Layer.succeed(GithubApp, {
      jwt: unused(),
      token: unused,
      installationFor: unused,
      evictInstallation: unused,
      evictRepositories: unused,
      installations: unused(),
      rest: unused,
    }),
    Layer.succeed(InstallationQuota, {
      observe: (key) => Effect.sync(() => void quotaCalls.push(`observe ${key}`)),
      acquire: (r) =>
        Effect.sync(() => {
          quotaCalls.push(`acquire ${r.limitKey}`);
          return { _tag: "granted" as const, permitId: `${r.limitKey}:1` };
        }),
      release: (id) => Effect.sync(() => void quotaCalls.push(`release ${id}`)),
      remainingShare: (key) => Effect.sync(() => (quotaCalls.push(`share ${key}`), 1)),
    }),
    Layer.succeed(SideOutputConfig, {
      appBot: {
        login: "flare-dispatch[bot]",
        name: "flare-dispatch[bot]",
        email: "bot@example.com",
      },
      slack: undefined,
      records: { url: RECORDS_URL, secret: SECRET },
      fetch: (async (url: unknown, init?: RequestInit) => {
        expect(String(url)).toBe(RECORDS_URL);
        posts.push({ at: now, headers: new Headers(init?.headers), body: String(init?.body) });
        if (dropNext) {
          dropNext = false;
          // The endpoint received the record; its answer never reaches the applier.
          throw new TypeError("connection reset");
        }
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    }),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      d1OutboxStore(db),
      Layer.merge(GithubApplierLive, ActuatorRateLimitLive).pipe(Layer.provide(ports)),
      TestClock.layer(),
    ),
  );
  await runtime.runPromise(TestClock.setTime(now));
  const entry = profile.intent_kinds["verdict.record"]!;
  await insertOutboxRows(db, [
    {
      id: `acme/app/${INTENT_KEY}`,
      limitKey: deliveryLimitKey("verdict.record", "7"),
      tier: entry.delivery_tier,
      priority: entry.priority ?? 2,
      classRank: 1,
      drawsReserve: false,
      intent: {
        executionId: null,
        scopeId: "acme/app",
        intentKey: INTENT_KEY,
        kind: "verdict.record",
        payload,
        payloadDigest: "digest",
        effectClass: entry.effect_class,
        attempts: 0,
      },
      row: newRow({ effectClass: entry.effect_class, insertedAt: now }),
    },
  ]);
  const actuatorOf = actuatorBindings(profile.intent_kinds);
  const state = () =>
    db.sqlite.prepare("select state, external_ref from outbox").all() as {
      state: string;
      external_ref: string | null;
    }[];
  return {
    posts,
    quotaCalls,
    state,
    /** Outbox passes a minute apart until the row is applied. */
    drainAll: async () => {
      for (let pass = 0; pass < 20; pass++) {
        await runtime.runPromise(
          drainOnce({ now, token: (id) => `tok-${id}-${now}`, random: () => 0.5, actuatorOf }),
        );
        if (state()[0]?.state === "applied") return;
        now += MINUTE_MS;
        await runtime.runPromise(TestClock.setTime(now));
      }
      throw new Error("the record row was never applied");
    },
    dispose: () => runtime.dispose(),
  };
};

describe("a verdict record whose first delivery loses its answer", () => {
  it("[FD-GH-100] the drainer sends the replay-safe row again, and the repeat carries the first attempt's delivery id", async () => {
    const p = await plane();
    try {
      await p.drainAll();
      expect(p.posts).toHaveLength(2);
      const [first, repeat] = p.posts as [Post, Post];
      expect(repeat.at).toBeGreaterThan(first.at);
      const delivery = `ops/${INTENT_KEY}`;
      expect(first.headers.get("x-flare-dispatch-delivery")).toBe(delivery);
      expect(repeat.headers.get("x-flare-dispatch-delivery")).toBe(delivery);
      // Each attempt is signed afresh under its own timestamp, over the same record.
      expect(repeat.body).toBe(first.body);
      expect(JSON.parse(repeat.body)).toEqual(payload);
      for (const post of [first, repeat]) {
        const ts = post.headers.get("x-flare-dispatch-timestamp")!;
        expect(post.headers.get("x-flare-dispatch-signature")).toBe(
          `v1=${createHmac("sha256", SECRET).update(`${ts}.${post.body}`).digest("hex")}`,
        );
      }
      expect(repeat.headers.get("x-flare-dispatch-timestamp")).not.toBe(
        first.headers.get("x-flare-dispatch-timestamp"),
      );
      expect(p.state()).toEqual([{ state: "applied", external_ref: delivery }]);
      // Neither attempt drew a permit from, or reported to, an installation's quota (FD-GH-101).
      expect(p.quotaCalls).toEqual([]);
    } finally {
      await p.dispose();
    }
  });
});
