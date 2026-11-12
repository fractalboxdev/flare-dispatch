import { AdvisorySnapshots } from "@fractalboxdev/flare-dispatch-catalog";
import { profile } from "@fractalboxdev/flare-dispatch-profile";
import { Cause, Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADVISORY_ATTEMPT_LEASE_MS,
  ADVISORY_SNAPSHOT_STALE,
  checkAdvisorySnapshotsStale,
  d1AdvisorySnapshots,
  osvArchiveUrl,
  readSnapshotRecord,
  recordSnapshot,
  refreshAdvisorySnapshots,
  type AdvisoryWatch,
} from "./advisory.ts";
import { activeAlarms, alarmMessage, RUNBOOK } from "./alarms.ts";
import {
  archive,
  casBucket,
  osvServer,
  refreshPorts,
  sha256,
  type Published,
} from "./advisory.test-support.ts";
import { recordingAlarms, sqliteDb, type TestDb } from "./d1.test-support.ts";
import { minuteTick, type TickDeps } from "./tick.ts";

let t: TestDb;
beforeEach(async () => {
  t = await sqliteDb();
});
afterEach(() => t.dispose());

const HOUR = 3_600_000;
const DAY1 = Date.UTC(2026, 10, 12, 0, 0, 30);
const PUBLISHED = Date.UTC(2026, 10, 11, 22, 15);

