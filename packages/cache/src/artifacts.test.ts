// The artifact store against Miniflare's R2 and D1. Parts go up through the R2 binding here, where an executor
// would use the presigned UploadPart URLs; the fake presigner records what those URLs sign.
import { Effect, Exit, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  artifactPage,
  artifactPath,
  artifactSubjectRetention,
  beginArtifactUpload,
  commitArtifact,
  findArtifact,
  multipartPlan,
  newArtifactId,
  recordDeviceArtifact,
  serveArtifact,
  sweepArtifacts,
  validArtifactName,
  type ArtifactRead,
  type BeginArtifact,
} from "./artifacts.ts";
import { canonicalJson, utf8 } from "./crypto.ts";
import { GiB, MiB } from "./ledger.ts";
import {
  applyLogAppend,
  LogAppendStatus,
  LogAppendStore,
  RepositoryVisibility,
  SubjectRetention,
  SubjectRetentionFailed,
  TransparencyLogs,
} from "./provenance/append.ts";
import {
  memoryLogAppendStore,
  recordedStatementLogged,
} from "./provenance/append.test-support.ts";
import { unsignedEnvelope } from "./provenance/dsse.ts";
import type { Bucket } from "./manifest.ts";
import {
  EXEC,
  emptyBucket,
  failureOf,
  layers,
  lease,
  signerFor,
  signingKeys,
  startMiniflare,
  world,
  type World,
} from "./support.test-support.ts";

let mf: Awaited<ReturnType<typeof startMiniflare>>;
let bucket: Bucket;
let db: D1Database;
let keys: Awaited<ReturnType<typeof signingKeys>>;
beforeAll(async () => {
  mf = await startMiniflare();
  bucket = mf.bucket;
  db = mf.db;
  keys = await signingKeys();
});
afterAll(async () => mf?.mf.dispose());
beforeEach(async () => {
  await emptyBucket(bucket);
  await db.prepare("delete from fd_artifacts").run();
  await db.prepare("delete from artifact_uploads").run();
});

const SHA = "a".repeat(64);
const run = <A, E>(w: World, effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect);
const provide = (w: World) => Effect.provide(layers(w, bucket, signerFor(keys.pair.privateKey), db));
const begin = (w: World, frame: Partial<BeginArtifact> = {}) =>
  run(w, beginArtifactUpload({ execution_id: EXEC, epoch: 2, name: "report.html", size: 5, sha256: SHA, content_type: "text/html", ...frame }).pipe(provide(w)));
const commit = (w: World, frame: { name?: string; epoch?: number; parts?: { part_number: number; etag: string }[] } = {}, retention = {}) =>
  run(w, commitArtifact({ execution_id: EXEC, epoch: 2, name: "report.html", ...frame }, { repo: "acme/widgets", private: true }, retention).pipe(provide(w)));
const value = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
  return exit.value;
};

const deps = (w: World, terminal = true) => ({
  db,
  bucket,
  now: () => w.now,
  terminal: async () => terminal,
});
const read = async (w: World, id: string, terminal = true) =>
  serveArtifact(new Request(`http://x/v1/artifacts/${id}`), (await findArtifact(deps(w), id))!, undefined, deps(w, terminal));
const served = (r: ArtifactRead) => {
  expect(r).toMatchObject({ _tag: "Served" });
  return (r as Extract<ArtifactRead, { _tag: "Served" }>).response;
};

