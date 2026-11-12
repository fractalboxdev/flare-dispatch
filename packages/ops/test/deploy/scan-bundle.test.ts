// The deploy suite of `V-DEPLOY` for the scan bundle (specs/operability.md § Scan bundle and advisory snapshot,
// FD-OPS-094 to FD-OPS-097, FD-OPS-099): `fd deploy` and `fd doctor` on the fakes of `support.ts`, the live target
// reading the envelope the overlay pins from the deploy host's files. A deploy whose envelope fails verification stops in
// the drift stage before any write, so the account keeps the Workers, and the pin, of the last deploy; a deploy whose
// envelope verifies writes it to `cas/<scan.bundleDigest>` before its first other write.
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  digestOf,
  envelopeBytes,
  keyEntry,
  signingKey,
  validPayload,
  type SigningKey,
} from "../../../catalog/src/scan-bundle.test-support.ts";
import { placeholderOverlay, type OverlayValues } from "../../src/index.ts";
import { API, deploy, fd, isWrite, ROOT, world, type World } from "./support.ts";

const HOUR = 3_600_000;
const FILE = "deploy/scan-bundle.dsse.json";
const READ = `read ${join(ROOT, FILE)}`;
/** The path of the cache bucket's objects in the R2 object API. */
const CAS = `${API}/r2/buckets/${placeholderOverlay.r2["CACHE"]}/objects`;

type Report = { readonly ok: boolean; readonly stages: readonly { stage: string; ok: boolean; detail: string }[] };
const driftDetail = (report: Report) => report.stages.find((s) => s.stage === "drift")?.detail ?? "";

const overlayWith = (scan: OverlayValues["scan"]) => JSON.stringify({ ...placeholderOverlay, scan });

/** A world whose deploy host holds `bytes` at `FILE`. */
const hostWith = (bytes: Uint8Array, w: World = world()) => {
  w.localFiles.set(join(ROOT, FILE), bytes);
  return w;
};

const signedBy = async (key: SigningKey, payload: unknown = validPayload()) => {
  const bytes = await envelopeBytes(payload, [key]);
  return { bytes, digest: await digestOf(bytes) };
};

/** `fd deploy` and `fd doctor` both stop at the drift stage with no write, each naming every one of `expected`. */
const refused = async (w: World, overlay: string, expected: readonly string[]) => {
  const before = w.snapshot();
  const from = w.calls.length;
  const deployed = await deploy(w, overlay);
  expect(deployed.ok).toBe(false);
  expect(deployed.stages.at(-1)!.stage).toBe("drift");
  const doctor = await Effect.runPromise(fd(w).doctor(overlay));
  expect(doctor.ok).toBe(false);
  expect(w.calls.slice(from).filter(isWrite)).toEqual([]);
  expect(w.snapshot()).toBe(before);
  for (const text of expected) {
    expect(driftDetail(deployed)).toContain(text);
    expect(driftDetail(doctor)).toContain(text);
  }
};

