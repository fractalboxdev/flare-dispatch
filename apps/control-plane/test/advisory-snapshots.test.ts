// The minute tick's `advisory-refresh` step over the Worker's ports (specs/operability.md FD-OPS-100, FD-OPS-101),
// and the `advisory-snapshot-stale` watch the tick reads from the rendered vars (FD-OPS-103).
// Node has no `crypto.DigestStream` or `FixedLengthStream`, so the suite passes stream constructors that behave as
// they do: a SHA-256 sink and a pass-through that errors unless exactly its length passes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import {
  checkAdvisorySnapshotsStale,
  parseJsonc,
  placeholderOverlay,
  readSnapshotRecord,
  recordSnapshot,
  renderTemplate,
  runOpsMigrations,
  type AdvisoryWatch,
} from "@fractalboxdev/flare-dispatch-ops";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  archive,
  osvServer,
  sha256,
  type Published,
} from "../../../packages/ops/src/advisory.test-support.ts";
import { recordingAlarms } from "../../../packages/ops/src/d1.test-support.ts";
import {
  advisoryRefreshStep,
  advisoryWatchOf,
  workerAdvisoryPorts,
  type AdvisoryBucket,
  type StreamRuntime,
} from "../src/advisory-snapshots.ts";
import type { ControlPlaneEnv } from "../src/config.ts";
import { tickDeps } from "../src/tick.ts";

const nodeStreams: StreamRuntime = {
  digestStream: () => {
    const hash = createHash("sha256");
    let resolve!: (d: ArrayBuffer) => void;
    const digest = new Promise<ArrayBuffer>((r) => (resolve = r));
    const sink = new WritableStream<Uint8Array>({
      write: (chunk) => void hash.update(chunk),
      close: () => resolve(new Uint8Array(hash.digest()).buffer),
    });
    return Object.assign(sink, { digest });
  },
  fixedLength: (length) => {
    let seen = 0;
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > length) throw new Error("FixedLengthStream: too many bytes");
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== length) throw new Error("FixedLengthStream: too few bytes");
      },
    });
  },
};

/** An R2 bucket that, as R2 does, refuses a put whose bytes' SHA-256 differs from the one it names. */
const r2 = () => {
  const objects = new Map<string, Uint8Array>();
  const bucket: AdvisoryBucket = {
    head: async (key) => {
      const o = objects.get(key);
      return o === undefined ? null : { size: o.length };
    },
    put: async (key, body, { sha256: expected }) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== expected)
        throw new Error("put: The SHA-256 checksum you specified did not match what we received.");
      objects.set(key, bytes);
      return { size: bytes.length };
    },
  };
  return { bucket, objects };
};

const DAY = Date.UTC(2026, 10, 12, 0, 1);
const PUBLISHED = Date.UTC(2026, 10, 11, 21, 0);

const envOf = async (over: Partial<Record<keyof ControlPlaneEnv, unknown>> = {}) => {
  const DB = await migratedD1();
  await runOpsMigrations(DB);
  return { DB, ...over } as unknown as ControlPlaneEnv;
};