const refresh = (
  server: ReturnType<typeof osvServer>,
  bucket: ReturnType<typeof casBucket>,
  ecosystems: readonly string[],
  now: number,
) => Effect.runPromiseExit(refreshAdvisorySnapshots(t.db, refreshPorts(server, bucket), ecosystems, now));

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe("advisory-refresh", () => {
  it("[FD-OPS-100] streams each scan.advisoryEcosystems archive from the OSV bucket into cas/<sha256> once per UTC day", async () => {
    const npm = archive("npm advisories");
    const pypi = archive("PyPI advisories");
    const published = new Map<string, Published>([
      ["npm", { bytes: npm, lastModified: PUBLISHED }],
      ["PyPI", { bytes: pypi, lastModified: PUBLISHED }],
    ]);
    const server = osvServer(published);
    const bucket = casBucket();

    const first = await refresh(server, bucket, ["npm", "PyPI"], DAY1);
    expect(Exit.isSuccess(first) && first.value.refreshed).toEqual(["npm", "PyPI"]);
    expect(osvArchiveUrl("npm")).toBe("https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip");
    expect(osvArchiveUrl("crates.io")).toBe(
      "https://osv-vulnerabilities.storage.googleapis.com/crates.io/all.zip",
    );
    // One read to learn the digest, one to store it at that key.
    expect(server.gets).toEqual([
      osvArchiveUrl("npm"),
      osvArchiveUrl("npm"),
      osvArchiveUrl("PyPI"),
      osvArchiveUrl("PyPI"),
    ]);
    expect([...bucket.objects.keys()].sort()).toEqual([`cas/${sha256(npm)}`, `cas/${sha256(pypi)}`].sort());
    expect(bucket.objects.get(`cas/${sha256(npm)}`)).toEqual(npm);
    expect(bucket.objects.get(`cas/${sha256(pypi)}`)).toEqual(pypi);

    // Every later tick of the same UTC day reads nothing.
    for (const at of [DAY1 + 60_000, DAY1 + 5 * HOUR, DAY1 + 23 * HOUR + 59 * 60_000]) {
      const again = await refresh(server, bucket, ["npm", "PyPI"], at);
      expect(Exit.isSuccess(again) && again.value.current).toEqual(["npm", "PyPI"]);
    }
    expect(server.gets).toHaveLength(4);

    // The first tick of the next UTC day stores the archive OSV published since.
    const npm2 = archive("npm advisories, day 2");
    published.set("npm", { bytes: npm2, lastModified: PUBLISHED + 24 * HOUR });
    const next = await refresh(server, bucket, ["npm", "PyPI"], DAY1 + 24 * HOUR);
    expect(Exit.isSuccess(next) && next.value.refreshed).toEqual(["npm", "PyPI"]);
    expect(bucket.objects.get(`cas/${sha256(npm2)}`)).toEqual(npm2);
    // PyPI's archive is unchanged, so its object already holds it and only the digest read is made.
    expect(server.gets.slice(4)).toEqual([
      osvArchiveUrl("npm"),
      osvArchiveUrl("npm"),
      osvArchiveUrl("PyPI"),
    ]);
    expect(bucket.puts.filter((k) => k === `cas/${sha256(pypi)}`)).toHaveLength(1);
  });

  it("[FD-OPS-101] records the object's digest and Last-Modified time as the ecosystem's snapshot only once every byte Content-Length names is stored", async () => {
    const bytes = archive("crates advisories");
    const server = osvServer(new Map([["crates.io", { bytes, lastModified: PUBLISHED }]]));
    const bucket = casBucket();
    expect(Exit.isSuccess(await refresh(server, bucket, ["crates.io"], DAY1))).toBe(true);
    expect(await readSnapshotRecord(t.db, "crates.io")).toEqual({
      ecosystem: "crates.io",
      digest: sha256(bytes),
      lastModified: PUBLISHED,
      size: bytes.length,
      refreshedAt: DAY1,
    });
    // The security gate reads that record as the ecosystem's snapshot.
    const read = await Effect.runPromise(
      Effect.flatMap(AdvisorySnapshots, (s) =>
        Effect.all([s.read("crates.io"), s.read("npm")]),
      ).pipe(Effect.provide(d1AdvisorySnapshots(t.db))),
    );
    expect(read).toEqual([
      { ecosystem: "crates.io", digest: sha256(bytes), lastModified: PUBLISHED },
      null,
    ]);

    // A body shorter than its Content-Length, a store that kept fewer bytes, or an answer naming no Content-Length or
    // Last-Modified records nothing.
    const cases: readonly [Published, ReturnType<typeof casBucket>, RegExp][] = [
      [{ bytes, lastModified: PUBLISHED, truncate: 10 }, casBucket(), /read 10 of the \d+ bytes/],
      [{ bytes, lastModified: PUBLISHED }, casBucket({ keepShort: true }), /stored \d+ of the \d+ bytes/],
      [{ bytes, lastModified: PUBLISHED, omitContentLength: true }, casBucket(), /no Content-Length/],
      [{ bytes, lastModified: PUBLISHED, omitLastModified: true }, casBucket(), /no Last-Modified/],
    ];
    for (const [p, b, detail] of cases) {
      const exit = await refresh(osvServer(new Map([["Go", p]])), b, ["Go"], DAY1);
      expect(failureOf(exit)).toMatchObject({ _tag: "AdvisoryRefreshIncomplete" });
      expect((failureOf(exit) as { failed: { detail: string }[] }).failed[0]!.detail).toMatch(detail);
      expect(await readSnapshotRecord(t.db, "Go")).toBeNull();
      await t.db.prepare("delete from fd_liveness where key = 'advisory-refresh:Go'").run();
    }
  });

  it("[FD-OPS-102] keeps an ecosystem's recorded snapshot unchanged when its refresh fails, and refreshes the others", async () => {
    const old = archive("npm day 1");
    const published = new Map<string, Published>([
      ["npm", { bytes: old, lastModified: PUBLISHED }],
      ["PyPI", { bytes: archive("PyPI day 1"), lastModified: PUBLISHED }],
    ]);
    const ok = await refresh(osvServer(published), casBucket(), ["npm", "PyPI"], DAY1);
    expect(Exit.isSuccess(ok)).toBe(true);
    const before = await readSnapshotRecord(t.db, "npm");

    const fresh = archive("npm day 2");
    const failures: readonly [string, Published, ReturnType<typeof casBucket>][] = [
      ["a 503", { bytes: fresh, lastModified: PUBLISHED + 24 * HOUR, status: 503 }, casBucket()],
      ["a reset", { bytes: fresh, lastModified: PUBLISHED + 24 * HOUR, status: "throws" }, casBucket()],
      ["a short body", { bytes: fresh, lastModified: PUBLISHED + 24 * HOUR, truncate: 3 }, casBucket()],
      ["a refused store", { bytes: fresh, lastModified: PUBLISHED + 24 * HOUR }, casBucket({ refuse: (key) => key === `cas/${sha256(fresh)}` })],
      [
        "an archive changed between its reads",
        {
          bytes: fresh,
          lastModified: PUBLISHED + 24 * HOUR,
          next: { bytes: archive("npm day 2, later"), lastModified: PUBLISHED + 25 * HOUR },
        },
        casBucket(),
      ],
    ];
    let at = DAY1 + 24 * HOUR;
    for (const [name, npm, bucket] of failures) {
      published.set("npm", npm);
      published.set("PyPI", { bytes: archive(`PyPI ${name}`), lastModified: PUBLISHED + 24 * HOUR });
      await t.db.prepare("delete from fd_advisory_snapshots where ecosystem = 'PyPI'").run();
      const exit = await refresh(osvServer(published), bucket, ["npm", "PyPI"], at);
      expect(failureOf(exit), name).toMatchObject({
        _tag: "AdvisoryRefreshIncomplete",
        failed: [{ ecosystem: "npm" }],
        refreshed: ["PyPI"],
      });
      expect(await readSnapshotRecord(t.db, "npm"), name).toEqual(before);
      expect(bucket.objects.has(`cas/${sha256(fresh)}`), name).toBe(false);
      at += ADVISORY_ATTEMPT_LEASE_MS;
    }

    // A tick inside the failed attempt's lease starts no second attempt; the first tick after it retries and records.
    published.set("npm", { bytes: fresh, lastModified: PUBLISHED + 24 * HOUR, status: 503 });
    const failedAt = at;
    expect(Exit.isFailure(await refresh(osvServer(published), casBucket(), ["npm"], failedAt))).toBe(true);
    published.set("npm", { bytes: fresh, lastModified: PUBLISHED + 24 * HOUR });
    const server = osvServer(published);
    const held = await refresh(server, casBucket(), ["npm"], failedAt + 60_000);
    expect(Exit.isSuccess(held) && held.value.attempting).toEqual(["npm"]);
    expect(server.gets).toEqual([]);
    const retried = await refresh(server, casBucket(), ["npm"], failedAt + ADVISORY_ATTEMPT_LEASE_MS);
    expect(Exit.isSuccess(retried) && retried.value.refreshed).toEqual(["npm"]);
    expect((await readSnapshotRecord(t.db, "npm"))?.digest).toBe(sha256(fresh));
  });
});

