// The artifact store against Miniflare's R2 and D1. Parts go up through the R2 binding here, where an executor
// would use the presigned UploadPart URLs; the fake presigner records what those URLs sign.
import { Effect, Exit } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_TOKEN_LABEL,
  artifactPath,
  beginArtifactUpload,
  commitArtifact,
  handleArtifacts,
  multipartPlan,
  newArtifactId,
  recordDeviceArtifact,
  signArtifactToken,
  sweepArtifacts,
  validArtifactName,
  type BeginArtifact,
} from "./artifacts.ts";
import { GiB, MiB } from "./ledger.ts";
import { verifyCapability } from "./logs.ts";
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
  await db.prepare("delete from artifacts").run();
  await db.prepare("delete from artifact_uploads").run();
});

const SHA = "a".repeat(64);
const SECRET = "artifact-secret";
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

const deps = (w: World, terminal = true, viewer = false) => ({
  db,
  bucket,
  secret: SECRET,
  now: () => w.now,
  terminal: async () => terminal,
  viewerMayRead: async () => viewer,
});

describe("artifacts", () => {
  it("[FD-CACHE-068] [FD-CACHE-069] a committed artifact records one row with a 128-bit random id", async () => {
    const w = world();
    value(await begin(w));
    await bucket.put(artifactPath(EXEC, 2, "report.html"), "<p/>!");
    const ack = value(await commit(w));
    expect(ack).toMatchObject({ status: "accepted" });
    const id = (ack as { artifact_id: string }).artifact_id;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const row = await db.prepare("select * from artifacts where artifact_id = ?").bind(id).first();
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
    expect((await db.prepare("select count(*) as n from artifacts").first<{ n: number }>())?.n).toBe(0);
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

  it("[FD-CACHE-075] [FD-CACHE-076] [FD-CACHE-077] a private artifact is 404 without a viewer or a token for its id, and immutable once terminal", async () => {
    const w = world();
    value(await begin(w));
    await bucket.put(artifactPath(EXEC, 2, "report.html"), "<p/>!");
    const { artifact_id: id } = value(await commit(w)) as { artifact_id: string };
    const url = `http://x/v1/artifacts/${id}`;
    expect((await handleArtifacts(new Request(url), deps(w)))?.status).toBe(404);
    const token = await signArtifactToken(SECRET, id, w.now + 30 * 24 * 3600 * 1000, w.now);
    const served = (await handleArtifacts(new Request(`${url}?token=${token}`), deps(w)))!;
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("<p/>!");
    expect(served.headers.get("cache-control")).toContain("immutable");
    const running = (await handleArtifacts(new Request(url), deps(w, false, true)))!;
    expect(running.status).toBe(200);
    expect(running.headers.get("cache-control")).toBe("no-store");
    // A token for another artifact, or one past its expiry, is 404 too.
    const other = await signArtifactToken(SECRET, "0".repeat(32), w.now + 1000, w.now);
    expect((await handleArtifacts(new Request(`${url}?token=${other}`), deps(w)))?.status).toBe(404);
    w.now += 8 * 24 * 3600 * 1000;
    expect(await verifyCapability(SECRET, ARTIFACT_TOKEN_LABEL, id, token, w.now)).toBe(false);
    // The log label does not verify an artifact token.
    expect(await verifyCapability(SECRET, "flare-dispatch/log/v1", id, token, w.now - 8 * 24 * 3600 * 1000)).toBe(false);
  });

  it("[FD-CACHE-078] the listing pages at most 100 rows with a cursor and lists rows only", async () => {
    const w = world();
    for (let i = 0; i < 120; i++)
      await db
        .prepare(`insert into artifacts values (?1, ?2, 2, ?3, 1, ?4, 'text/plain', 'cf-1', 'cloudflare', 'acme/widgets', 0, ?5, 1, 0, ?6)`)
        .bind(i.toString(16).padStart(32, "0"), EXEC, `f${i}`, SHA, artifactPath(EXEC, 2, `f${i}`), w.now + 1000)
        .run();
    await bucket.put(`${artifactPath(EXEC, 2, "f0")}.browse/index.html`, "x");
    const page = (await (await handleArtifacts(new Request(`http://x/v1/executions/${EXEC}/artifacts?limit=500`), deps(w)))!.json()) as { artifacts: unknown[]; cursor: string };
    expect(page.artifacts).toHaveLength(100);
    const next = (await (await handleArtifacts(new Request(`http://x/v1/executions/${EXEC}/artifacts?cursor=${page.cursor}`), deps(w)))!.json()) as { artifacts: unknown[]; cursor: string | null };
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

  it("[FD-CACHE-080] a confidential-compute execution keeps the artifact on the device and the row holds no R2 path", async () => {
    const w = world([lease({ confidential: true, executorKind: "device", executorId: "dev-1" })]);
    expect(failureOf(await begin(w))).toMatchObject({ status: 403 });
    const id = value(
      await run(w, recordDeviceArtifact({ execution_id: EXEC, epoch: 2, name: "r.txt", size: 3, sha256: SHA, content_type: "text/plain" }, { executorId: "dev-1", executorKind: "device" }, { repo: "acme/widgets", private: false }).pipe(provide(w))),
    );
    const row = await db.prepare("select r2_path, producer_executor_id from artifacts where artifact_id = ?").bind(id).first();
    expect(row).toEqual({ r2_path: null, producer_executor_id: "dev-1" });
    const served = (await handleArtifacts(new Request(`http://x/v1/artifacts/${id}`), deps(w)))!;
    expect(await served.json()).toEqual({ artifact_id: id, kept_on_executor: "dev-1" });
  });

  it("[FD-CACHE-069] ids are distinct across many artifacts", () => {
    const ids = new Set(Array.from({ length: 1000 }, newArtifactId));
    expect(ids.size).toBe(1000);
  });
});
