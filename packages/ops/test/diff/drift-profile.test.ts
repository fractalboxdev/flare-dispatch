// The drift-profile differential subject: on every sampled drift check whose profile document mameko's loader
// rejects, the check fails and lists every rejection, in order, after the configuration checks' findings; an accepted
// document adds nothing; the generator reaches accepted documents, validation rejections and decode rejections; and,
// where `lake build oracle` has run, the compiled Lean model answers every sampled event as `driftCheckFindings` does.
// The `diff` job runs the subject on the regressions file and 10,000 traces per pull request.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { canonical, parseRegressions, replayRegressions } from "../../src/verification/diff.ts";
import {
  driftEvent,
  loadAnswer,
  ORACLE_PATH,
  runDrift,
  subject,
  type DriftEvent,
} from "./drift-profile.diff.ts";

const SAMPLE = fc.sample(driftEvent, { numRuns: 1500, seed: 20261111 });
const checks = SAMPLE.map((event) => ({
  event,
  load: loadAnswer(event.document),
  answer: runDrift(event),
}));

afterAll(() => subject.close?.());

describe("drift-profile differential subject", () => {
  it("[FD-OPS-021] every sampled drift check whose document the profile validator rejects fails, listing every rejection in order after the configuration checks' findings", () => {
    const rejected = checks.flatMap(({ event, load, answer }) =>
      load._tag === "rejected" ? [{ event, rejections: load.rejections, answer }] : [],
    );
    expect(rejected.length).toBeGreaterThan(500);
    for (const { event, rejections, answer } of rejected) {
      expect(rejections.length).toBeGreaterThan(0);
      expect(answer.fails).toBe(true);
      const n = event.configFindings.length;
      expect(answer.findings.length).toBe(n + rejections.length);
      expect(answer.findings.slice(0, n)).toEqual(
        event.configFindings.map((f) => ({
          check: f.check,
          path: f.path,
          detail: f.detail,
          failure: f.severity === "failure",
        })),
      );
      expect(answer.findings.slice(n)).toEqual(
        rejections.map((r) => ({
          check: "profile",
          path: r.path === "" ? r.item : r.path,
          detail: r.reason,
          failure: true,
        })),
      );
    }
    // Rejections with only warnings from the configuration checks still fail the check.
    expect(
      rejected.some(({ event }) => event.configFindings.every((f) => f.severity === "warning")),
    ).toBe(true);
  });

  it("[FD-OPS-021] an accepted document adds no finding, and the generator reaches accepted documents, validation rejections and decode rejections", () => {
    const accepted = checks.filter(({ load }) => load._tag === "accepted");
    expect(accepted.length).toBeGreaterThan(50);
    for (const { event, answer } of accepted) {
      expect(answer.findings.length).toBe(event.configFindings.length);
      expect(answer.fails).toBe(event.configFindings.some((f) => f.severity === "failure"));
    }
    const rejections = checks.flatMap(({ load }) =>
      load._tag === "rejected" ? load.rejections : [],
    );
    // A decode rejection names the document with an empty path; a validation rejection names its path.
    expect(rejections.some((r) => r.path === "" && r.item === "document")).toBe(true);
    expect(rejections.some((r) => r.path.startsWith("classes["))).toBe(true);
    expect(rejections.some((r) => r.path.startsWith("registration."))).toBe(true);
    expect(rejections.some((r) => r.path === "policy_version")).toBe(true);
    expect(checks.some(({ load }) => load._tag === "rejected" && load.rejections.length > 2)).toBe(
      true,
    );
  });
});

// The unit job installs no Lean toolchain, so it skips this block; the `diff` job builds the oracle and runs the
// subject itself.
describe.skipIf(!existsSync(ORACLE_PATH))("drift-profile against the compiled oracle", () => {
  it("[FD-OPS-021] the oracle answers every kept regression and every sampled drift check as driftCheckFindings does", async () => {
    const regressions = parseRegressions(
      readFileSync(join(import.meta.dirname, "../../../../formal/regressions.jsonl"), "utf8"),
    );
    expect(await replayRegressions(subject, regressions)).toBeNull();
    const differing: DriftEvent[] = [];
    for (const e of SAMPLE)
      if (canonical(await subject.oracle(e)) !== canonical(subject.run(e))) differing.push(e);
    expect(differing).toEqual([]);
  }, 60_000);
});
