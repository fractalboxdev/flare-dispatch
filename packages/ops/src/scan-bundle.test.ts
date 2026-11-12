import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  digestOf,
  envelopeBytes,
  keyEntry,
  signingKey,
  validPayload,
  type SigningKey,
} from "../../catalog/src/scan-bundle.test-support.ts";
import { accessStore } from "./access-application.test-support.ts";
import {
  APP_PERMISSIONS,
  DeployTarget,
  fdDeploy,
  MERGE_GATE_CHECKS,
  placeholderOverlay,
  type DeployedSettings,
  type OverlayValues,
} from "./index.ts";
import { scanBundleFindings } from "./scan-bundle.ts";

const HOUR = 3_600_000;
const FILE = "deploy/scan-bundle.dsse.json";

const WORKERS = [
  {
    worker: "dispatcher",
    template: `{ "name": "dispatcher", "account_id": "{{accountId}}", "keep_vars": false, "triggers": { "crons": ["* * * * *"] } }`,
  },
];

const settings: DeployedSettings = {
  bindings: [],
  vars: {},
  secrets: [],
  crons: ["* * * * *"],
  routes: [],
  compatibility_date: "2026-05-01",
  compatibility_flags: [],
  containers: [],
};

/** A deploy target whose local files are `files`, recording every call in order. */
const target = (files: ReadonlyMap<string, Uint8Array>) => {
  const calls: string[] = [];
  const layer = Layer.succeed(DeployTarget, {
    readScanBundle: (path) => Effect.sync(() => (calls.push(`bundle:${path}`), files.get(path) ?? null)),
    writeScanBundle: (digest) => Effect.sync(() => void calls.push(`cas:${digest}`)),
    deployedSettings: ({ worker: w }) => Effect.sync(() => (calls.push(`read:${w}`), settings)),
    lastRecord: () => Effect.succeed(settings),
    appRegistration: Effect.succeed(APP_PERMISSIONS),
    requiredChecks: Effect.succeed([...MERGE_GATE_CHECKS, "flare-dispatch/check:ci"]),
    apiToken: () => Effect.succeed(null),
    awsBudgets: Effect.succeed({ account: "", observedAt: 0, budgets: [], actions: [] }),
    runnerWorkflow: () => Effect.succeed(null),
    applyD1Migrations: () => Effect.sync(() => (calls.push("migrate"), [])),
    deployWorker: ({ worker: w }) =>
      Effect.sync(() => {
        calls.push(`deploy:${w}`);
        return { worker: w, version: "v2", previousVersion: "v1", durableObjectMigrations: [] };
      }),
    probe: () => Effect.succeed(true),
    floorCanary: () => Effect.succeed({ status: "passed" as const, digest: "sha256:0" }),
    writeRecord: ({ worker: w }) => Effect.sync(() => void calls.push(`write:${w}`)),
    raiseAlarm: () => Effect.void,
    ...accessStore(),
  });
  return { calls, layer };
};

const isWrite = (c: string) => /^(cas:|migrate|deploy:|write:)/.test(c);

const deployWith = async (scan: OverlayValues["scan"], files: ReadonlyMap<string, Uint8Array>) => {
  const t = target(files);
  const overlay = JSON.stringify({ ...placeholderOverlay, ...(scan === undefined ? {} : { scan }) });
  const result = await Effect.runPromise(
    Effect.result(fdDeploy(overlay, WORKERS, APP_PERMISSIONS).pipe(Effect.provide(t.layer))),
  );
  return { result, calls: t.calls };
};

/** A signed envelope of `payload`, its digest, and a key entry whose window holds now. */
const signed = async (payload: unknown = validPayload(), signer?: SigningKey) => {
  const key = signer ?? (await signingKey("bundle-2026"));
  const bytes = await envelopeBytes(payload, [key]);
  const now = Date.now();
  return { key, bytes, digest: await digestOf(bytes), entry: keyEntry(key, now - HOUR, now + HOUR) };
};

const findingsAt = (scan: OverlayValues["scan"], bytes: Uint8Array | null, at: number) =>
  Effect.runPromise(scanBundleFindings(scan, bytes, at));

