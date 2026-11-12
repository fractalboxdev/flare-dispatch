// The security gate's scan bundle read on Miniflare's R2 (specs/runs/gate.md FD-GATE-100): the scan bundle store reads
// `cas/<scan.bundleDigest>` from the deployment's `CACHE` bucket under workerd, and the scan runs only on bytes whose
// SHA-256 is that digest.
import {
  bucketScanBundleStore,
  Outcome,
  runScan,
  type ContentBucket,
  type PreparedScan,
} from "@fractalboxdev/flare-dispatch-catalog";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  digestOf,
  envelopeBytes,
  fakeScanImage,
  IMAGE_VERSIONS,
  memoryAdvisorySnapshots,
  signingKey,
  validPayload,
} from "../../catalog/src/scan-bundle.test-support.ts";

let mf: Miniflare;
let bucket: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch: () => new Response(null, { status: 404 }) };",
    r2Buckets: ["CACHE"],
  });
  bucket = await mf.getR2Bucket("CACHE");
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

const scan = async (pin: string) => {
  const prepared: PreparedScan[] = [];
  const outcome = await Effect.runPromise(
    runScan({ pin, changedPaths: [], now: Date.now(), advisoryMaxAgeHours: 24 }, (p) =>
      Effect.sync(() => (prepared.push(p), Outcome.success())),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          bucketScanBundleStore(bucket as unknown as ContentBucket),
          fakeScanImage(IMAGE_VERSIONS, ["semgrep"]),
          memoryAdvisorySnapshots().layer,
        ),
      ),
    ),
  );
  return { outcome, prepared };
};

describe("scan bundle read on R2", () => {
  it("[FD-GATE-100] reads the scan bundle from cas/<scan.bundleDigest> in the CACHE bucket and verifies its bytes' SHA-256 against that digest", async () => {
    const bytes = await envelopeBytes(validPayload(), [await signingKey("bundle-2026")]);
    const digest = await digestOf(bytes);
    await bucket.put(`cas/${digest}`, bytes);
    const read = await scan(digest);
    expect(read.outcome).toEqual(Outcome.success());
    expect(read.prepared[0]!.bundle.digest).toBe(digest);

    // An object stored under the pin whose bytes hash to another digest runs no scanner.
    const other = await envelopeBytes({ ...validPayload(), version: "other" }, []);
    const pin = "e".repeat(64);
    await bucket.put(`cas/${pin}`, other);
    const tampered = await scan(pin);
    expect(tampered.outcome).toEqual({ _tag: "failure", reason: "config: scan bundle digest" });
    expect(tampered.prepared).toEqual([]);

    // A pin whose object the bucket lacks.
    const absent = await scan("d".repeat(64));
    expect(absent.outcome).toEqual({ _tag: "failure", reason: "config: scan bundle missing" });
    expect(absent.prepared).toEqual([]);
  });
});
