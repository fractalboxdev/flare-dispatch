// The deploy suite of `V-DEPLOY` for the scan bundle (specs/operability.md § Scan bundle and advisory snapshot,
// FD-OPS-094 to FD-OPS-098): `fd deploy` and `fd doctor` on the fakes of `support.ts`, the live target reading the
// envelope the overlay pins, and the Dockerfile of the gate image the control-plane template's containers name, from the
// deploy host's files. A deploy whose envelope fails verification, or whose rendered image holds a scanner version the
// envelope does not accept, stops in the drift stage before any write, so the account keeps the Workers, and the pin,
// of the last deploy.
import { readFileSync } from "node:fs";
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

/** The gate image the control-plane template's containers name, as the deploy host holds it. */
const IMAGE = join(ROOT, "infra/v2/Dockerfile.gate");
const GATE_DOCKERFILE = readFileSync(IMAGE, "utf8");

/** A valid payload whose `scanners.<name>.versions` accept the committed gate image's scanners, changed by `versions`. */
const imagePayload = (versions: Partial<Record<"gitleaks" | "zizmor" | "osv-scanner", string>> = {}) => {
  const base = validPayload();
  const range = { gitleaks: "^8.30.0", zizmor: "^1.32.0", "osv-scanner": "^2.7.0", ...versions };
  return {
    ...base,
    scanners: {
      gitleaks: { ...base.scanners.gitleaks, versions: range.gitleaks },
      zizmor: { ...base.scanners.zizmor, versions: range.zizmor },
      "osv-scanner": { ...base.scanners["osv-scanner"], versions: range["osv-scanner"] },
    },
  };
};

/** A world whose deploy host holds `bytes` at `FILE` and `dockerfile` as the gate image. */
const hostWith = (bytes: Uint8Array, w: World = world(), dockerfile: string = GATE_DOCKERFILE) => {
  w.localFiles.set(join(ROOT, FILE), bytes);
  w.localFiles.set(IMAGE, new TextEncoder().encode(dockerfile));
  return w;
};

const signedBy = async (key: SigningKey, payload: unknown = imagePayload()) => {
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

  it("[FD-OPS-098] reads the gate image the rendered containers name and deploys where each scanner version it declares lies inside scanners.<name>.versions", async () => {
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
    const read = w.calls.indexOf(`read ${IMAGE}`);
    expect(read).toBeGreaterThan(w.calls.indexOf(READ));
    expect(read).toBeLessThan(w.calls.findIndex(isWrite));
    expect((await Effect.runPromise(fd(w).doctor(overlay))).ok).toBe(true);
  });

  it("[FD-OPS-098] refuses a deploy whose rendered image holds a scanner version outside scanners.<name>.versions, or declares none, naming the scanner", async () => {
    const key = await signingKey("bundle-2026");
    const now = Date.now();
    const keys = [keyEntry(key, now - HOUR, now + HOUR)];
    const image = "infra/v2/Dockerfile.gate (control-plane.containers.LeanPool, control-plane.containers.AgentPool, control-plane.containers.BrowserPool, control-plane.containers.ReleasePool, control-plane.containers.ControlPool)";
    for (const [versions, text] of [
      [{ "osv-scanner": "~1.9.0" }, `scanners.osv-scanner.versions: the image ${image} holds osv-scanner 2.7.0, outside scanners.osv-scanner.versions ~1.9.0`],
      [{ gitleaks: "<8.30.0" }, `scanners.gitleaks.versions: the image ${image} holds gitleaks 8.30.1, outside scanners.gitleaks.versions <8.30.0`],
    ] as const) {
      const { bytes, digest } = await signedBy(key, imagePayload(versions));
      await refused(hostWith(bytes), overlayWith({ bundleDigest: digest, bundleFile: FILE, bundleKeys: keys }), [text]);
    }
    const { bytes, digest } = await signedBy(key);
    const undeclared = GATE_DOCKERFILE.replace(/^ARG ZIZMOR_VERSION=.*$/m, "");
    await refused(
      hostWith(bytes, world(), undeclared),
      overlayWith({ bundleDigest: digest, bundleFile: FILE, bundleKeys: keys }),
      [`scanners.zizmor.versions: the image ${image} declares no zizmor version (ARG ZIZMOR_VERSION)`],
    );
  });
});