describe("the drift check's scan bundle step", () => {
  it("[FD-OPS-094] verifies the envelope at scan.bundleFile before any deploy step changes Cloudflare state, and reads none where the overlay pins no digest", async () => {
    const { bytes, digest, entry } = await signed();
    const ok = await deployWith(
      { bundleDigest: digest, bundleFile: FILE, bundleKeys: [entry] },
      new Map([[FILE, bytes]]),
    );
    expect(ok.result).toMatchObject({ _tag: "Success" });
    expect(ok.calls[0]).toBe(`bundle:${FILE}`);
    expect(ok.calls.findIndex(isWrite)).toBeGreaterThan(0);

    const unpinned = await deployWith({ bundleFile: FILE }, new Map([[FILE, bytes]]));
    expect(unpinned.result).toMatchObject({ _tag: "Success" });
    expect(unpinned.calls.some((c) => c.startsWith("bundle:"))).toBe(false);

    // A pinned digest with no file, or a file that does not exist, fails the drift stage with no write.
    for (const [scan, detail] of [
      [{ bundleDigest: digest, bundleKeys: [entry] }, "names no scan.bundleFile"],
      [{ bundleDigest: digest, bundleFile: "absent.json", bundleKeys: [entry] }, "no envelope at absent.json"],
    ] as const) {
      const run = await deployWith(scan, new Map([[FILE, bytes]]));
      expect(run.result).toMatchObject({
        _tag: "Failure",
        failure: { stage: "drift", findings: [{ path: "scan.bundleFile", detail: expect.stringContaining(detail) }] },
      });
      expect(run.calls.filter(isWrite)).toEqual([]);
    }
  });

  it("[FD-OPS-095] fails the drift check unless a signature verifies under a scan.bundleKeys key whose window holds the verification time, so an expired, future or removed key authorizes no deploy", async () => {
    const { key, bytes, digest } = await signed();
    const other = await signingKey("other");
    const now = Date.now();
    const scan = (bundleKeys: NonNullable<OverlayValues["scan"]>["bundleKeys"]) => ({
      bundleDigest: digest,
      bundleFile: FILE,
      ...(bundleKeys === undefined ? {} : { bundleKeys }),
    });
    const refused = [
      scan([keyEntry(key, now - 2 * HOUR, now - HOUR)]), // expired
      scan([keyEntry(key, now + HOUR, now + 2 * HOUR)]), // not yet valid
      scan([keyEntry(other, now - HOUR, now + HOUR)]), // the signing key removed, another kept
      scan([]),
      scan(undefined),
      scan([{ publicKey: key.publicKey, notAfter: new Date(now + HOUR).toISOString() }]), // missing window
      scan([{ publicKey: key.publicKey, notBefore: "yesterday", notAfter: new Date(now + HOUR).toISOString() }]),
      scan([keyEntry(key, now + HOUR, now - HOUR)]), // reversed
    ];
    for (const s of refused) {
      const run = await deployWith(s, new Map([[FILE, bytes]]));
      expect(run.result, JSON.stringify(s.bundleKeys)).toMatchObject({
        _tag: "Failure",
        failure: { stage: "drift", findings: [{ path: "scan.bundleKeys" }] },
      });
      expect(run.calls.filter(isWrite)).toEqual([]);
    }
    // Either of two keys verifies, and an expired key beside the valid one is ignored.
    const both = await deployWith(
      scan([keyEntry(other, now - HOUR, now + HOUR), keyEntry(key, now - HOUR, now + HOUR)]),
      new Map([[FILE, bytes]]),
    );
    expect(both.result).toMatchObject({ _tag: "Success" });

    // The window is [notBefore, notAfter) at the one verification time.
    const t0 = Date.UTC(2026, 10, 1);
    const windowed = { ...scan([keyEntry(key, t0, t0 + HOUR)]) };
    expect(await findingsAt(windowed, bytes, t0)).toEqual([]);
    expect(await findingsAt(windowed, bytes, t0 + HOUR - 1)).toEqual([]);
    expect(await findingsAt(windowed, bytes, t0 - 1)).toMatchObject([{ path: "scan.bundleKeys" }]);
    expect(await findingsAt(windowed, bytes, t0 + HOUR)).toMatchObject([{ path: "scan.bundleKeys" }]);
  });

  it("[FD-OPS-095] a signature over other bytes, or by a key outside the list, does not verify", async () => {
    const { key, entry } = await signed();
    const stranger = await signingKey("bundle-2026");
    const forged = await envelopeBytes(validPayload(), [stranger]);
    const digest = await digestOf(forged);
    const run = await findingsAt(
      { bundleDigest: digest, bundleFile: FILE, bundleKeys: [entry] },
      forged,
      Date.now(),
    );
    expect(run).toMatchObject([{ path: "scan.bundleKeys", severity: "failure" }]);
    // The envelope's signature, moved onto another payload, covers bytes it never signed.
    const original = JSON.parse(new TextDecoder().decode(await envelopeBytes(validPayload(), [key])));
    const swapped = JSON.parse(
      new TextDecoder().decode(await envelopeBytes({ ...validPayload(), version: "evil" }, [])),
    );
    const moved = new TextEncoder().encode(JSON.stringify({ ...swapped, signatures: original.signatures }));
    expect(
      await findingsAt(
        { bundleDigest: await digestOf(moved), bundleFile: FILE, bundleKeys: [entry] },
        moved,
        Date.now(),
      ),
    ).toMatchObject([{ path: "scan.bundleKeys" }]);
  });

  it("[FD-OPS-096] fails the drift check where the envelope's SHA-256 differs from scan.bundleDigest", async () => {
    const { bytes, digest, entry } = await signed();
    const other = "0".repeat(64);
    const run = await deployWith(
      { bundleDigest: other, bundleFile: FILE, bundleKeys: [entry] },
      new Map([[FILE, bytes]]),
    );
    expect(run.result).toMatchObject({
      _tag: "Failure",
      failure: {
        stage: "drift",
        findings: [{ path: "scan.bundleDigest", detail: `the envelope's SHA-256 is ${digest}, not scan.bundleDigest ${other}` }],
      },
    });
    expect(run.calls.filter(isWrite)).toEqual([]);
  });

  it("[FD-OPS-097] fails the drift check where the payload fails the scan bundle schema, naming the first failing path", async () => {
    const base = validPayload();
    const cases: readonly [unknown, string][] = [
      [{ ...base, version: "" }, "version"],
      [{ ...base, scanners: { ...base.scanners, "osv-scanner": { ...base.scanners["osv-scanner"], versions: "one point nine" } } }, "scanners.osv-scanner.versions"],
      [{ ...base, scanners: { ...base.scanners, gitleaks: { ...base.scanners.gitleaks, exitMap: { "256": "clean" } } } }, "scanners.gitleaks.exitMap.256"],
      [{ ...base, suppression: { ...base.suppression, files: [".gitleaksignore"] } }, "suppression.files"],
      [{ ...base, suppression: { ...base.suppression, markers: ["#\\s*nosec"] } }, "suppression.markers"],
      [{ ...base, baselineChecks: [{ ...base.baselineChecks[0]!, argv: ["sh", "-c", "semgrep"] }] }, "baselineChecks.0.argv"],
      [{ ...base, baselineChecks: [{ ...base.baselineChecks[0]!, exitMap: { "0": "pass" } }] }, "baselineChecks.0.exitMap.0"],
    ];
    const key = await signingKey("bundle-2026");
    for (const [payload, path] of cases) {
      const { bytes, digest, entry } = await signed(payload, key);
      const run = await deployWith(
        { bundleDigest: digest, bundleFile: FILE, bundleKeys: [entry] },
        new Map([[FILE, bytes]]),
      );
      expect(run.result, path).toMatchObject({
        _tag: "Failure",
        failure: {
          stage: "drift",
          findings: [{ path: "scan.bundleFile", detail: expect.stringContaining(`schema at ${path}:`) }],
        },
      });
      expect(run.calls.filter(isWrite)).toEqual([]);
    }
  });
});
