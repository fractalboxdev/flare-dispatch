import { createHash } from "node:crypto";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { D1Binding } from "../local/store.ts";
import { stagedBlobName, type ManifestEntry } from "../staged-write/manifest.ts";
import { StagedWriteReadFailed, WritebackRecords } from "./applier.ts";
import { writebackRecordsLayer, type ArtifactObjects } from "./records.ts";
import { artifactPath, memoryBucket, recordsDb } from "./records.test-support.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const enc = (text: string) => new TextEncoder().encode(text);

const layer = (db: D1Binding, bucket: ArtifactObjects | undefined) =>
  writebackRecordsLayer({
    db,
    artifacts: bucket,
    artifactPath,
    issuedCredentials: () => Effect.succeed(["cc3.issued"]),
  });

const run = <A>(
  effect: Effect.Effect<A, StagedWriteReadFailed, WritebackRecords>,
  db: D1Binding,
  bucket: ArtifactObjects | undefined,
) => Effect.runPromise(Effect.result(effect.pipe(Effect.provide(layer(db, bucket)))));

const entry = (path: string, bytes: Uint8Array): ManifestEntry => ({
  path,
  mode: "100644",
  digest: sha256(bytes),
});

describe("writebackRecordsLayer", () => {
  it("[FD-AGT-013] reads each blob back byte for byte from the accepted epoch, with the digest of the bytes read", async () => {
    const db = recordsDb();
    db.exec(
      "insert into placements values ('x1', 'accepted', 3, 'e1', 2); insert into executors values ('e1', 'cloudflare')",
    );
    const binary = Uint8Array.from([0, 255, 10, 13, 128]);
    const text = enc("# A\r\n");
    const bucket = memoryBucket();
    bucket.objects.set(artifactPath("x1", 2, stagedBlobName(sha256(binary))), binary);
    bucket.objects.set(artifactPath("x1", 2, stagedBlobName(sha256(text))), text);
    bucket.objects.set(artifactPath("x1", 3, stagedBlobName(sha256(text))), enc("stale epoch"));
    const answer = await run(
      Effect.flatMap(WritebackRecords, (r) =>
        r.blobs("x1", [entry("bin.dat", binary), entry("a.md", text), entry("b.md", text)]),
      ),
      db,
      bucket,
    );
    expect(answer._tag).toBe("Success");
    const blobs = answer._tag === "Success" ? answer.success : [];
    expect(blobs.map((b) => [b.path, b.digest, b.size, b.text])).toEqual([
      ["bin.dat", sha256(binary), 5, null],
      ["a.md", sha256(text), 5, "# A\r\n"],
      ["b.md", sha256(text), 5, "# A\r\n"],
    ]);
    expect(blobs[0]?.bytes).toEqual(binary);
  });

  it("[FD-AGT-013] reports the digest of the stored bytes, not the key they are stored under", async () => {
    const db = recordsDb();
    db.exec("insert into placements values ('x1', 'accepted', 1, null, 1)");
    const bucket = memoryBucket();
    const claimed = enc("claimed\n");
    bucket.objects.set(artifactPath("x1", 1, stagedBlobName(sha256(claimed))), enc("swapped\n"));
    const answer = await run(
      Effect.flatMap(WritebackRecords, (r) => r.blobs("x1", [entry("a.md", claimed)])),
      db,
      bucket,
    );
    expect(answer._tag === "Success" && answer.success[0]?.digest).toBe(sha256(enc("swapped\n")));
  });

  it("[FD-AGT-013] leaves out a blob the store does not hold, and fails without a placement or a bucket", async () => {
    const db = recordsDb();
    db.exec("insert into placements values ('x1', 'accepted', 1, null, 1)");
    const missing = await run(
      Effect.flatMap(WritebackRecords, (r) => r.blobs("x1", [entry("a.md", enc("a"))])),
      db,
      memoryBucket(),
    );
    expect(missing).toMatchObject({ _tag: "Success", success: [] });
    const unplaced = await run(
      Effect.flatMap(WritebackRecords, (r) => r.blobs("x2", [entry("a.md", enc("a"))])),
      db,
      memoryBucket(),
    );
    expect(unplaced).toMatchObject({ _tag: "Failure", failure: { source: "placements" } });
    const unbound = await run(
      Effect.flatMap(WritebackRecords, (r) => r.blobs("x1", [entry("a.md", enc("a"))])),
      db,
      undefined,
    );
    expect(unbound).toMatchObject({ _tag: "Failure", failure: { source: "artifacts" } });
  });

  it("answers a gateway model call as true, a cloud placement without one as false, and fails on a device", async () => {
    const db = recordsDb();
    db.exec(`insert into executors values ('c1', 'cloudflare'), ('d1', 'device');
      insert into placements values ('called', 'accepted', 1, 'd1', 1), ('cloud', 'accepted', 1, 'c1', 1),
        ('device', 'accepted', 1, 'd1', 1);
      insert into model_calls values ('m1', 'called')`);
    const calls = (id: string) =>
      run(
        Effect.flatMap(WritebackRecords, (r) => r.modelCalls(id)),
        db,
        memoryBucket(),
      );
    expect(await calls("called")).toMatchObject({ _tag: "Success", success: true });
    expect(await calls("cloud")).toMatchObject({ _tag: "Success", success: false });
    expect(await calls("device")).toMatchObject({ _tag: "Failure", failure: { source: "device" } });
  });
});
