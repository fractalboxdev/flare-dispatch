// The advisory snapshot store (specs/operability.md § Scan bundle and advisory snapshot, FD-OPS-100 to FD-OPS-102):
// the `advisory-refresh` step streams each `scan.advisoryEcosystems` entry's OSV `all.zip` archive into
// `cas/<sha256>` once per UTC day, and records the archive's digest and `Last-Modified` time as that ecosystem's
// snapshot only after the store holds every byte the response's `Content-Length` names. A failed refresh records
// nothing, so the ecosystem keeps the snapshot it had. The security gate reads the record through the catalogue's
// `AdvisorySnapshots` port (specs/runs/gate.md FD-GATE-106, FD-GATE-107).
//
// While an `scan.advisoryEcosystems` entry has no recorded snapshot, or one whose `Last-Modified` time is older than
// `scan.advisoryMaxAgeHours`, the minute tick raises the page alarm `advisory-snapshot-stale`, and resolves it once
// every entry's snapshot is fresh (FD-OPS-103).
//
// The digest names the object's key, and it is known only once the archive has been read to its end, so the step
// reads the archive twice: once to hash and count it, and once to store it at `cas/<digest>`, where the store refuses
// bytes of any other SHA-256 or length. An object already at that key with the archive's length is not stored again.
import { contentObjectKey } from "@fractalboxdev/flare-dispatch-cache/namespaces";
import {
  AdvisorySnapshots,
  AdvisorySnapshotUnreadable,
  snapshotStale,
  type AdvisorySnapshot,
} from "@fractalboxdev/flare-dispatch-catalog";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Layer, Schema } from "effect";
import { track } from "./raise.ts";

/** Each ecosystem's recorded snapshot; one row per ecosystem, replaced only by a complete refresh. */
export const ADVISORY_SNAPSHOTS_MIGRATION = `create table if not exists fd_advisory_snapshots (
    ecosystem text primary key,
    digest text not null,
    last_modified integer not null,
    size integer not null,
    refreshed_at integer not null)`;

/** The OSV archive of one ecosystem. */
export const osvArchiveUrl = (ecosystem: string): string =>
  `https://osv-vulnerabilities.storage.googleapis.com/${encodeURIComponent(ecosystem)}/all.zip`;

/**
 * How long one refresh attempt holds its ecosystem: a tick within it starts no second attempt, so a refresh that
 * outlasts a minute is not run twice at once, and a failed one is retried after it.
 */
export const ADVISORY_ATTEMPT_LEASE_MS = 15 * 60_000;

const DAY_MS = 86_400_000;

/** The UTC day of an epoch-ms time. */
export const utcDayOf = (at: number): number => Math.floor(at / DAY_MS);

/** One ecosystem's refresh failed; its recorded snapshot is unchanged (FD-OPS-102). */
export class AdvisoryRefreshFailed extends Schema.TaggedError<AdvisoryRefreshFailed>()(
  "AdvisoryRefreshFailed",
  { ecosystem: Schema.String, detail: Schema.String },
) {}

/** The step's refreshes that failed, after every other ecosystem's was attempted. */
export class AdvisoryRefreshIncomplete extends Schema.TaggedError<AdvisoryRefreshIncomplete>()(
  "AdvisoryRefreshIncomplete",
  {
    failed: Schema.Array(Schema.Struct({ ecosystem: Schema.String, detail: Schema.String })),
    refreshed: Schema.Array(Schema.String),
  },
) {}

/** What the archive's GET answers: a `fetch` `Response` satisfies it. */
export interface AdvisoryResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

