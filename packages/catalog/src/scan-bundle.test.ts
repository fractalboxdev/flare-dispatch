import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ScanBundleStore, ScanImage } from "./ports.ts";
import { Outcome } from "./reasons.ts";
import {
  ADVISORY_MAX_AGE_DEFAULT_HOURS,
  bucketScanBundleStore,
  decodePayload,
  lockfileEcosystems,
  runScan,
  satisfies,
  type PreparedScan,
} from "./scan-bundle.ts";
import {
  digestOf,
  envelopeBytes,
  fakeScanImage,
  IMAGE_VERSIONS,
  memoryAdvisorySnapshots,
  memoryScanBundleStore,
  signingKey,
  validPayload,
  type StoredBundle,
  type StoredSnapshot,
} from "./scan-bundle.test-support.ts";
import { nodeScanImage, scanToolsIn, versionIn } from "./scan-image.ts";

const TOOLS = ["semgrep"];

/** The scan range's changed paths and the advisory snapshots the control-plane store records. */
interface AdvisoryInput {
  readonly changedPaths?: readonly string[];
  readonly snapshots?: ReadonlyMap<string, StoredSnapshot>;
  readonly now?: number;
  readonly maxAgeHours?: number;
}

const NOW = Date.UTC(2026, 10, 12, 9, 0);
const HOUR = 3_600_000;

