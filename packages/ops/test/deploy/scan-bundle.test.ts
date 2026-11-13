// The deploy suite of `V-DEPLOY` for the scan bundle (specs/operability.md § Scan bundle and advisory snapshot,
// FD-OPS-094 to FD-OPS-097): `fd deploy` and `fd doctor` on the fakes of `support.ts`, the live target reading the
// envelope the overlay pins from the deploy host's files. A deploy whose envelope fails verification stops in the drift
// stage before any write, so the account keeps the Workers, and the pin, of the last deploy.
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
import { deploy, fd, isWrite, ROOT, world, type World } from "./support.ts";

const HOUR = 3_600_000;
const FILE = "deploy/scan-bundle.dsse.json";
const READ = `read ${join(ROOT, FILE)}`;

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