/** The I/O a refresh makes. The Worker backs it with `fetch`, `crypto.DigestStream` and the `CACHE` bucket. */
export interface AdvisoryRefreshPorts {
  readonly fetch: (url: string) => Promise<AdvisoryResponse>;
  /** Reads a stream to its end: its SHA-256 as lowercase hex and the number of bytes it held. */
  readonly sha256: (
    body: ReadableStream<Uint8Array>,
  ) => Promise<{ readonly digest: string; readonly bytes: number }>;
  readonly bucket: {
    /** The object at `key`, or `null` where none exists. */
    readonly head: (key: string) => Promise<{ readonly size: number } | null>;
    /**
     * Stores `body` at `key`, refusing it unless it holds exactly `length` bytes whose SHA-256 is `sha256`; answers the
     * stored object, or `null` where the store kept nothing.
     */
    readonly put: (
      key: string,
      body: ReadableStream<Uint8Array>,
      expected: { readonly length: number; readonly sha256: string },
    ) => Promise<{ readonly size: number } | null>;
  };
}

/** One ecosystem's archive as stored: its digest, its `Last-Modified` time in epoch ms and its size. */
export interface StoredArchive {
  readonly digest: string;
  readonly lastModified: number;
  readonly size: number;
}

/**
 * Streams one ecosystem's archive into `cas/<sha256>` (FD-OPS-100). It answers the stored archive only once the store
 * holds every byte `Content-Length` names; a non-200 answer, a missing or malformed `Content-Length` or
 * `Last-Modified`, a short body, an archive that changed between its two reads, or a store that kept other than that
 * many bytes fails it.
 */
export const refreshEcosystem = (
  ports: AdvisoryRefreshPorts,
  ecosystem: string,
): Effect.Effect<StoredArchive, AdvisoryRefreshFailed> => {
  const url = osvArchiveUrl(ecosystem);
  const failed = (detail: string) => new AdvisoryRefreshFailed({ ecosystem, detail });
  const io = <A>(stage: string, f: () => Promise<A>) =>
    Effect.tryPromise({ try: f, catch: (e) => failed(`${stage}: ${String(e)}`) });
  const discard = (body: ReadableStream<Uint8Array> | null) =>
    Effect.promise(() => body?.cancel().catch(() => undefined) ?? Promise.resolve());
  const open = Effect.gen(function* () {
    const response = yield* io("fetch", () => ports.fetch(url));
    const length = response.headers.get("content-length");
    const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
    const problem =
      response.status !== 200
        ? `GET ${url} answered ${response.status}`
        : length === null || !/^\d+$/.test(length)
          ? `GET ${url} named no Content-Length`
          : Number.isNaN(lastModified)
            ? `GET ${url} named no Last-Modified time`
            : response.body === null
              ? `GET ${url} answered no body`
              : null;
    if (problem !== null) {
      yield* discard(response.body);
      return yield* failed(problem);
    }
    return { length: Number(length), lastModified, body: response.body! };
  });
  return Effect.gen(function* () {
    const first = yield* open;
    const read = yield* io("read", () => ports.sha256(first.body));
    if (read.bytes !== first.length)
      return yield* failed(
        `read ${read.bytes} of the ${first.length} bytes Content-Length names`,
      );
    const key = contentObjectKey(read.digest);
    const held = yield* io("head", () => ports.bucket.head(key));
    if (held?.size !== first.length) {
      const second = yield* open;
      if (second.length !== first.length || second.lastModified !== first.lastModified) {
        yield* discard(second.body);
        return yield* failed("the archive changed between its digest read and its store");
      }
      const stored = yield* io("store", () =>
        ports.bucket.put(key, second.body, { length: first.length, sha256: read.digest }),
      );
      if (stored?.size !== first.length)
        return yield* failed(
          `stored ${stored?.size ?? 0} of the ${first.length} bytes Content-Length names`,
        );
    }
    return { digest: read.digest, lastModified: first.lastModified, size: first.length };
  });
};

interface SnapshotRow {
  readonly ecosystem: string;
  readonly digest: string;
  readonly last_modified: number;
  readonly size: number;
  readonly refreshed_at: number;
}

