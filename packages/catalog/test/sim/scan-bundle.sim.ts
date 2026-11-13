// A security-gate scan's scan-bundle precondition as a V-SIM scenario (specs/runs/gate.md FD-GATE-102). A seed fixes a
// sequence of scans against one deployment's content-addressed store: before each, the pinned object is stored,
// deleted, made unreadable (a read the store fails) or replaced by bytes of another digest, and the image's scanner
// versions and scan-tools file drift in or out of the bundle's pins. Each scan runs `runScan`; the scenario checks that
// every scan whose object was absent or unreadable recorded `failure` with `config: scan bundle missing` and ran no
// scanner, that no failed precondition ran a scanner, and that a scan of an intact bundle on a conforming image ran.
import { Effect, Layer, Match } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import { isSuccess, Outcome } from "../../src/reasons.ts";
import { runScan } from "../../src/scan-bundle.ts";
import {
  digestOf,
  envelopeBytes,
  fakeScanImage,
  IMAGE_VERSIONS,
  memoryScanBundleStore,
  signingKey,
  validPayload,
  type StoredBundle,
} from "../../src/scan-bundle.test-support.ts";

type Held = "intact" | "absent" | "unreadable" | "other-digest";
const HELD: readonly Held[] = ["intact", "absent", "unreadable", "other-digest"];

export interface ScanBundleOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

/** One signed bundle and a second one of a different digest, signed once per process; the draws decide the rest. */
const fixtures = (async () => {
  const key = await signingKey("sim-bundle");
  const bytes = await envelopeBytes(validPayload(), [key]);
  const other = await envelopeBytes({ ...validPayload(), version: "2026.11.2" }, [key]);
  return { bytes, other, digest: await digestOf(bytes) };
})();

export const simulateScanBundle = async (seed: number): Promise<ScanBundleOutcome> => {
  const rand = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const { bytes, other, digest } = await fixtures;
  const violations: SimViolation[] = [];
  const reached: Record<string, number> = {};
  const trace: string[] = [];
  const count = (k: string) => void (reached[k] = (reached[k] ?? 0) + 1);
  const scans = 3 + Math.floor(rand() * 6);
  for (let i = 0; i < scans; i++) {
    const held = pick(HELD);
    const stored: StoredBundle =
      held === "intact" ? bytes : held === "other-digest" ? other : held;
    const versionDrift = rand() < 0.2;
    const toolDrift = rand() < 0.2;
    const versions = versionDrift ? { ...IMAGE_VERSIONS, zizmor: "2.0.0" } : IMAGE_VERSIONS;
    const tools = toolDrift ? [] : ["semgrep"];
    const store = memoryScanBundleStore(new Map([[digest, stored]]));
    let scanned = false;
    const outcome = await Effect.runPromise(
      runScan(digest, () =>
        Effect.sync(() => {
          scanned = true;
          return Outcome.success();
        }),
      ).pipe(Effect.provide(Layer.merge(store.layer, fakeScanImage(versions, tools)))),
    );
    const reason = Match.value(outcome).pipe(
      Match.tag("failure", (f) => f.reason as string),
      Match.orElse(() => "success"),
    );
    trace.push(`${i} ${held} v=${versionDrift} t=${toolDrift} -> ${reason} scanned=${scanned}`);
    if (held === "absent" || held === "unreadable") {
      count(held);
      if (reason !== "config: scan bundle missing")
        violations.push({
          id: "FD-GATE-102",
          message: `seed ${seed} scan ${i}: a ${held} bundle recorded ${reason}`,
        });
      if (scanned)
        violations.push({
          id: "FD-GATE-102",
          message: `seed ${seed} scan ${i}: a ${held} bundle ran a scanner`,
        });
      if (store.reads.length !== 1)
        violations.push({
          id: "FD-GATE-102",
          message: `seed ${seed} scan ${i}: read the store ${store.reads.length} times`,
        });
    } else if (!isSuccess(outcome) && scanned)
      violations.push({
        id: "FD-GATE-102",
        message: `seed ${seed} scan ${i}: a failed precondition (${reason}) ran a scanner`,
      });
    else if (held === "intact" && !versionDrift && !toolDrift) {
      count("intact");
      if (!scanned)
        violations.push({
          id: "FD-GATE-102",
          message: `seed ${seed} scan ${i}: an intact bundle on a conforming image recorded ${reason}`,
        });
    } else count("refused");
  }
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: "scan-bundle",
    ids: ["FD-GATE-102"],
    run: async (seed) => throwOnViolations((await simulateScanBundle(seed)).violations),
  },
];
