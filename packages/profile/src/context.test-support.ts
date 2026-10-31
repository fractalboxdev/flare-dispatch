// The validation context of a control plane that serves every kind the profile
// declares. `packages/github` registers `checkRun`; the other names are the
// registry the profile commits to, listed here so the tests exercise mameko's
// binding and applier checks.
import { poolAdmissionCaps, profile, spendDefaults } from "./document.ts";
import type { ValidationContext } from "./validate.ts";

const ADOPTABLE = ["apply", "lookup", "reconcile"];

export const bindings: ValidationContext["bindings"] = {
  appliers: {
    checkRun: ADOPTABLE,
    issueComment: ADOPTABLE,
    pullReview: ADOPTABLE,
    issue: ADOPTABLE,
    pullRequest: ADOPTABLE,
    release: ADOPTABLE,
    canary: ADOPTABLE,
    webhookRedelivery: ADOPTABLE,
    labels: ["apply"],
    followOn: ["apply"],
    notifyEmail: ["apply"],
    notifySlack: ["apply"],
    notice: ["apply"],
  },
  functions: [
    "resolveClass",
    "idempotencyKeyRecipe",
    "followOnRecipe",
    "commitRecipe",
    "checkOpenPayload",
    "checkStartPayload",
    "checkProgressPayload",
    "executionProgressKey",
    "prProposePayload",
    "installationOf",
  ],
};

export const validationContext: ValidationContext = {
  deployment: "production",
  bindings,
  emittedKinds: Object.keys(profile.intent_kinds),
  runs: [],
  declaredPools: poolAdmissionCaps,
  spend: spendDefaults,
};