/** An ecosystem's recorded snapshot with its size and the time the refresh recorded it. */
export interface SnapshotRecord extends AdvisorySnapshot {
  readonly size: number;
  readonly refreshedAt: number;
}

/** The recorded snapshot of `ecosystem`, or `null` where none is recorded. */
export const readSnapshotRecord = async (
  db: D1Like,
  ecosystem: string,
): Promise<SnapshotRecord | null> => {
  const { results } = await db
    .prepare(
      "select ecosystem, digest, last_modified, size, refreshed_at from fd_advisory_snapshots where ecosystem = ?",
    )
    .bind(ecosystem)
    .all();
  const row = results[0] as SnapshotRow | undefined;
  return row === undefined
    ? null
    : {
        ecosystem: row.ecosystem,
        digest: row.digest,
        lastModified: row.last_modified,
        size: row.size,
        refreshedAt: row.refreshed_at,
      };
};

/** Records `archive` as the snapshot of `ecosystem`, replacing the one it had (FD-OPS-101). */
export const recordSnapshot = (db: D1Like, ecosystem: string, archive: StoredArchive, now: number) =>
  db
    .prepare(
      `insert into fd_advisory_snapshots (ecosystem, digest, last_modified, size, refreshed_at)
       values (?, ?, ?, ?, ?)
       on conflict (ecosystem) do update set digest = excluded.digest, last_modified = excluded.last_modified,
         size = excluded.size, refreshed_at = excluded.refreshed_at`,
    )
    .bind(ecosystem, archive.digest, archive.lastModified, archive.size, now)
    .run();

/** The security gate's read of the recorded snapshots; a failed read is `AdvisorySnapshotUnreadable`. */
export const d1AdvisorySnapshots = (db: D1Like): Layer.Layer<AdvisorySnapshots> =>
  Layer.succeed(AdvisorySnapshots, {
    read: (ecosystem) =>
      Effect.tryPromise({
        try: async () => {
          const record = await readSnapshotRecord(db, ecosystem);
          return record === null
            ? null
            : { ecosystem, digest: record.digest, lastModified: record.lastModified };
        },
        catch: (e) => new AdvisorySnapshotUnreadable({ ecosystem, detail: String(e) }),
      }),
  });

const attemptKey = (ecosystem: string) => `advisory-refresh:${ecosystem}`;

const readAttempt = (db: D1Like, ecosystem: string) =>
  Effect.promise(async () => {
    const { results } = await db
      .prepare("select at from fd_liveness where key = ?")
      .bind(attemptKey(ecosystem))
      .all();
    return (results[0] as { at: number } | undefined)?.at ?? null;
  });

const writeAttempt = (db: D1Like, ecosystem: string, at: number) =>
  Effect.promise(() =>
    db
      .prepare(
        "insert into fd_liveness (key, at) values (?, ?) on conflict (key) do update set at = excluded.at",
      )
      .bind(attemptKey(ecosystem), at)
      .run(),
  );

/** What one `advisory-refresh` step did for each ecosystem. */
export interface AdvisoryRefreshReport {
  /** Ecosystems whose archive this step stored and recorded. */
  readonly refreshed: readonly string[];
  /** Ecosystems already recorded on the current UTC day. */
  readonly current: readonly string[];
  /** Ecosystems another attempt still holds. */
  readonly attempting: readonly string[];
}

/**
 * The `advisory-refresh` step at `now` (FD-OPS-100 to FD-OPS-102). The minute tick runs it, and it refreshes only an
 * ecosystem with no snapshot recorded on the current UTC day, so each ecosystem is stored once per UTC day. Every
 * ecosystem is attempted; a failed one keeps its recorded snapshot, and the step fails after them all, naming it.
 */
