// The policy rules the overlay delivers in the `POLICY_RULES` var: intake's confidentiality and class-resolution rules
// read them, and a var policy sync refuses fails the read rather than placing a repository under a weaker mode.
import { describe, expect, it } from "vitest";
import { intakeSettings } from "../src/composition.ts";
import type { ControlPlaneEnv } from "../src/config.ts";
import { confidentialCompute } from "../src/dev-repository.ts";
import { policyRulesOf } from "../src/policy.ts";

const envWith = (policyRules: unknown): ControlPlaneEnv =>
  ({
    DEPLOYMENT: "production",
    ...(policyRules === undefined ? {} : { POLICY_RULES: policyRules }),
  }) as unknown as ControlPlaneEnv;

const rules = {
  "acme/secret": [
    { match: {}, confidentiality: "confidential-compute", acceptsFailingRequiredCheck: true },
  ],
  "acme/model": [
    { match: { run: "check" }, class: "batch" },
    { match: {}, confidentiality: "confidential-model" },
  ],
};

describe("the POLICY_RULES var", () => {
  it("[FD-PROF-025] intake's confidentiality is the mode a repository's synced rule sets, and unclassified where none does", () => {
    for (const delivered of [rules, JSON.stringify(rules)]) {
      const settings = intakeSettings(envWith(delivered));
      expect(settings.confidentiality("acme/secret")).toBe("confidential-compute");
      expect(settings.confidentiality("acme/model")).toBe("confidential-model");
      expect(settings.confidentiality("acme/other")).toBe("unclassified");
      expect(settings.policyRules?.("acme/model")).toEqual(rules["acme/model"]);
      expect(settings.policyRules?.("acme/other")).toEqual([]);
      expect(confidentialCompute(envWith(delivered), "acme/secret")).toBe(true);
    }
    expect(intakeSettings(envWith(undefined)).confidentiality("acme/secret")).toBe("unclassified");
  });

  it("[FD-PROF-025] a var that sets confidential-compute without acceptsFailingRequiredCheck: true is refused, not read as unclassified", () => {
    const refused = envWith({
      "acme/secret": [{ match: {}, confidentiality: "confidential-compute" }],
    });
    expect(() => policyRulesOf(refused)).toThrow(
      expect.objectContaining({
        rejections: [
          expect.objectContaining({ path: "acme/secret[0].acceptsFailingRequiredCheck" }),
        ],
      }),
    );
    expect(() => intakeSettings(refused)).toThrow();
    expect(() => confidentialCompute(refused, "acme/secret")).toThrow();
  });
});
