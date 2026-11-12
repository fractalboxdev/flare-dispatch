// The deployment's policy rules: each repository's class rules and confidentiality mode, which the overlay's
// `policy.rules` delivers through the `POLICY_RULES` var after the deploy's drift stage synced them (FD-PROF-025).
import { syncPolicyRules, type PolicyRules } from "@fractalboxdev/flare-dispatch-profile";
import { Effect } from "effect";
import type { ControlPlaneEnv } from "./config.ts";

/**
 * The synced policy rules of the `POLICY_RULES` var, none where the deployment sets no var. A rendered var arrives as
 * the object, a hand-set one as JSON text. A value policy sync refuses throws, so no request is resolved or placed
 * under a rule set the deploy would have refused, a `confidential-compute` repository read as `unclassified` among them.
 */
export const policyRulesOf = (env: Pick<ControlPlaneEnv, "POLICY_RULES">): PolicyRules => {
  const raw = env.POLICY_RULES;
  if (raw === undefined || raw === "") return {};
  const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  const synced = Effect.runSync(
    syncPolicyRules(value).pipe(
      Effect.match({
        onSuccess: (rules) => ({ rules }),
        onFailure: (refused) => ({ refused }),
      }),
    ),
  );
  if ("refused" in synced) throw synced.refused;
  return synced.rules;
};
