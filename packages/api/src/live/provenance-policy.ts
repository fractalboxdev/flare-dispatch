// The verification policy's port over the cache area's policy publisher (packages/cache/src/provenance/policy.ts): the
// stores, the transparency log and the keys the control plane holds come from the deploy. The key history answers the
// windows the control plane recorded, which a version's key history must carry (FD-PROV-047). A refused version answers
// 400 `invalid_body` naming the reason, another envelope under a published version 409 `conflict`, a failed log append
// 503 `unavailable` with the version unserved (FD-PROV-046), and a stored version that fails the SLSA cap 503
// `misconfigured` instead of the document (FD-PROV-052).
import {
  KeyHistoryStore,
  PolicyStore,
  PolicyTransparencyLog,
  publishPolicy,
  recordedKeys,
  servedPolicy,
  type KeysInUse,
  type PolicyRefused,
} from "@fractalboxdev/flare-dispatch-cache/provenance-policy";
import { Effect, Layer } from "effect";
import { apiError } from "../errors.ts";
import { ProvenancePolicies } from "../ports.ts";

const refused = (e: PolicyRefused) =>
  Effect.fail(
    e.reason === "version-exists"
      ? apiError("conflict", e.message)
      : apiError("invalid_body", `policy refused (${e.reason}): ${e.message}`),
  );

const storeFailed = (e: { readonly message: string }) =>
  Effect.fail(apiError("unavailable", `the policy store failed: ${e.message}`));

/** The port over the policy stores and the transparency log the layer provides, with the keys the deploy holds. */
export const provenancePolicies = (
  keys: KeysInUse,
): Layer.Layer<ProvenancePolicies, never, PolicyStore | KeyHistoryStore | PolicyTransparencyLog> =>
  Layer.effect(ProvenancePolicies)(
    Effect.gen(function* () {
      const context = yield* Effect.context<
        PolicyStore | KeyHistoryStore | PolicyTransparencyLog
      >();
      return {
        served: (policyVersion) =>
          servedPolicy(policyVersion).pipe(
            Effect.provide(context),
            Effect.catchTags({
              PolicyNotFound: () =>
                Effect.fail(
                  apiError(
                    "not_found",
                    policyVersion === undefined
                      ? "no verification policy is published"
                      : `no published verification policy has policy_version ${policyVersion}`,
                  ),
                ),
              PolicyRefused: (e) =>
                Effect.fail(
                  apiError("misconfigured", `the stored policy is refused: ${e.message}`),
                ),
              PolicyStoreFailed: storeFailed,
            }),
          ),
        publish: (envelope, now) =>
          publishPolicy(envelope, keys, now).pipe(
            Effect.provide(context),
            Effect.map(({ policyVersion, entry }) => ({
              policy_version: policyVersion,
              log_index: entry.logIndex,
              integrated_time: entry.integratedTime,
            })),
            Effect.catchTags({
              PolicyRefused: refused,
              PolicyStoreFailed: storeFailed,
              LogAppendFailed: (e) =>
                Effect.fail(
                  apiError(
                    "unavailable",
                    `the transparency log append failed; the version is not served: ${e.message}`,
                  ),
                ),
              SigningKeyRetired: (e) =>
                Effect.fail(
                  apiError(
                    "misconfigured",
                    `the configured ${e.role} key ${e.kid} was retired at ${e.notAfter}`,
                  ),
                ),
            }),
          ),
        keyHistory: recordedKeys.pipe(
          Effect.provide(context),
          Effect.map((recorded) => ({
            provenance_keys: recorded.provenance,
            log_keys: recorded.log,
          })),
          Effect.catchTag("PolicyStoreFailed", storeFailed),
        ),
      };
    }),
  );
