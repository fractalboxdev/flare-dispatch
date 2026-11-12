// Security-gate scans against the tick's own `advisory-refresh` schedule as a V-SIM scenario (specs/runs/gate.md
// FD-GATE-107, specs/operability.md FD-OPS-100). A seed fixes a virtual clock over several days, the times OSV
// publishes a new archive of each ecosystem (every 1 to 12 h, so the archive a refresh reads already lags its
// `Last-Modified` time), the tick times (one to ten minutes apart, as when the cron skips minutes), and scans at times
// between ticks, each changing a draw of lockfiles. Every tick runs the control plane's step against a SQLite D1 and a
// content-addressed bucket, and every refresh succeeds. Each scan runs `runScan` with the default
// `scan.advisoryMaxAgeHours` against the snapshots that D1 records at its time. The scenario checks that no scan on an
// unbroken daily schedule records `config: advisory snapshot stale <ecosystem>`, including scans whose snapshot is
// already more than 24 h old.
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import {
  d1AdvisorySnapshots,
  readSnapshotRecord,
  runOpsMigrations,
} from "@fractalboxdev/flare-dispatch-ops";
import { Effect, Layer, Match } from "effect";
import { Outcome } from "../../../../packages/catalog/src/reasons.ts";
import { ADVISORY_MAX_AGE_DEFAULT_HOURS, runScan } from "../../../../packages/catalog/src/scan-bundle.ts";
import {
  digestOf,
  envelopeBytes,
  fakeScanImage,
  IMAGE_VERSIONS,
  memoryScanBundleStore,
  signingKey,
  validPayload,
} from "../../../../packages/catalog/src/scan-bundle.test-support.ts";
import {
  archive,
  casBucket,
  nodeSha256,
  osvServer,
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
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 10, 9, 0, 0);

/** The lockfile a scan range changes for each ecosystem. */
const LOCKFILES: Readonly<Record<string, string>> = {
  npm: "web/pnpm-lock.yaml",
  PyPI: "api/uv.lock",
  "crates.io": "core/Cargo.lock",
};
const ECOSYSTEMS = Object.keys(LOCKFILES);

export interface AdvisoryScheduleOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

const fixtures = (async () => {
  const bytes = await envelopeBytes(validPayload(), [await signingKey("sim-advisory-schedule")]);
  return { bytes, digest: await digestOf(bytes) };
})();

export const simulateAdvisorySchedule = async (seed: number): Promise<AdvisoryScheduleOutcome> => {
  const rand = seededRandom(seed);
  const violations: SimViolation[] = [];
  const reached: Record<string, number> = {};
  const trace: string[] = [];
  const count = (k: string) => void (reached[k] = (reached[k] ?? 0) + 1);
  const { bytes, digest } = await fixtures;

  const DB = await migratedD1();
  await runOpsMigrations(DB);
  const bucket = casBucket();
  const env = { DB, CACHE: {}, ADVISORY_ECOSYSTEMS: [...ECOSYSTEMS] } as unknown as ControlPlaneEnv;
  const ports = () => ({
    fetch: osvServer(served).fetch,
    sha256: nodeSha256,
    bucket: bucket.bucket,
  });

  // OSV's publish times per ecosystem, the first before the clock starts; whole seconds, as `Last-Modified` carries.
  const start = START + Math.floor(rand() * 20) * HOUR;
  const end = start + (2 + Math.floor(rand() * 3)) * DAY;
  const publishes = new Map<string, number[]>(
    ECOSYSTEMS.map((e) => {
      const times: number[] = [];
      for (let at = start - Math.floor(rand() * 12 * HOUR); at < end; at += HOUR + Math.floor(rand() * 11 * HOUR))
        times.push(Math.floor(at / 1000) * 1000);
      return [e, times];
    }),
  );
  let served = new Map<string, Published>();
  trace.push(`start=${start} end=${end}`);

  const scan = async (now: number) => {
    const changed = ECOSYSTEMS.filter(() => rand() < 0.5);
    if (changed.length === 0) changed.push(ECOSYSTEMS[Math.floor(rand() * ECOSYSTEMS.length)]!);
    const outcome = await Effect.runPromise(
      runScan(
        {
          pin: digest,
          changedPaths: [...changed.map((e) => LOCKFILES[e]!), "src/app.ts"],
          now,
          advisoryMaxAgeHours: ADVISORY_MAX_AGE_DEFAULT_HOURS,
        },
        () => Effect.succeed(Outcome.success()),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            memoryScanBundleStore(new Map([[digest, bytes]])).layer,
            fakeScanImage(IMAGE_VERSIONS, ["semgrep"]),
            d1AdvisorySnapshots(DB),
          ),
        ),
      ),
    );
    const reason = Match.value(outcome).pipe(
      Match.tag("failure", (f) => f.reason as string),
      Match.orElse(() => "success"),
    );
    const ages: string[] = [];
    for (const e of changed) {
      const record = await readSnapshotRecord(DB, e);
      if (record === null) continue;
      const age = now - record.lastModified;
      ages.push(`${e}:${Math.round(age / MINUTE)}m`);
      count(age > 24 * HOUR ? "older-than-24h" : "within-24h");
    }
    trace.push(`scan now=${now} changed=${changed.join(",")} ages=${ages.join(",")} -> ${reason}`);
    if (reason !== "success")
      violations.push({
        id: "FD-GATE-107",
        message: `seed ${seed} scan at ${now}: recorded ${reason} on an unbroken daily refresh schedule (ages ${ages.join(",")})`,
      });
  };

  for (let now = start; now < end; ) {
    served = new Map(
      ECOSYSTEMS.map((e) => {
        const times = publishes.get(e)!.filter((t) => t <= now);
        return [e, { bytes: archive(`${e} v${times.length}`), lastModified: times.at(-1)! }];
      }),
    );
    const report = await Effect.runPromise(advisoryRefreshStep(env, now, ports).effect);
    const refreshed = (report as { refreshed: readonly string[] }).refreshed;
    if (refreshed.length > 0) {
      count("refreshed");
      trace.push(`tick ${now} refreshed=${refreshed.join(",")}`);
    }
    const next = now + (1 + Math.floor(rand() * 10)) * MINUTE;
    if (rand() < 0.05) await scan(now + Math.floor(rand() * (next - now)));
    now = next;
  }
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: "advisory-schedule",
    ids: ["FD-GATE-107"],
    run: async (seed) => throwOnViolations((await simulateAdvisorySchedule(seed)).violations),
  },
];