describe("advisory-snapshot-stale", () => {
  const NOW = Date.UTC(2026, 10, 12, 12, 0);
  const snapshot = (ecosystem: string, lastModified: number) =>
    recordSnapshot(t.db, ecosystem, { digest: sha256(archive(ecosystem)), lastModified, size: 9 }, NOW);
  const check = (watch: AdvisoryWatch, now: number, alarms: ReturnType<typeof recordingAlarms>) =>
    Effect.runPromise(checkAdvisorySnapshotsStale(t.db, watch, now).pipe(Effect.provide(alarms.layer)));

  it("[FD-OPS-103] raises the page alarm advisory-snapshot-stale while a scan.advisoryEcosystems entry has no snapshot or one older than scan.advisoryMaxAgeHours, and resolves it once every snapshot is fresh", async () => {
    const alarms = recordingAlarms();
    const watch = { ecosystems: ["npm", "PyPI"], maxAgeHours: 48 };
    await snapshot("npm", NOW - 10 * HOUR);

    // PyPI has no snapshot.
    const missing = await check(watch, NOW, alarms);
    expect(missing).toEqual({ stale: [{ ecosystem: "PyPI", lastModified: null }], alarm: "sent" });
    expect(alarms.delivered).toEqual([
      {
        name: ADVISORY_SNAPSHOT_STALE,
        severity: "page",
        dedupeKey: ADVISORY_SNAPSHOT_STALE,
        state: "raised",
        detail: { max_age_hours: 48, stale: [{ ecosystem: "PyPI", age_ms: null }] },
      },
    ]);
    // A page names its runbook entry, R17.
    expect(RUNBOOK[ADVISORY_SNAPSHOT_STALE]).toBe("R17");
    expect(alarmMessage(alarms.delivered[0]!)).toContain("runbook R17");
    expect(await activeAlarms(t.db)).toMatchObject([
      { name: ADVISORY_SNAPSHOT_STALE, severity: "page", runbook: "R17" },
    ]);

    // PyPI's snapshot is older than the allowed age: the alarm holds, sent at most once per 24 h.
    await snapshot("PyPI", NOW - 49 * HOUR);
    const old = await check(watch, NOW + 60_000, alarms);
    expect(old).toEqual({
      stale: [{ ecosystem: "PyPI", lastModified: NOW - 49 * HOUR }],
      alarm: "quiet",
    });
    expect(alarms.delivered).toHaveLength(1);

    // Age counts from Last-Modified: exactly the allowed age is not stale, and every snapshot fresh resolves it.
    await snapshot("PyPI", NOW + 120_000 - 48 * HOUR);
    expect(await check(watch, NOW + 120_000, alarms)).toEqual({ stale: [], alarm: "sent" });
    expect(alarms.delivered.map((a) => a.state)).toEqual(["raised", "resolved"]);
    expect(await activeAlarms(t.db)).toEqual([]);
    await snapshot("PyPI", NOW);
    expect(await check(watch, NOW + 180_000, alarms)).toEqual({ stale: [], alarm: "quiet" });

    // The setting decides the allowed age: npm's 10 h snapshot is stale under 6 h.
    const strict = await check({ ...watch, maxAgeHours: 6 }, NOW + 240_000, alarms);
    expect(strict.stale.map((s) => s.ecosystem)).toEqual(["npm"]);
    expect(alarms.delivered.at(-1)).toMatchObject({ state: "raised", severity: "page" });

    // An ecosystem the overlay no longer names is not watched: dropping npm resolves the alarm.
    expect(await check({ ecosystems: ["PyPI"], maxAgeHours: 6 }, NOW + 300_000, alarms)).toEqual({
      stale: [],
      alarm: "sent",
    });
    expect(alarms.delivered.map((a) => a.state)).toEqual([
      "raised",
      "resolved",
      "raised",
      "resolved",
    ]);
  });

  it("[FD-OPS-103] the minute tick runs the check after its units, so the tick's own advisory-refresh counts, and a failed watch read fails that step alone", async () => {
    const monitor = {
      idFromName: (name: string) => name,
      get: () => ({ start: async () => undefined }),
    };
    const env = { DB: t.db, MONITOR: monitor };
    const alarms = recordingAlarms();
    const deps = (over: Partial<TickDeps>): TickDeps => ({
      profile,
      alarmPort: alarms.layer,
      webhookSilentHours: 24,
      ...over,
    });
    const stepOf = async (d: TickDeps, now: number) =>
      (await Effect.runPromise(minuteTick(env, d, now))).steps.find(
        (s) => s.step === ADVISORY_SNAPSHOT_STALE,
      );
    const watch = { ecosystems: ["Go"], maxAgeHours: 48 };

    // Without a watch the check does not run.
    expect(await stepOf(deps({}), NOW)).toMatchObject({ status: "skipped" });
    expect(alarms.delivered).toEqual([]);

    // A unit that records the snapshot in the same tick leaves nothing stale.
    const refresh = {
      step: "advisory-refresh",
      effect: Effect.promise(() => snapshot("Go", NOW - HOUR)),
    };
    expect(await stepOf(deps({ advisory: watch, units: () => [refresh] }), NOW)).toMatchObject({
      status: "ran",
      detail: { stale: [], alarm: "quiet" },
    });
    expect(alarms.delivered).toEqual([]);

    // A day later the snapshot is past the allowed age and the tick pages; the watch may be a read.
    expect(
      await stepOf(deps({ advisory: Effect.succeed(watch) }), NOW + 48 * HOUR),
    ).toMatchObject({ status: "ran", detail: { alarm: "sent" } });
    expect(alarms.delivered).toMatchObject([
      { name: ADVISORY_SNAPSHOT_STALE, severity: "page", state: "raised" },
    ]);

    const report = await Effect.runPromise(
      minuteTick(env, deps({ advisory: Effect.fail("ADVISORY_MAX_AGE_HOURS malformed") }), NOW + 49 * HOUR),
    );
    expect(report.steps.find((s) => s.step === ADVISORY_SNAPSHOT_STALE)?.status).toBe("failed");
    expect(report.steps.find((s) => s.step === "record-tick")?.status).toBe("ran");
  });
});