describe("fd deploy over the scan bundle", () => {
  it("[FD-OPS-094] verifies the envelope at scan.bundleFile in the drift stage, before the first write, and deploys a verified one", async () => {
    const key = await signingKey("bundle-2026");
    const { bytes, digest } = await signedBy(key);
    const now = Date.now();
    const w = hostWith(bytes);
    const overlay = overlayWith({
      bundleDigest: digest,
      bundleFile: FILE,
      bundleKeys: [keyEntry(key, now - HOUR, now + HOUR)],
    });
    const report = await deploy(w, overlay);
    expect(report.ok).toBe(true);
    const read = w.calls.indexOf(READ);
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(w.calls.findIndex(isWrite));
    expect((await Effect.runPromise(fd(w).doctor(overlay))).ok).toBe(true);
    // A pinned digest whose envelope file the deploy host lacks.
    await refused(world(), overlay, [`scan.bundleFile: no envelope at ${FILE}`]);
  });

  it("[FD-OPS-094] reads no envelope where the overlay pins no scan.bundleDigest", async () => {
    const w = world();
    expect((await deploy(w, overlayWith({ bundleFile: FILE }))).ok).toBe(true);
    expect(w.calls.some((c) => c.startsWith("read "))).toBe(false);
  });

  it("[FD-OPS-099] writes the verified envelope to cas/<scan.bundleDigest> in the cache bucket after the drift check and before any migration or Worker deploy", async () => {
    const key = await signingKey("bundle-2026");
    const { bytes, digest } = await signedBy(key);
    const now = Date.now();
    const w = hostWith(bytes);
    const overlay = overlayWith({
      bundleDigest: digest,
      bundleFile: FILE,
      bundleKeys: [keyEntry(key, now - HOUR, now + HOUR)],
    });
    const report = await deploy(w, overlay);
    expect(report.ok).toBe(true);
    expect(report.stages.map((s) => s.stage).slice(2, 5)).toEqual(["drift", "scan-bundle", "migrations"]);
    expect(report.stages.find((s) => s.stage === "scan-bundle")!.detail).toBe(`cas/${digest}`);
    // The stored object is the envelope's exact bytes, at the key a scan reads it from (FD-GATE-100).
    expect([...w.cacheObjects.keys()]).toEqual([`cas/${digest}`]);
    expect(Buffer.from(w.cacheObjects.get(`cas/${digest}`)!).equals(Buffer.from(bytes))).toBe(true);
    // The drift check's reads, then the write, then every other write.
    const put = w.calls.indexOf(`PUT api.cloudflare.com${CAS}/cas/${digest}`);
    expect(put).toBeGreaterThan(w.calls.indexOf(READ));
    expect(put).toBeGreaterThan(w.calls.indexOf("GET api.github.com/repos/acme/fd/rules/branches/main"));
    expect(w.calls.filter(isWrite)[0]).toBe(`PUT api.cloudflare.com${CAS}/cas/${digest}`);
    expect(w.calls.findIndex((c) => c.startsWith("wrangler "))).toBeGreaterThan(put);
  });

  it("[FD-OPS-099] stops at the scan bundle write, before any migration or Worker deploy, when the envelope cannot be stored", async () => {
    const key = await signingKey("bundle-2026");
    const { bytes, digest } = await signedBy(key);
    const now = Date.now();
    const w = hostWith(bytes);
    w.state.cacheWriteFails = true;
    const report = await deploy(
      w,
      overlayWith({
        bundleDigest: digest,
        bundleFile: FILE,
        bundleKeys: [keyEntry(key, now - HOUR, now + HOUR)],
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.stages.map((s) => [s.stage, s.ok]).slice(2)).toEqual([
      ["drift", true],
      ["scan-bundle", false],
    ]);
    expect(w.calls.filter((c) => c.startsWith("wrangler "))).toEqual([]);
    expect(w.scripts.size).toBe(0);
  });

  it("[FD-OPS-099] writes no envelope where the overlay pins no scan.bundleDigest, or where the drift check fails", async () => {
    const unpinned = world();
    const passed = await deploy(unpinned, overlayWith({ bundleFile: FILE }));
    expect(passed.ok).toBe(true);
    expect(passed.stages.find((s) => s.stage === "scan-bundle")).toEqual({
      stage: "scan-bundle",
      ok: true,
      detail: "",
    });
    expect(unpinned.calls.some((c) => c.includes(CAS))).toBe(false);
    expect(unpinned.cacheObjects.size).toBe(0);
    // A verified envelope whose deploy another drift finding stops.
    const key = await signingKey("bundle-2026");
    const { bytes, digest } = await signedBy(key);
    const now = Date.now();
    const drifted = hostWith(bytes);
    drifted.state.required = [];
    const report = await deploy(
      drifted,
      overlayWith({
        bundleDigest: digest,
        bundleFile: FILE,
        bundleKeys: [keyEntry(key, now - HOUR, now + HOUR)],
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.stages.at(-1)!.stage).toBe("drift");
    expect(drifted.calls.some((c) => c.includes(CAS))).toBe(false);
    expect(drifted.cacheObjects.size).toBe(0);
  });

  it("[FD-OPS-095] refuses a deploy whose envelope only an expired, not-yet-valid or removed key signed, and the account keeps the previous deploy and its pin", async () => {
    const key = await signingKey("bundle-2026");
    const next = await signingKey("bundle-2027");
    const first = await signedBy(key);
    const now = Date.now();
    const w = hostWith(first.bytes);
    expect(
      (
        await deploy(
          w,
          overlayWith({
            bundleDigest: first.digest,
            bundleFile: FILE,
            bundleKeys: [keyEntry(key, now - HOUR, now + HOUR)],
          }),
        )
      ).ok,
    ).toBe(true);
    // A redeploy of the same envelope once its key's window has closed, or with the key removed from the list.
    for (const bundleKeys of [
      [keyEntry(key, now - 2 * HOUR, now - HOUR)],
      [keyEntry(key, now + HOUR, now + 2 * HOUR)],
      [keyEntry(next, now - HOUR, now + HOUR)],
    ])
      await refused(w, overlayWith({ bundleDigest: first.digest, bundleFile: FILE, bundleKeys }), [
        "scan.bundleKeys: no ",
      ]);
  });

  it("[FD-OPS-096] refuses a deploy whose envelope's SHA-256 differs from scan.bundleDigest", async () => {
    const key = await signingKey("bundle-2026");
    const { bytes, digest } = await signedBy(key);
    const now = Date.now();
    const pinned = "f".repeat(64);
    await refused(
      hostWith(bytes),
      overlayWith({
        bundleDigest: pinned,
        bundleFile: FILE,
        bundleKeys: [keyEntry(key, now - HOUR, now + HOUR)],
      }),
      [`scan.bundleDigest: the envelope's SHA-256 is ${digest}, not scan.bundleDigest ${pinned}`],
    );
  });

  it("[FD-OPS-097] refuses a deploy whose payload fails the scan bundle schema, naming the first failing path", async () => {
    const key = await signingKey("bundle-2026");
    const base = validPayload();
    const { bytes, digest } = await signedBy(key, {
      ...base,
      suppression: { files: [".gitleaksignore"], markers: [] },
    });
    const now = Date.now();
    await refused(
      hostWith(bytes),
      overlayWith({
        bundleDigest: digest,
        bundleFile: FILE,
        bundleKeys: [keyEntry(key, now - HOUR, now + HOUR)],
      }),
      ["scan.bundleFile: the payload fails the scan bundle schema at suppression.files: lacks osv-scanner.toml"],
    );
  });
});