describe("the tick's advisory-refresh step", () => {
  it("stores each ADVISORY_ECOSYSTEMS archive in the CACHE bucket at cas/<sha256> once per UTC day", async () => {
    const npm = archive("npm");
    const go = archive("Go");
    const server = osvServer(
      new Map<string, Published>([
        ["npm", { bytes: npm, lastModified: PUBLISHED }],
        ["Go", { bytes: go, lastModified: PUBLISHED }],
      ]),
    );
    const cache = r2();
    // Wrangler delivers the rendered list as an array, a `.dev.vars` entry as its JSON text.
    for (const ecosystems of [["npm", "Go"], JSON.stringify(["npm", "Go"])]) {
      const env = await envOf({ CACHE: cache.bucket, ADVISORY_ECOSYSTEMS: ecosystems });
      const step = (now: number) =>
        advisoryRefreshStep(env, now, (b) => workerAdvisoryPorts(b, nodeStreams, server.fetch));
      expect(step(DAY).step).toBe("advisory-refresh");
      const ran = await Effect.runPromise(step(DAY).effect);
      expect(ran).toMatchObject({ refreshed: ["npm", "Go"] });
      expect(cache.objects.get(`cas/${sha256(npm)}`)).toEqual(npm);
      expect(cache.objects.get(`cas/${sha256(go)}`)).toEqual(go);
      expect(await readSnapshotRecord(env.DB, "Go")).toMatchObject({
        digest: sha256(go),
        lastModified: PUBLISHED,
      });
      const gets = server.gets.length;
      expect(await Effect.runPromise(step(DAY + 6 * 3_600_000).effect)).toMatchObject({
        current: ["npm", "Go"],
      });
      expect(server.gets).toHaveLength(gets);
    }
  });

  it("[FD-OPS-101] records no snapshot where the Worker stored fewer bytes than Content-Length names", async () => {
    const bytes = archive("PyPI");
    const server = osvServer(
      new Map<string, Published>([["PyPI", { bytes, lastModified: PUBLISHED, truncate: 5 }]]),
    );
    const cache = r2();
    const env = await envOf({ CACHE: cache.bucket, ADVISORY_ECOSYSTEMS: ["PyPI"] });
    const exit = await Effect.runPromiseExit(
      advisoryRefreshStep(env, DAY, (b) => workerAdvisoryPorts(b, nodeStreams, server.fetch)).effect,
    );
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
      _tag: "AdvisoryRefreshIncomplete",
      failed: [{ ecosystem: "PyPI" }],
    });
    expect(await readSnapshotRecord(env.DB, "PyPI")).toBeNull();
    expect(cache.objects.size).toBe(0);
  });

  it("runs on every minute tick, stores nothing where the overlay names no ecosystem, and fails without a CACHE bucket or with a malformed list", async () => {
    const env = await envOf({ DEPLOYMENT: "production", PLANE_ID: "plane" });
    const unit = tickDeps(env)
      .units!(DAY)
      .find((u) => u.step === "advisory-refresh");
    expect(unit).toBeDefined();
    expect(await Effect.runPromise(unit!.effect)).toEqual({
      refreshed: [],
      current: [],
      attempting: [],
    });

    const unbound = await envOf({ ADVISORY_ECOSYSTEMS: ["npm"] });
    const exit = await Effect.runPromiseExit(advisoryRefreshStep(unbound, DAY).effect);
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
      _tag: "AdvisoryStoreUnbound",
      ecosystems: ["npm"],
    });

    for (const bad of ["npm", "[1]", '[""]', { npm: true }]) {
      const malformed = await envOf({ CACHE: r2().bucket, ADVISORY_ECOSYSTEMS: bad });
      const e = await Effect.runPromiseExit(advisoryRefreshStep(malformed, DAY).effect);
      expect(Exit.isFailure(e) && Cause.squash(e.cause)).toMatchObject({
        _tag: "ConfigInvalid",
        path: "ADVISORY_ECOSYSTEMS",
      });
    }
  });
});

describe("the tick's advisory-snapshot-stale watch", () => {
  it("[FD-OPS-103] the tick watches the rendered scan.advisoryEcosystems against scan.advisoryMaxAgeHours, 48 where the overlay sets none, and pages while a snapshot is missing or older", async () => {
    const template = readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8");
    const varsOf = async (scan: Record<string, unknown>) =>
      parseJsonc(
        await Effect.runPromise(
          renderTemplate("control-plane", template, { ...placeholderOverlay, scan } as never),
        ),
      )["vars"] as Record<string, unknown>;
    const watchRead = (env: ControlPlaneEnv) =>
      tickDeps(env).advisory as Effect.Effect<AdvisoryWatch, unknown>;
    const watchOf = (env: ControlPlaneEnv) => Effect.runPromise(watchRead(env));

    const defaults = await envOf(await varsOf({ advisoryEcosystems: ["npm"] }));
    expect(defaults.ADVISORY_MAX_AGE_HOURS).toBe(48);
    expect(await watchOf(defaults)).toEqual({ ecosystems: ["npm"], maxAgeHours: 48 });
    const set = await envOf(await varsOf({ advisoryEcosystems: ["npm"], advisoryMaxAgeHours: 12 }));
    expect(await watchOf(set)).toEqual({ ecosystems: ["npm"], maxAgeHours: 12 });
    // A `.dev.vars` entry arrives as text; an unset var is the default.
    expect(await Effect.runPromise(advisoryWatchOf({ ADVISORY_MAX_AGE_HOURS: "6" }))).toEqual({
      ecosystems: [],
      maxAgeHours: 6,
    });

    // The watch the tick reads pages while npm has no snapshot, and resolves once it has a fresh one.
    const alarms = recordingAlarms();
    const check = (now: number) =>
      Effect.runPromise(
        watchRead(set).pipe(
          Effect.flatMap((watch) => checkAdvisorySnapshotsStale(set.DB, watch, now)),
          Effect.provide(alarms.layer),
        ),
      );
    expect(await check(DAY)).toMatchObject({ alarm: "sent" });
    await recordSnapshot(set.DB, "npm", { digest: sha256(archive("npm")), lastModified: PUBLISHED, size: 9 }, DAY);
    expect(await check(DAY + 60_000)).toMatchObject({ alarm: "sent" });
    expect(alarms.delivered.map((a) => [a.name, a.severity, a.state])).toEqual([
      ["advisory-snapshot-stale", "page", "raised"],
      ["advisory-snapshot-stale", "page", "resolved"],
    ]);

    // A malformed var fails the watch rather than widening or guessing it.
    for (const bad of ["two days", 0, -1, 1.5, {}]) {
      const exit = await Effect.runPromiseExit(advisoryWatchOf({ ADVISORY_MAX_AGE_HOURS: bad }));
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
        _tag: "ConfigInvalid",
        path: "ADVISORY_MAX_AGE_HOURS",
      });
    }
  });
});
