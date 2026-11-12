// The tick's `advisory-refresh` step under failing refreshes as a V-SIM scenario (specs/operability.md FD-OPS-102).
// A seed fixes a virtual clock of minute ticks over several days, the archives OSV publishes for each ecosystem and
// when, and for each attempt how it fails: a non-200 answer, a dropped connection, a body shorter than its
// `Content-Length`, an archive republished between the digest read and the store, or a store that refuses the put.
// Each tick runs the control plane's step against a SQLite D1 and a content-addressed bucket. The scenario checks
// that every ecosystem the step reports failed kept the snapshot it had before that tick, that every recorded
// snapshot names an object the bucket holds with that digest, and that no ecosystem is stored twice in one UTC day.
import { createHash } from "node:crypto";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import {
  readSnapshotRecord,
  runOpsMigrations,
  utcDayOf,
  type SnapshotRecord,
} from "@fractalboxdev/flare-dispatch-ops";
import { Cause, Effect, Exit } from "effect";
import {
  archive,
  casBucket,
  nodeSha256,
  osvServer,
  sha256,
  type Published,
} from "../../../../packages/ops/src/advisory.test-support.ts";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../../packages/ops/src/verification/harness.ts";
import { advisoryRefreshStep } from "../../src/advisory-snapshots.ts";
import type { ControlPlaneEnv } from "../../src/config.ts";

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 9, 22, 0);
const ECOSYSTEMS = ["npm", "PyPI", "Go"] as const;
type Fault = "none" | "503" | "throws" | "short" | "changed" | "refused";
const FAULTS: readonly Fault[] = ["none", "none", "503", "throws", "short", "changed", "refused"];

export interface AdvisoryRefreshOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

export const simulateAdvisoryRefresh = async (seed: number): Promise<AdvisoryRefreshOutcome> => {
  const rand = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const violations: SimViolation[] = [];
  const reached: Record<string, number> = {};
  const trace: string[] = [];
  const count = (k: string) => void (reached[k] = (reached[k] ?? 0) + 1);

  const DB = await migratedD1();
  await runOpsMigrations(DB);
  const bucket = casBucket();
  const env = { DB, CACHE: {}, ADVISORY_ECOSYSTEMS: [...ECOSYSTEMS] } as unknown as ControlPlaneEnv;

  // What OSV currently publishes per ecosystem; a new version appears every few hours.
  const version = new Map<string, number>(ECOSYSTEMS.map((e) => [e, 0]));
  const publishedAt = new Map<string, number>(ECOSYSTEMS.map((e) => [e, START - 3 * 60 * MINUTE]));
  const stored = new Map<string, number[]>();

  const end = START + (2 + Math.floor(rand() * 3)) * 24 * 60 * MINUTE;
  for (let now = START; now < end; now += (1 + Math.floor(rand() * 180)) * MINUTE) {
    for (const e of ECOSYSTEMS)
      if (rand() < 0.1) {
        version.set(e, version.get(e)! + 1);
        publishedAt.set(e, Math.floor(now / 1000) * 1000);
      }
    const faults = new Map(ECOSYSTEMS.map((e) => [e, pick(FAULTS)]));
    const published = new Map<string, Published>(
      ECOSYSTEMS.map((e) => {
        const bytes = archive(`${e} v${version.get(e)}`);
        const lastModified = publishedAt.get(e)!;
        const fault = faults.get(e)!;
        const p: Published =
          fault === "503"
            ? { bytes, lastModified, status: 503 }
            : fault === "throws"
              ? { bytes, lastModified, status: "throws" }
              : fault === "short"
                ? { bytes, lastModified, truncate: Math.floor(bytes.length / 2) }
                : fault === "changed"
                  ? {
                      bytes,
                      lastModified,
                      next: { bytes: archive(`${e} v${version.get(e)} later`), lastModified: lastModified + 1000 },
                    }
                  : { bytes, lastModified };
        return [e, p];
      }),
    );
    const refusedKeys = new Set(
      ECOSYSTEMS.filter((e) => faults.get(e) === "refused").map(
        (e) => `cas/${sha256(published.get(e)!.bytes)}`,
      ),
    );
    const server = osvServer(published);
    const ports = {
      fetch: server.fetch,
      sha256: nodeSha256,
      bucket: {
        head: bucket.bucket.head,
        put: (key: string, body: ReadableStream<Uint8Array>, expected: { length: number; sha256: string }) =>
          refusedKeys.has(key) ? Promise.reject(new Error("R2 answered 500")) : bucket.bucket.put(key, body, expected),
      },
    };

    const before = new Map<string, SnapshotRecord | null>();
    for (const e of ECOSYSTEMS) before.set(e, await readSnapshotRecord(DB, e));
    const exit = await Effect.runPromiseExit(advisoryRefreshStep(env, now, () => ports).effect);
    const failed = Exit.isFailure(exit)
      ? ((Cause.squash(exit.cause) as { failed?: { ecosystem: string }[] }).failed ?? []).map((f) => f.ecosystem)
      : [];
    const refreshed = Exit.isSuccess(exit)
      ? (exit.value as { refreshed: string[] }).refreshed
      : ((Cause.squash(exit.cause) as { refreshed?: string[] }).refreshed ?? []);
    trace.push(
      `${now} faults=${ECOSYSTEMS.map((e) => faults.get(e)).join(",")} refreshed=${refreshed.join(",")} failed=${failed.join(",")}`,
    );

    for (const e of ECOSYSTEMS) {
      const after = await readSnapshotRecord(DB, e);
      if (failed.includes(e)) {
        count(before.get(e) === null ? "failed-none" : "failed-kept");
        if (JSON.stringify(after) !== JSON.stringify(before.get(e)))
          violations.push({
            id: "FD-OPS-102",
            message: `seed ${seed} at ${now}: ${e}'s failed refresh (${faults.get(e)}) changed its snapshot from ${JSON.stringify(before.get(e))} to ${JSON.stringify(after)}`,
          });
        if (faults.get(e) === "none")
          violations.push({ id: "FD-OPS-102", message: `seed ${seed} at ${now}: ${e} failed with no fault` });
      }
      if (refreshed.includes(e)) {
        count("refreshed");
        const served = published.get(e)!;
        if (after?.digest !== sha256(served.bytes) || after.lastModified !== served.lastModified)
          violations.push({
            id: "FD-OPS-102",
            message: `seed ${seed} at ${now}: ${e} recorded ${JSON.stringify(after)} for the archive it read`,
          });
        const days = stored.get(e) ?? [];
        if (days.includes(utcDayOf(now)))
          violations.push({ id: "FD-OPS-102", message: `seed ${seed} at ${now}: ${e} stored twice in one UTC day` });
        stored.set(e, [...days, utcDayOf(now)]);
      }
      if (after !== null) {
        const object = bucket.objects.get(`cas/${after.digest}`);
        if (object === undefined || createHash("sha256").update(object).digest("hex") !== after.digest)
          violations.push({
            id: "FD-OPS-102",
            message: `seed ${seed} at ${now}: ${e}'s snapshot names cas/${after.digest}, which the bucket does not hold`,
          });
      }
    }
  }
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: "advisory-refresh",
    ids: ["FD-OPS-102"],
    run: async (seed) => throwOnViolations((await simulateAdvisoryRefresh(seed)).violations),
  },
];