export const refreshAdvisorySnapshots = (
  db: D1Like,
  ports: AdvisoryRefreshPorts,
  ecosystems: readonly string[],
  now: number,
): Effect.Effect<AdvisoryRefreshReport, AdvisoryRefreshIncomplete> =>
  Effect.gen(function* () {
    const refreshed: string[] = [];
    const current: string[] = [];
    const attempting: string[] = [];
    const failed: { ecosystem: string; detail: string }[] = [];
    for (const ecosystem of new Set(ecosystems)) {
      const record = yield* Effect.promise(() => readSnapshotRecord(db, ecosystem));
      if (record !== null && utcDayOf(record.refreshedAt) === utcDayOf(now)) {
        current.push(ecosystem);
        continue;
      }
      const attempt = yield* readAttempt(db, ecosystem);
      if (attempt !== null && now - attempt < ADVISORY_ATTEMPT_LEASE_MS) {
        attempting.push(ecosystem);
        continue;
      }
      yield* writeAttempt(db, ecosystem, now);
      yield* refreshEcosystem(ports, ecosystem).pipe(
        Effect.flatMap((archive) =>
          Effect.promise(() => recordSnapshot(db, ecosystem, archive, now)),
        ),
        Effect.match({
          onSuccess: () => void refreshed.push(ecosystem),
          onFailure: (e) => void failed.push({ ecosystem, detail: e.detail }),
        }),
      );
    }
    if (failed.length > 0) return yield* new AdvisoryRefreshIncomplete({ failed, refreshed });
    return { refreshed, current, attempting };
  });

/** The page alarm a missing or stale advisory snapshot raises; runbook R17 handles it (FD-OPS-103). */
export const ADVISORY_SNAPSHOT_STALE = "advisory-snapshot-stale";

/** What the staleness check watches: `scan.advisoryEcosystems` and `scan.advisoryMaxAgeHours`. */
export interface AdvisoryWatch {
  readonly ecosystems: readonly string[];
  readonly maxAgeHours: number;
}

/** A watched ecosystem whose snapshot is missing (`lastModified` `null`) or older than the allowed age. */
export interface StaleSnapshot {
  readonly ecosystem: string;
  readonly lastModified: number | null;
}

/**
 * The watched ecosystems at `now` that have no recorded snapshot, or one whose `Last-Modified` time is older than
 * `maxAgeHours`, in the order `watch` names them.
 */
export const staleAdvisorySnapshots = async (
  db: D1Like,
  watch: AdvisoryWatch,
  now: number,
): Promise<readonly StaleSnapshot[]> => {
  const stale: StaleSnapshot[] = [];
  for (const ecosystem of new Set(watch.ecosystems)) {
    const record = await readSnapshotRecord(db, ecosystem);
    if (record === null) stale.push({ ecosystem, lastModified: null });
    else if (snapshotStale(record, now, watch.maxAgeHours))
      stale.push({ ecosystem, lastModified: record.lastModified });
  }
  return stale;
};

/**
 * The `advisory-snapshot-stale` check at `now` (FD-OPS-103): raises the page alarm while any watched ecosystem's
 * snapshot is missing or older than `scan.advisoryMaxAgeHours`, naming each such ecosystem, and resolves it once none
 * is. One dedupe key covers every ecosystem, so the alarm repeats at most once per 24 h while any stays stale.
 */
export const checkAdvisorySnapshotsStale = (db: D1Like, watch: AdvisoryWatch, now: number) =>
  Effect.gen(function* () {
    const stale = yield* Effect.promise(() => staleAdvisorySnapshots(db, watch, now));
    const alarm = yield* track(
      db,
      {
        name: ADVISORY_SNAPSHOT_STALE,
        severity: "page",
        dedupeKey: ADVISORY_SNAPSHOT_STALE,
        detail: {
          max_age_hours: watch.maxAgeHours,
          stale: stale.map((s) => ({
            ecosystem: s.ecosystem,
            age_ms: s.lastModified === null ? null : now - s.lastModified,
          })),
        },
      },
      stale.length > 0,
      now,
    );
    return { stale, alarm };
  });