/** A scan over `objects` and an image of `versions` and `tools`, recording whether the scanners ran. */
const scanWith = async (
  pin: string | undefined,
  objects: ReadonlyMap<string, StoredBundle>,
  versions: Readonly<Partial<Record<string, string>>> = IMAGE_VERSIONS,
  tools: readonly string[] = TOOLS,
  advisory: AdvisoryInput = {},
) => {
  const store = memoryScanBundleStore(objects);
  const snapshots = memoryAdvisorySnapshots(advisory.snapshots);
  const prepared: PreparedScan[] = [];
  const scope = {
    pin,
    changedPaths: advisory.changedPaths ?? [],
    now: advisory.now ?? NOW,
    advisoryMaxAgeHours: advisory.maxAgeHours ?? ADVISORY_MAX_AGE_DEFAULT_HOURS,
  };
  const outcome = await Effect.runPromise(
    runScan(scope, (p) =>
      Effect.sync(() => {
        prepared.push(p);
        return Outcome.success();
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(store.layer, fakeScanImage(versions, tools), snapshots.layer),
      ),
    ),
  );
  return {
    outcome,
    scanned: prepared.length > 0,
    prepared,
    reads: store.reads,
    snapshotReads: snapshots.reads,
  };
};

const bundle = async (payload: unknown = validPayload()) => {
  const key = await signingKey("bundle-2026");
  const bytes = await envelopeBytes(payload, [key]);
  return { bytes, digest: await digestOf(bytes) };
};

const failure = (reason: string) => ({ _tag: "failure", reason });

describe("security-gate scan preconditions", () => {
  it("[FD-GATE-100] reads the scan bundle from cas/<scan.bundleDigest> and runs the scan only on bytes whose SHA-256 is that digest", async () => {
    const { bytes, digest } = await bundle();
    const run = await scanWith(digest, new Map([[digest, bytes]]));
    expect(run.reads).toEqual([digest]);
    expect(run.outcome).toEqual(Outcome.success());
    expect(run.prepared[0]!.bundle.digest).toBe(digest);
    expect(run.prepared[0]!.bundle.payload.version).toBe("2026.11.1");

    // The bucket store reads the content-addressed key and answers its bytes as stored.
    const keys: string[] = [];
    const bucket = {
      get: async (key: string) => {
        keys.push(key);
        return key === `cas/${digest}` ? { arrayBuffer: async () => bytes.slice().buffer } : null;
      },
    };
    const read = await Effect.runPromise(
      Effect.flatMap(
        ScanBundleStore,
        (s) => s.read(digest),
      ).pipe(Effect.provide(bucketScanBundleStore(bucket))),
    );
    expect(keys).toEqual([`cas/${digest}`]);
    expect(read).toEqual(bytes);
  });

  it("[FD-GATE-101] records failure config: scan bundle not pinned and runs no scanner where the deployment sets no scan.bundleDigest", async () => {
    const { bytes, digest } = await bundle();
    for (const pin of [undefined, ""]) {
      const run = await scanWith(pin, new Map([[digest, bytes]]));
      expect(run.outcome).toEqual(failure("config: scan bundle not pinned"));
      expect(run.scanned).toBe(false);
      expect(run.reads).toEqual([]);
    }
  });

  it("[FD-GATE-102] records failure config: scan bundle missing and runs no scanner where the object is absent or unreadable", async () => {
    const { digest } = await bundle();
    for (const held of ["absent", "unreadable"] as const) {
      const run = await scanWith(digest, new Map([[digest, held]]));
      expect(run.outcome).toEqual(failure("config: scan bundle missing"));
      expect(run.scanned).toBe(false);
    }
  });

  it("[FD-GATE-103] records failure config: scan bundle digest and runs no scanner where the stored bytes' SHA-256 differs from scan.bundleDigest", async () => {
    const { bytes, digest } = await bundle();
    const tampered = new Uint8Array([...bytes, 0x20]);
    const run = await scanWith(digest, new Map([[digest, tampered]]));
    expect(run.outcome).toEqual(failure("config: scan bundle digest"));
    expect(run.scanned).toBe(false);
  });

  it("[FD-GATE-105] records failure config: scanner version <name> and runs no scanner where a scanner's version lies outside scanners.<name>.versions or the image lacks it", async () => {
    const { bytes, digest } = await bundle();
    const objects = new Map([[digest, bytes]]);
    for (const [versions, name] of [
      [{ ...IMAGE_VERSIONS, gitleaks: "9.0.0" }, "gitleaks"],
      [{ ...IMAGE_VERSIONS, zizmor: "1.4.9" }, "zizmor"],
      [{ ...IMAGE_VERSIONS, "osv-scanner": "1.10.0" }, "osv-scanner"],
      [{ gitleaks: IMAGE_VERSIONS.gitleaks, zizmor: IMAGE_VERSIONS.zizmor }, "osv-scanner"],
    ] as const) {
      const run = await scanWith(digest, objects, versions);
      expect(run.outcome).toEqual(failure(`config: scanner version ${name}`));
      expect(run.scanned).toBe(false);
    }
    const ok = await scanWith(digest, objects);
    expect(ok.prepared[0]!.versions).toEqual(IMAGE_VERSIONS);
  });

  it("[FD-GATE-106] records failure config: advisory snapshot missing <ecosystem> and runs no scanner where the range changes a lockfile of an ecosystem with no recorded snapshot", async () => {
    const { bytes, digest } = await bundle();
    const objects = new Map([[digest, bytes]]);
    const fresh = { digest: "a".repeat(64), lastModified: NOW - HOUR };
    for (const held of ["absent", "unreadable"] as const) {
      const run = await scanWith(digest, objects, IMAGE_VERSIONS, TOOLS, {
        changedPaths: ["web/pnpm-lock.yaml", "svc/Cargo.lock", "README.md"],
        snapshots: new Map<string, StoredSnapshot>([
          ["npm", { ecosystem: "npm", ...fresh }],
          ["crates.io", held],
        ]),
      });
      expect(run.outcome).toEqual(failure("config: advisory snapshot missing crates.io"));
      expect(run.scanned).toBe(false);
    }

    // A range that changes no lockfile of that ecosystem reads no snapshot of it and scans.
    const other = await scanWith(digest, objects, IMAGE_VERSIONS, TOOLS, {
      changedPaths: ["web/pnpm-lock.yaml", "src/main.rs"],
      snapshots: new Map<string, StoredSnapshot>([["npm", { ecosystem: "npm", ...fresh }]]),
    });
    expect(other.snapshotReads).toEqual(["npm"]);
    expect(other.outcome).toEqual(Outcome.success());
    expect(other.prepared[0]!.snapshots).toEqual({ npm: { ecosystem: "npm", ...fresh } });

    // A range with no lockfile reads no snapshot at all.
    const none = await scanWith(digest, objects, IMAGE_VERSIONS, TOOLS, {
      changedPaths: ["src/index.ts"],
    });
    expect(none.snapshotReads).toEqual([]);
    expect(none.scanned).toBe(true);
    expect(lockfileEcosystems(["a/yarn.lock", "b/package-lock.json", "uv.lock", "go.mod", "x.lock"])).toEqual([
      "Go",
      "PyPI",
      "npm",
    ]);
  });

  it("[FD-GATE-107] records failure config: advisory snapshot stale <ecosystem> and runs no scanner where the snapshot's Last-Modified time is older than scan.advisoryMaxAgeHours", async () => {
    const { bytes, digest } = await bundle();
    const objects = new Map([[digest, bytes]]);
    const snapshot = (ageHours: number): StoredSnapshot => ({
      ecosystem: "PyPI",
      digest: "b".repeat(64),
      lastModified: NOW - ageHours * HOUR,
    });
    const scan = (ageHours: number, maxAgeHours?: number) =>
      scanWith(digest, objects, IMAGE_VERSIONS, TOOLS, {
        changedPaths: ["api/poetry.lock"],
        snapshots: new Map([["PyPI", snapshot(ageHours)]]),
        ...(maxAgeHours === undefined ? {} : { maxAgeHours }),
      });

    // The default accepts a snapshot 48 h old and refuses one a minute older.
    expect((await scan(48)).scanned).toBe(true);
    const stale = await scan(48 + 1 / 60);
    expect(stale.outcome).toEqual(failure("config: advisory snapshot stale PyPI"));
    expect(stale.scanned).toBe(false);

    // The setting, not a fixed 48 h, bounds the age.
    expect((await scan(20, 24)).scanned).toBe(true);
    const past = await scan(25, 24);
    expect(past.outcome).toEqual(failure("config: advisory snapshot stale PyPI"));
    expect(past.scanned).toBe(false);
    expect((await scan(2, 1)).outcome).toEqual(failure("config: advisory snapshot stale PyPI"));
  });

  it("[FD-GATE-105] reads semver ranges as npm does: caret, tilde, x-ranges, comparator sets, hyphen ranges, unions and prereleases", () => {
    const cases: readonly [string, string, boolean][] = [
      ["8.18.4", "^8.18.0", true],
      ["9.0.0", "^8.18.0", false],
      ["0.2.9", "^0.2.3", true],
      ["0.3.0", "^0.2.3", false],
      ["1.9.9", "~1.9.0", true],
      ["1.10.0", "~1.9.0", false],
      ["1.6.0", ">=1.5.0 <2.0.0", true],
      ["2.0.0", ">=1.5.0 <2.0.0", false],
      ["1.2.7", "1.2.x", true],
      ["1.3.0", "1.2.x", false],
      ["1.5.0", "1.2.3 - 1.5", true],
      ["1.6.0", "1.2.3 - 1.5", false],
      ["1.2.5", ">1.2", false],
      ["1.3.0", ">1.2", true],
      ["1.2.5", "<=1.2", true],
      ["1.3.0", "<=1.2", false],
      ["1.5.0", ">1", false],
      ["2.0.0", ">1", true],
      ["1.9.9", "<=1", true],
      ["2.0.0", "<=1", false],
      ["3.1.0", "^1.0.0 || ^3.0.0", true],
      ["2.0.0-rc.1", "^1.0.0", false],
      ["2.0.0-rc.1", ">=2.0.0-rc.0 <2.0.0", true],
      ["1.0.0-1", ">=1.0.0-0 <1.1.0", true],
      ["1.1.0-rc.1", "^1.0.0", false],
      ["v8.18.4", "8.18.4", true],
      ["8.18", "^8.0.0", false],
      ["8.18.4", "not a range", false],
    ];
    for (const [version, range, expected] of cases)
      expect(satisfies(version, range), `${version} in ${range}`).toBe(expected);
  });

  it("[FD-GATE-105] reads a scanner's version from what its version command prints", async () => {
    expect(versionIn("8.18.4\n")).toBe("8.18.4");
    expect(versionIn("zizmor 1.6.0\n")).toBe("1.6.0");
    expect(versionIn("osv-scanner version: 1.9.2\ncommit: abc\n")).toBe("1.9.2");
    expect(versionIn("no version here")).toBeUndefined();
    const bin = await mkdtemp(join(tmpdir(), "fd-scan-image-"));
    await writeFile(join(bin, "zizmor"), "#!/bin/sh\necho 'zizmor 1.6.0'\n");
    await chmod(join(bin, "zizmor"), 0o755);
    const image = nodeScanImage({ env: { PATH: bin } });
    const probe = (scanner: string) =>
      Effect.runPromise(
        Effect.flatMap(ScanImage, (i) =>
          i.scannerVersion(scanner),
        ).pipe(Effect.provide(image), Effect.result),
      );
    const zizmor = await probe("zizmor");
    expect(zizmor).toMatchObject({ success: "1.6.0" });
    const gitleaks = await probe("gitleaks");
    expect(gitleaks).toMatchObject({ failure: { _tag: "ScannerVersionUnknown", scanner: "gitleaks" } });
  });

  it("[FD-GATE-109] records failure config: baseline check <control id> and runs no scanner where a check's tool is not a binary the image's scan-tools file lists", async () => {
    const { bytes, digest } = await bundle();
    const objects = new Map([[digest, bytes]]);
    for (const tools of [[], ["gitleaks", "zizmor", "osv-scanner"], ["semgrep-wrapper"]]) {
      const run = await scanWith(digest, objects, IMAGE_VERSIONS, tools);
      expect(run.outcome).toEqual(failure("config: baseline check SC-28"));
      expect(run.scanned).toBe(false);
    }
    expect((await scanWith(digest, objects, IMAGE_VERSIONS, ["semgrep"])).scanned).toBe(true);
  });

  it("[FD-GATE-109] reads the scan-tools file one binary per line, and an image without the file lists none", async () => {
    expect(scanToolsIn("# baseline tools\nsemgrep\n\n  checkov \n")).toEqual(["semgrep", "checkov"]);
    const dir = await mkdtemp(join(tmpdir(), "fd-scan-tools-"));
    const file = join(dir, "scan-tools");
    await writeFile(file, "semgrep\n");
    const tools = (scanToolsFile: string) =>
      Effect.runPromise(
        Effect.flatMap(ScanImage, (i) => i.scanTools).pipe(
          Effect.provide(nodeScanImage({ scanToolsFile })),
        ),
      );
    expect(await tools(file)).toEqual(["semgrep"]);
    expect(await tools(join(dir, "absent"))).toEqual([]);
  });

  it("rejects a payload that fails the schema, naming the first failing path", async () => {
    const payload = validPayload();
    const bad = { ...payload, scanners: { ...payload.scanners, zizmor: { versions: "nope", exitMap: {} } } };
    const exit = await Effect.runPromise(Effect.result(decodePayload(bad)));
    expect(exit).toMatchObject({ failure: { _tag: "ScanBundleSchemaInvalid", path: "scanners.zizmor.versions" } });
    const { bytes, digest } = await bundle(bad);
    const run = await scanWith(digest, new Map([[digest, bytes]]));
    expect(run.outcome).toEqual(failure("config: scan bundle scanners.zizmor.versions"));
    expect(run.scanned).toBe(false);
  });
});
