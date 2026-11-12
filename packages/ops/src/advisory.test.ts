import { AdvisorySnapshots } from "@fractalboxdev/flare-dispatch-catalog";
import { Cause, Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADVISORY_ATTEMPT_LEASE_MS,
  d1AdvisorySnapshots,
  osvArchiveUrl,
  readSnapshotRecord,
  refreshAdvisorySnapshots,
} from "./advisory.ts";
import {
  archive,
  casBucket,
  osvServer,
  refreshPorts,
  sha256,
  type Published,
} from "./advisory.test-support.ts";
import { sqliteDb, type TestDb } from "./d1.test-support.ts";

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
