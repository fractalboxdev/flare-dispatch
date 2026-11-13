// A security-gate scan's advisory-snapshot age precondition as a V-SIM scenario (specs/runs/gate.md FD-GATE-107). A
// seed fixes a virtual clock over several days, the OSV archives' publish times, the control plane's refreshes (some
// of which fail and leave the recorded snapshot unchanged), `scan.advisoryMaxAgeHours`, and a sequence of scans, each
// at a time on the clock and changing a draw of lockfiles. Each scan runs `runScan` against the snapshots recorded at
// its time. The scenario checks every scan against the age each changed ecosystem's snapshot has at that time: one
// older than the setting records `failure` with `config: advisory snapshot stale <ecosystem>` and runs no scanner;
// one with no snapshot records `config: advisory snapshot missing <ecosystem>`; a scan whose every snapshot is within
// the setting runs, with the recorded snapshots.
import { Effect, Layer, Match } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import type { AdvisorySnapshot } from "../../src/ports.ts";
import { Outcome } from "../../src/reasons.ts";
import { runScan, type PreparedScan } from "../../src/scan-bundle.ts";
import {
  digestOf,
  envelopeBytes,
  fakeScanImage,
  IMAGE_VERSIONS,
  memoryAdvisorySnapshots,
  memoryScanBundleStore,
  signingKey,
  validPayload,
} from "../../src/scan-bundle.test-support.ts";

const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 1, 0, 0);

/** The lockfiles a scan range may change, by ecosystem. */
const LOCKFILES: Readonly<Record<string, string>> = {
  npm: "web/pnpm-lock.yaml",
  PyPI: "api/uv.lock",
  "crates.io": "core/Cargo.lock",
};
const ECOSYSTEMS = Object.keys(LOCKFILES);

export interface AdvisorySnapshotOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

const fixtures = (async () => {
  const bytes = await envelopeBytes(validPayload(), [await signingKey("sim-advisory")]);
  return { bytes, digest: await digestOf(bytes) };
})();

/** One recorded snapshot at a time on the clock: what the control-plane store held from `at` on. */
interface Recorded {
  readonly at: number;
  readonly snapshot: AdvisorySnapshot;
}

export const simulateAdvisorySnapshot = async (seed: number): Promise<AdvisorySnapshotOutcome> => {
  const rand = seededRandom(seed);
  const { bytes, digest } = await fixtures;
  const violations: SimViolation[] = [];
  const reached: Record<string, number> = {};
  const trace: string[] = [];
  const count = (k: string) => void (reached[k] = (reached[k] ?? 0) + 1);

  const days = 2 + Math.floor(rand() * 4);
  const maxAgeHours = [6, 24, 24, 48][Math.floor(rand() * 4)]!;
  trace.push(`days=${days} maxAgeHours=${maxAgeHours}`);

  // The daily refreshes: each ecosystem's archive was last published some hours before the refresh, and a refresh may
  // fail, recording nothing. An ecosystem may start the clock with no snapshot at all.
  const history = new Map<string, Recorded[]>(ECOSYSTEMS.map((e) => [e, []]));
  for (const ecosystem of ECOSYSTEMS) {
    for (let day = 0; day < days; day++) {
      if (day === 0 && rand() < 0.15) continue;
      if (rand() < 0.3) {
        trace.push(`refresh ${ecosystem} day ${day} failed`);
        continue;
      }
      const at = START + day * 24 * HOUR + Math.floor(rand() * 4 * HOUR);
      const lastModified = at - Math.floor(rand() * 30 * HOUR);
      history.get(ecosystem)!.push({
        at,
        snapshot: { ecosystem, digest: `${ecosystem}-${day}`.padEnd(64, "0"), lastModified },
      });
      trace.push(`refresh ${ecosystem} day ${day} at=${at} lastModified=${lastModified}`);
    }
  }
  const recordedAt = (ecosystem: string, now: number): AdvisorySnapshot | null =>
    history
      .get(ecosystem)!
      .filter((r) => r.at <= now)
      .at(-1)?.snapshot ?? null;

  const scans = 6 + Math.floor(rand() * 10);
  for (let i = 0; i < scans; i++) {
    const now = START + Math.floor(rand() * days * 24 * HOUR);
    const changed = ECOSYSTEMS.filter(() => rand() < 0.5);
    const changedPaths = [...changed.map((e) => LOCKFILES[e]!), "src/app.ts"];
    const held = new Map(
      ECOSYSTEMS.flatMap((e) => {
        const s = recordedAt(e, now);
        return s === null ? [] : [[e, s] as const];
      }),
    );
    const store = memoryScanBundleStore(new Map([[digest, bytes]]));
    let prepared: PreparedScan | null = null;
    const outcome = await Effect.runPromise(
      runScan({ pin: digest, changedPaths, now, advisoryMaxAgeHours: maxAgeHours }, (p) =>
        Effect.sync(() => {
          prepared = p;
          return Outcome.success();
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            store.layer,
            fakeScanImage(IMAGE_VERSIONS, ["semgrep"]),
            memoryAdvisorySnapshots(held).layer,
          ),
        ),
      ),
    );
    const reason = Match.value(outcome).pipe(
      Match.tag("failure", (f) => f.reason as string),
      Match.orElse(() => "success"),
    );
    trace.push(`scan ${i} now=${now} changed=${changed.join(",")} -> ${reason}`);

    // The expected answer from the ages alone: the first changed ecosystem, in sorted order, with no snapshot or one
    // older than the setting decides the reason.
    const expected =
      [...changed]
        .sort()
        .map((e) => {
          const s = held.get(e);
          if (s === undefined) return `config: advisory snapshot missing ${e}`;
          if (now - s.lastModified > maxAgeHours * HOUR) return `config: advisory snapshot stale ${e}`;
          return null;
        })
        .find((r) => r !== null) ?? "success";
    const ran = prepared !== null;
    count(expected === "success" ? "fresh" : expected.split(" ")[3]!);
    if (reason !== expected)
      violations.push({
        id: "FD-GATE-107",
        message: `seed ${seed} scan ${i}: expected ${expected}, recorded ${reason}`,
      });
    if (expected !== "success" && ran)
      violations.push({
        id: "FD-GATE-107",
        message: `seed ${seed} scan ${i}: ${expected} ran a scanner`,
      });
    if (expected === "success") {
      const snapshots = (prepared as PreparedScan | null)?.snapshots ?? {};
      if (Object.keys(snapshots).sort().join(",") !== [...changed].sort().join(","))
        violations.push({
          id: "FD-GATE-107",
          message: `seed ${seed} scan ${i}: prepared snapshots ${Object.keys(snapshots).join(",")} for ${changed.join(",")}`,
        });
    }
  }
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: "advisory-snapshot",
    ids: ["FD-GATE-107"],
    run: async (seed) => throwOnViolations((await simulateAdvisorySnapshot(seed)).violations),
  },
];
