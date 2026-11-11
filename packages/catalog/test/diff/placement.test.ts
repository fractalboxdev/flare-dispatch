// The placement differential subject: every sampled `worker-deploy` and publishing `sandbox-image` placement stays
// off devices, the generator reaches placements that do reach a device, and, where `lake build oracle` has run, the
// compiled Lean model answers every sampled event as the TypeScript path intake takes. The `diff` job runs the subject
// on the regressions file and 10,000 traces per pull request.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import {
  canonical,
  parseRegressions,
  replayRegressions,
} from "../../../ops/src/verification/diff.ts";
import {
  ORACLE_PATH,
  placementEvent,
  runPlacement,
  subject,
  type PlacementEvent,
} from "./placement.diff.ts";

const SAMPLE = fc.sample(placementEvent, { numRuns: 4000, seed: 20261111 });
const answers = SAMPLE.map((event) => ({ event, answer: runPlacement(event) }));

/** Whether the request's class lists `device` among its kinds in the event's profile. */
const classAdmitsDevice = (e: PlacementEvent) => {
  const cls = e.profile.classes.find((c) => c.name === e.class);
  return cls !== undefined && cls.deviceEligible !== false;
};

const advertisedBy = (e: PlacementEvent, kind: string) =>
  e.advertised.find((a) => a.kind === kind)?.labels ?? [];

const workerDeploys = answers.filter(({ event }) => event.run === "worker-deploy");
const publishes = answers.filter(({ event }) => event.run === "sandbox-image" && event.publish);
const pullRequestImages = answers.filter(
  ({ event }) => event.run === "sandbox-image" && !event.publish,
);

afterAll(() => subject.close?.());

describe("placement differential subject", () => {
  it("[FD-GATE-061] every sampled worker-deploy placement is cloud-pinned and eligible for cloudflare alone, at every class and under every profile", () => {
    expect(workerDeploys.length).toBeGreaterThan(1000);
    for (const { answer } of workerDeploys) {
      expect(answer.constraints).toContain("cloud-pinned");
      expect(answer.cloudPinned).toBe(true);
      expect(answer.eligible).not.toContain("device");
      for (const k of answer.eligible) expect(k).toBe("cloudflare");
    }
    // Requests whose class admits a device, at a class other than `release`, still place on cloudflare only.
    const deviceClass = workerDeploys.filter(
      ({ event, answer }) =>
        classAdmitsDevice(event) && event.class !== "release" && answer.eligible.length > 0,
    );
    expect(deviceClass.length).toBeGreaterThan(0);
    for (const { answer } of deviceClass) expect(answer.eligible).toEqual(["cloudflare"]);
  });

  it("[FD-GATE-080] every sampled publishing sandbox-image placement is release, cloud-pinned and placed only on cloudflare advertising container-artifact", () => {
    expect(publishes.length).toBeGreaterThan(500);
    for (const { event, answer } of publishes) {
      expect(answer.className).toBe("release");
      expect(answer.constraints).toContain("cloud-pinned");
      expect(answer.labels).toContain("container-artifact");
      expect(answer.cloudPinned).toBe(true);
      expect(answer.eligible).not.toContain("device");
      for (const k of answer.placeable) {
        expect(k).toBe("cloudflare");
        expect(advertisedBy(event, k)).toContain("container-artifact");
      }
    }
    expect(publishes.some(({ answer }) => answer.placeable.includes("cloudflare"))).toBe(true);
    // A cloudflare executor eligible for the publish but without `container-artifact` does not place it.
    const unlabelled = publishes.filter(
      ({ event, answer }) =>
        answer.eligible.includes("cloudflare") &&
        !advertisedBy(event, "cloudflare").includes("container-artifact"),
    );
    expect(unlabelled.length).toBeGreaterThan(0);
    for (const { answer } of unlabelled) expect(answer.placeable).toEqual([]);
  });

  it("[FD-GATE-080] a pull-request sandbox-image placement runs required, declares no constraint, and the generator reaches it on a device", () => {
    for (const { answer } of pullRequestImages) {
      expect(answer.className).toBe("required");
      expect(answer.constraints).toEqual([]);
    }
    expect(pullRequestImages.some(({ answer }) => answer.placeable.includes("device"))).toBe(true);
  });
});

// The unit job installs no Lean toolchain, so it skips this block; the `diff` job builds the oracle and runs the
// subject itself.
describe.skipIf(!existsSync(ORACLE_PATH))("placement against the compiled oracle", () => {
  it("[FD-GATE-061] [FD-GATE-080] the oracle answers every kept regression and every sampled event as the placement intake gives", async () => {
    const regressions = parseRegressions(
      readFileSync(
        fileURLToPath(new URL("../../../../formal/regressions.jsonl", import.meta.url)),
        "utf8",
      ),
    );
    expect(await replayRegressions(subject, regressions)).toBeNull();
    const differing: PlacementEvent[] = [];
    for (const e of SAMPLE)
      if (canonical(await subject.oracle(e)) !== canonical(subject.run(e))) differing.push(e);
    expect(differing).toEqual([]);
  }, 60_000);
});
