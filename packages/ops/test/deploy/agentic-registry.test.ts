// The deploy suites of `V-DEPLOY` for the registry validator of specs/runs/agentic.md § Declaration and catalog: the
// agentic recipes' declarations checked by the `deploy-dry-run` job's drift check (`staticDrift`) and by the drift
// stage of `fd deploy` and `fd doctor`, on the fakes of `support.ts`.
import { AGENTIC_CATALOG } from "@fractalboxdev/flare-dispatch-agentic";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { placeholderOverlay, type AgenticRegistry } from "../../src/index.ts";
import { staticDrift } from "../../src/cli/index.ts";
import { CONTROL_PLANE, deploy, fd, isWrite, ROOT, world } from "./support.ts";

const TEMPLATE = readFileSync(join(ROOT, CONTROL_PLANE.templatePath), "utf8");

const review = AGENTIC_CATALOG["pr-review"]!.declaration;

/** The committed catalogue with `pr-review`'s declaration replaced by `declaration`. */
const withReview = (declaration: unknown): AgenticRegistry => ({
  ...AGENTIC_CATALOG,
  "pr-review": { declaration },
});

const { dataClasses: _d, ...noClasses } = review;
const { intentKinds: _i, ...noKinds } = review;
const omissions: readonly (readonly [string, unknown])[] = [
  ["a call site's tier", { ...review, callSites: [{ name: "reviewer" }] }],
  ["the data classes", noClasses],
  ["the intent kinds", noKinds],
];

const trifecta = {
  ...review,
  dataClasses: { privateData: true, untrustedInput: true, outbound: true },
};

const agenticFindings = (registry?: AgenticRegistry) =>
  Effect.runSync(
    staticDrift(CONTROL_PLANE, TEMPLATE, placeholderOverlay, registry),
  ).findings.filter((f) => f.check === "agentic-registry");

const driftStage = (report: {
  readonly stages: readonly { stage: string; ok: boolean; detail: string }[];
}) => report.stages.find((s) => s.stage === "drift");

describe("the registry validator over the agentic recipes at deploy", () => {
  it("[FD-AGT-002] the deploy-dry-run drift check passes the committed catalogue and fails an entry omitting a call site's tier, its data classes or its intent kinds", () => {
    expect(Object.keys(AGENTIC_CATALOG)).toHaveLength(8);
    expect(agenticFindings()).toEqual([]);
    for (const [, declaration] of omissions) {
      const findings = agenticFindings(withReview(declaration));
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        path: "runs.pr-review.declaration",
        severity: "failure",
      });
      expect(findings[0]?.detail).toMatch(/^declaration: /);
    }
  });

  it("[FD-AGT-002] fd deploy fails at the drift stage, before any write, on an entry omitting a call site's tier, its data classes or its intent kinds", async () => {
    const ok = await deploy(world());
    expect(ok.ok).toBe(true);
    expect(driftStage(ok)?.detail ?? "").not.toContain("runs.");

    for (const [, declaration] of omissions) {
      const w = world();
      const report = await deploy(w, undefined, {
        agenticRegistry: withReview(declaration),
      });
      expect(report.ok).toBe(false);
      expect(report.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
      expect(report.stages.at(-1)?.detail).toContain(
        "runs.pr-review.declaration: declaration: ",
      );
      expect(w.calls.filter(isWrite)).toEqual([]);
    }

    const checked = await Effect.runPromise(
      fd(world(), { agenticRegistry: withReview(noKinds) }).doctor(
        JSON.stringify(placeholderOverlay),
      ),
    );
    expect(checked.ok).toBe(false);
    expect(driftStage(checked)?.detail).toContain("runs.pr-review.declaration");
  });

  it("[FD-AGT-004] the drift check and fd deploy reject a declaration that sets privateData, untrustedInput and outbound together, before any write", async () => {
    for (const [privateData, untrustedInput, outbound] of [
      [false, true, true],
      [true, false, true],
      [true, true, false],
    ])
      expect(
        agenticFindings(
          withReview({
            ...review,
            dataClasses: { privateData, untrustedInput, outbound },
          }),
        ),
      ).toEqual([]);

    expect(agenticFindings(withReview(trifecta))).toEqual([
      {
        check: "agentic-registry",
        path: "runs.pr-review.declaration",
        detail: "policy: trifecta",
        severity: "failure",
      },
    ]);

    const w = world();
    const report = await deploy(w, undefined, {
      agenticRegistry: withReview(trifecta),
    });
    expect(report.ok).toBe(false);
    expect(report.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
    expect(report.stages.at(-1)?.detail).toContain(
      "runs.pr-review.declaration: policy: trifecta",
    );
    expect(w.calls.filter(isWrite)).toEqual([]);
  });
});
