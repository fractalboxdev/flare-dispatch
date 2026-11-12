// The deploy suites of `V-DEPLOY` (specs/verification.md § Harness catalog) for policy sync (specs/profile.md
// § Class resolution): `fd deploy` and `fd doctor` over the committed control-plane template, with the overlay's
// `policy.rules` checked in the drift stage and delivered in the `POLICY_RULES` var, on the fakes of `support.ts`.
import type { PolicyRules } from "@fractalboxdev/flare-dispatch-profile";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { placeholderOverlay } from "../../src/index.ts";
import { deploy, fd, isWrite, SCRIPT, world, type World } from "./support.ts";

const withRules = (rules: PolicyRules) =>
  JSON.stringify({ ...placeholderOverlay, policy: { rules } });

const policyVar = (w: World) =>
  w.scripts.get(SCRIPT)?.bindings.find((b) => b["name"] === "POLICY_RULES");

const confidential = (acceptsFailingRequiredCheck?: boolean): PolicyRules => ({
  "acme/secret": [
    {
      match: {},
      confidentiality: "confidential-compute",
      ...(acceptsFailingRequiredCheck === undefined ? {} : { acceptsFailingRequiredCheck }),
    },
  ],
});

describe("policy sync in the deploy", () => {
  it("[FD-PROF-025] fd deploy fails at the drift stage, before any write, on a rule that sets confidential-compute without acceptsFailingRequiredCheck: true", async () => {
    for (const rules of [confidential(), confidential(false)]) {
      const w = world();
      const report = await deploy(w, withRules(rules));
      expect(report.ok).toBe(false);
      expect(report.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
      expect(report.stages.at(-1)?.detail).toContain(
        "policy.rules.acme/secret[0].acceptsFailingRequiredCheck",
      );
      expect(w.calls.filter(isWrite)).toEqual([]);
      expect(w.scripts.has(SCRIPT)).toBe(false);
    }

    const checked = await Effect.runPromise(fd(world()).doctor(withRules(confidential())));
    expect(checked.ok).toBe(false);
    expect(checked.stages.at(-1)?.detail).toContain(
      "policy.rules.acme/secret[0].acceptsFailingRequiredCheck",
    );
  });

  it("[FD-PROF-025] fd deploy accepts a confidential-compute rule that sets acceptsFailingRequiredCheck: true, and delivers it to the control plane's POLICY_RULES var", async () => {
    const rules: PolicyRules = {
      ...confidential(true),
      "acme/app": [{ match: { run: "check" }, class: "batch" }],
    };
    const w = world();
    const report = await deploy(w, withRules(rules));
    expect(report.stages.find((s) => s.stage === "drift")).toMatchObject({ ok: true });
    expect(report.ok).toBe(true);
    expect(policyVar(w)).toEqual({ type: "json", name: "POLICY_RULES", json: rules });

    const none = world();
    expect((await deploy(none)).ok).toBe(true);
    expect(policyVar(none)).toEqual({ type: "json", name: "POLICY_RULES", json: {} });
  });
});
