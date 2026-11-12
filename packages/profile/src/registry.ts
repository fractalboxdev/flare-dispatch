// The bindings and actuators the profile names, as the registry the composed control plane commits to, and the
// validation context of a production control plane that serves every declared kind. `packages/github` registers
// every actuator binding; the drift check validates the deployed document against this context (FD-OPS-021).
import { poolAdmissionCaps, profile, spendDefaults } from "./document.ts";
import type { ValidationContext } from "./validate.ts";

const ADOPTABLE = ["apply", "lookup", "reconcile"];

export const bindings: ValidationContext["bindings"] = {
  actuators: {
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
    "dispatchBodyDigest",
    "followOnRecipe",
    "commitRecipe",
    "checkOpenPayload",
    "checkStartPayload",
    "checkProgressPayload",
    "executionProgressKey",
    "prProposePayload",
    "jobRecordPayload",
    "installationOf",
    "supersessionKey",
    "cacheNamespaces",
    "capacityGrant",
  ],
};

export const validationContext: ValidationContext = {
  deployment: "production",
  phase: 0,
  bindings,
  emittedKinds: Object.keys(profile.intent_kinds),
  runs: [],
  declaredPools: poolAdmissionCaps,
  spend: spendDefaults,
};