describe("artifacts", () => {
  it("[FD-CACHE-068] [FD-CACHE-069] a committed artifact records one row with a 128-bit random id", async () => {
    const w = world();
    value(await begin(w));
    await bucket.put(artifactPath(EXEC, 2, "report.html"), "<p/>!");
    const ack = value(await commit(w));
    expect(ack).toMatchObject({ status: "accepted" });
    const id = (ack as { artifact_id: string }).artifact_id;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const row = await db.prepare("select * from fd_artifacts where artifact_id = ?").bind(id).first();
    expect(row).toMatchObject({
      execution_id: EXEC,
      epoch: 2,
      name: "report.html",
      size: 5,
      sha256: SHA,
      content_type: "text/html",
      producer_executor_id: "cf-1",
      producer_executor_kind: "cloudflare",
      expires_at: w.now + 30 * 24 * 3600 * 1000,
    });
    // A second commit of the same upload answers duplicate with the same id.
    expect(value(await commit(w))).toEqual({ status: "duplicate", artifact_id: id });
  });

  it("[FD-CACHE-070] a name outside the grammar or with a .. segment is InvalidArtifactName", async () => {
    for (const bad of ["../x", "a/../b", "/abs", ".hidden", "a//b", "x".repeat(201), "sp ace"])
      expect(validArtifactName(bad)).toBe(false);
    for (const good of ["report.html", "coverage/lcov.info", "a-b_c.d"]) expect(validArtifactName(good)).toBe(true);
    expect(failureOf(await begin(world(), { name: "a/../b" }))).toMatchObject({ _tag: "InvalidArtifactName" });
  });

  it("[FD-CACHE-071] an artifact commit at an epoch other than the current one is stale", async () => {
    const w = world();
    value(await begin(w));
    await bucket.put(artifactPath(EXEC, 2, "report.html"), "<p/>!");
    expect(value(await commit(w, { epoch: 1 }))).toEqual({ status: "stale" });
    expect(value(await begin(w, { epoch: 3 }))).toEqual({ status: "stale" });
    expect((await db.prepare("select count(*) as n from fd_artifacts").first<{ n: number }>())?.n).toBe(0);
  });

  it("[FD-CACHE-072] a body of at most 16 MiB gets one PUT; a larger one a multipart upload completed with the part ETags", async () => {
    const w = world();
    const small = value(await begin(w, { size: 16 * MiB }));
    expect(small).toMatchObject({ status: "ok", upload_id: null, urls: [{ part_number: null, length: 16 * MiB }] });
    const size = 17 * MiB;
    const big = value(await begin(w, { name: "bundle.zip", size }));
    if (big.status !== "ok") throw new Error("stale");
    expect(big.upload_id).not.toBeNull();
    expect(big.urls.map((u) => u.length)).toEqual([8 * MiB, 8 * MiB, 1 * MiB]);
    expect(w.signed.slice(1).map((s) => s.query)).toEqual([1, 2, 3].map((n) => ({ partNumber: String(n), uploadId: big.upload_id })));
    const upload = bucket.resumeMultipartUpload(artifactPath(EXEC, 2, "bundle.zip"), big.upload_id!);
    const parts = [];
    for (const u of big.urls) {
      const part = await upload.uploadPart(u.part_number!, new Uint8Array(u.length));
      parts.push({ part_number: part.partNumber, etag: part.etag });
    }
    expect(value(await commit(w, { name: "bundle.zip", parts }))).toMatchObject({ status: "accepted" });
    expect((await bucket.head(artifactPath(EXEC, 2, "bundle.zip")))?.size).toBe(size);
    expect(multipartPlan(40 * GiB, 8 * MiB).length).toBeLessThanOrEqual(10_000);
    const plan = multipartPlan(100 * MiB + 3, 8 * MiB);
    expect(new Set(plan.slice(0, -1).map((p) => p.length)).size).toBe(1);
  });

  it("[FD-CACHE-073] a browse expansion with an entry over 32 MiB, over 256 MiB in total or over 4000 entries is ArtifactTooLarge", async () => {
    const w = world();
    for (const browse of [
      [{ path: "a", size: 32 * MiB + 1 }],
      Array.from({ length: 9 }, (_, i) => ({ path: `f${i}`, size: 30 * MiB })),
      Array.from({ length: 4001 }, (_, i) => ({ path: `f${i}`, size: 1 })),
    ])
      expect(failureOf(await begin(w, { browse }))).toMatchObject({ _tag: "ArtifactTooLarge" });
    const ok = value(await begin(w, { browse: [{ path: "index.html", size: 3 }] }));
    expect(ok.status === "ok" && ok.urls.some((u) => u.path === "index.html")).toBe(true);
  });

  it("[FD-CACHE-074] an execution's artifacts past 2 GiB are ArtifactTooLarge", async () => {
    const w = world();
    value(await begin(w, { name: "a.bin", size: GiB }));
    value(await begin(w, { name: "b.bin", size: GiB }));
    expect(failureOf(await begin(w, { name: "c.bin", size: 1 }))).toMatchObject({ _tag: "ArtifactTooLarge" });
  });

  it("[FD-CACHE-075] an artifact is served immutable once its execution is terminal, uncached while it runs", async () => {
    const w = world();
    value(await begin(w));
    await bucket.put(artifactPath(EXEC, 2, "report.html"), "<p/>!");
    const { artifact_id: id } = value(await commit(w)) as { artifact_id: string };
    const done = served(await read(w, id));
    expect(await done.text()).toBe("<p/>!");
    expect(done.headers.get("cache-control")).toContain("immutable");
    expect(served(await read(w, id, false)).headers.get("cache-control")).toBe("no-store");
  });

  it("[FD-CACHE-078] the listing pages at most 100 rows with a cursor and lists rows only", async () => {
    const w = world();
    for (let i = 0; i < 120; i++)
      await db
        .prepare(`insert into fd_artifacts values (?1, ?2, 2, ?3, 1, ?4, 'text/plain', 'cf-1', 'cloudflare', 'acme/widgets', 0, ?5, 1, 0, ?6)`)
        .bind(i.toString(16).padStart(32, "0"), EXEC, `f${i}`, SHA, artifactPath(EXEC, 2, `f${i}`), w.now + 1000)
        .run();
    await bucket.put(`${artifactPath(EXEC, 2, "f0")}.browse/index.html`, "x");
    const all = async () => true;
    const page = await artifactPage(deps(w), EXEC, { limit: 500, cursor: "" }, all);
    expect(page.artifacts).toHaveLength(100);
    const next = await artifactPage(deps(w), EXEC, { limit: 100, cursor: page.cursor! }, all);
    expect(next.artifacts).toHaveLength(20);
    expect(next.cursor).toBeNull();
    expect(JSON.stringify(next)).not.toContain("index.html");
  });

  it("[FD-CACHE-079] the sweep deletes an artifact, its expansion and its row once expires_at passes; provenance extends it", async () => {
    const w = world();
    value(await begin(w, { browse: [{ path: "index.html", size: 1 }] }));
    await bucket.put(artifactPath(EXEC, 2, "report.html"), "<p/>!");
    await bucket.put(`${artifactPath(EXEC, 2, "report.html")}.browse/index.html`, "x");
    value(await commit(w));
    value(await begin(w, { name: "kept.txt" }));
    await bucket.put(artifactPath(EXEC, 2, "kept.txt"), "12345");
    value(await commit(w, { name: "kept.txt" }, { extendedMs: 90 * 24 * 3600 * 1000 }));
    expect((await sweepArtifacts(db, bucket, w.now + 29 * 24 * 3600 * 1000)).deleted).toBe(0);
    expect((await sweepArtifacts(db, bucket, w.now + 31 * 24 * 3600 * 1000)).deleted).toBe(1);
    expect(await bucket.head(artifactPath(EXEC, 2, "report.html"))).toBeNull();
    expect(await bucket.head(`${artifactPath(EXEC, 2, "report.html")}.browse/index.html`)).toBeNull();
    expect(await bucket.head(artifactPath(EXEC, 2, "kept.txt"))).not.toBeNull();
  });

  describe("a logged statement's subjects", () => {
    const DAY = 24 * 3600 * 1000;
    const NAMED = "b".repeat(64);
    const OTHER = "c".repeat(64);

    /**
     * A pending log-append intent of `executionId` whose test-result statement, bound to the lease at `epoch`, names
     * each of `subjects` by its name and its bytes' SHA-256.
     */
    const intentNaming = (
      executionId: string,
      subjects: readonly { readonly name: string; readonly sha256: string }[],
      epoch = 2,
    ) => {
      const envelope = canonicalJson(
        unsignedEnvelope(
          utf8(
            JSON.stringify({
              _type: "https://in-toto.io/Statement/v1",
              subject: subjects.map((s) => ({ name: s.name, digest: { sha256: s.sha256 } })),
              predicateType: "https://in-toto.io/attestation/test-result/v0.1",
              predicate: {
                result: "PASSED",
                configuration: [{ name: "lease", annotations: { execution_id: executionId, epoch } }],
              },
            }),
          ),
        ),
      );
      return {
        envelopeDigest: `sha256:${"e".repeat(64)}`,
        executionId,
        repository: "acme/widgets",
        log: "private" as const,
        envelope,
        verifiers: [],
        status: LogAppendStatus.Pending({ attempts: 0, nextAttemptAt: 0, lastError: null }),
      };
    };

    /** Logs the intent into a private log whose integrated time is `integratedTime`, over the artifact rows in D1. */
    const logAt = (
      intent: ReturnType<typeof intentNaming>,
      integratedTime: number,
      retention: SubjectRetention["Service"],
      store = memoryLogAppendStore(new Map([[intent.envelopeDigest, intent]])),
    ) =>
      Effect.runPromise(
        applyLogAppend(intent.envelopeDigest, integratedTime).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(LogAppendStore, store),
              Layer.succeed(RepositoryVisibility, { of: () => Effect.succeed("private") }),
              Layer.succeed(TransparencyLogs, {
                rekor: () => Effect.die("the repository is private"),
                private: () =>
                  Effect.succeed({ log: "private" as const, logIndex: 0, entryId: "leaf-0", integratedTime }),
              }),
              Layer.succeed(SubjectRetention, retention),
              recordedStatementLogged(),
            ),
          ),
        ),
      );

    const commitDigest = async (w: World, name: string, sha256: string) => {
      value(await begin(w, { name, sha256 }));
      await bucket.put(artifactPath(EXEC, 2, name), "12345");
      return (value(await commit(w, { name })) as { artifact_id: string }).artifact_id;
    };
    const expiresAt = async (id: string) =>
      (await db.prepare("select expires_at from fd_artifacts where artifact_id = ?").bind(id).first<{ expires_at: number }>())!
        .expires_at;

    it("[FD-PROV-075] logging a statement keeps each artifact it names until its integrated time plus 400 days, and the sweep spares it", async () => {
      const w = world();
      const named = await commitDigest(w, "app.tar", NAMED);
      const unnamed = await commitDigest(w, "notes.txt", OTHER);
      const integratedTime = w.now + 5 * DAY;
      const logged = await logAt(intentNaming(EXEC, [{ name: "app.tar", sha256: NAMED }]), integratedTime, artifactSubjectRetention(db));
      expect(LogAppendStatus.$is("Logged")(logged!.status)).toBe(true);
      expect(await expiresAt(named)).toBe(integratedTime + 400 * DAY);
      expect(await expiresAt(unnamed)).toBe(w.now + 30 * DAY);
      expect((await sweepArtifacts(db, bucket, w.now + 31 * DAY)).deleted).toBe(1);
      expect(await bucket.head(artifactPath(EXEC, 2, "app.tar"))).not.toBeNull();
      expect(await bucket.head(artifactPath(EXEC, 2, "notes.txt"))).toBeNull();
      expect((await sweepArtifacts(db, bucket, integratedTime + 400 * DAY - 1)).deleted).toBe(0);
    });

    it("[FD-PROV-075] the statement retention the overlay sets replaces the default, and a later expires_at stays", async () => {
      const w = world();
      const named = await commitDigest(w, "app.tar", NAMED);
      await logAt(intentNaming(EXEC, [{ name: "app.tar", sha256: NAMED }]), w.now, artifactSubjectRetention(db, 90));
      expect(await expiresAt(named)).toBe(w.now + 90 * DAY);
      // A shorter retention never shortens what an earlier statement extended.
      await logAt(intentNaming(EXEC, [{ name: "app.tar", sha256: NAMED }]), w.now, artifactSubjectRetention(db, 45));
      expect(await expiresAt(named)).toBe(w.now + 90 * DAY);
    });

    it("[FD-PROV-075] keeps the artifact a statement names even where the digest the executor declared at upload differs from its bytes", async () => {
      const w = world();
      // The executor declares OTHER; the bytes it uploads hash to something else, which the commit does not check.
      const named = await commitDigest(w, "app.tar", OTHER);
      const bytes = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", utf8("12345"))),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      expect(bytes).not.toBe(OTHER);
      // The cloud builder's subject carries the digest of the bytes in R2.
      await logAt(intentNaming(EXEC, [{ name: "app.tar", sha256: bytes }]), w.now, artifactSubjectRetention(db));
      expect(await expiresAt(named)).toBe(w.now + 400 * DAY);
      expect((await sweepArtifacts(db, bucket, w.now + 31 * DAY)).deleted).toBe(0);
      expect(await bucket.head(artifactPath(EXEC, 2, "app.tar"))).not.toBeNull();
    });

    it("[FD-PROV-075] a statement bound to another epoch keeps the artifact of that name at its own epoch, not this one", async () => {
      const w = world();
      const named = await commitDigest(w, "app.tar", NAMED);
      await logAt(intentNaming(EXEC, [{ name: "app.tar", sha256: NAMED }], 3), w.now, artifactSubjectRetention(db));
      expect(await expiresAt(named)).toBe(w.now + 30 * DAY);
    });

    it("[FD-PROV-075] another execution's artifact with the same digest keeps its own retention", async () => {
      const w = world();
      const named = await commitDigest(w, "app.tar", NAMED);
      await logAt(intentNaming("01JOTHEREXECUTION00000000", [{ name: "app.tar", sha256: NAMED }]), w.now, artifactSubjectRetention(db));
      expect(await expiresAt(named)).toBe(w.now + 30 * DAY);
    });

    it("[FD-PROV-075] a failed retention leaves the statement pending, and the retried append extends the artifact", async () => {
      const w = world();
      const named = await commitDigest(w, "app.tar", NAMED);
      const intent = intentNaming(EXEC, [{ name: "app.tar", sha256: NAMED }]);
      const store = memoryLogAppendStore(new Map([[intent.envelopeDigest, intent]]));
      const failing: SubjectRetention["Service"] = {
        retain: () => Effect.fail(new SubjectRetentionFailed({ message: "D1 unavailable" })),
      };
      const first = await logAt(intent, w.now, failing, store);
      expect(LogAppendStatus.$is("Pending")(first!.status)).toBe(true);
      expect(await expiresAt(named)).toBe(w.now + 30 * DAY);
      const retried = await logAt(intent, w.now + 5_000, artifactSubjectRetention(db), store);
      expect(LogAppendStatus.$is("Logged")(retried!.status)).toBe(true);
      expect(await expiresAt(named)).toBe(w.now + 5_000 + 400 * DAY);
    });
  });

  it("[FD-CACHE-080] a confidential-compute execution keeps the artifact on the device and the row holds no R2 path", async () => {
    const w = world([lease({ confidential: true, executorKind: "device", executorId: "dev-1" })]);
    expect(failureOf(await begin(w))).toMatchObject({ status: 403 });
    const id = value(
      await run(w, recordDeviceArtifact({ execution_id: EXEC, epoch: 2, name: "r.txt", size: 3, sha256: SHA, content_type: "text/plain" }, { executorId: "dev-1", executorKind: "device" }, { repo: "acme/widgets", private: false }).pipe(provide(w))),
    );
    const row = await db.prepare("select r2_path, producer_executor_id from fd_artifacts where artifact_id = ?").bind(id).first();
    expect(row).toEqual({ r2_path: null, producer_executor_id: "dev-1" });
    expect(await read(w, id)).toEqual({ _tag: "OnExecutor", artifactId: id, executorId: "dev-1" });
  });

  it("[FD-CACHE-069] ids are distinct across many artifacts", () => {
    const ids = new Set(Array.from({ length: 1000 }, newArtifactId));
    expect(ids.size).toBe(1000);
  });
});
