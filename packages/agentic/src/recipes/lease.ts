// What the control plane writes into an agentic recipe's lease input for the Container pool's executor
// (specs/runs/agentic.md § Model): the model route and the control plane's origin. The input is the one lease field
// the run payload carries to the run, so the per-lease values travel there; the control plane drops any value a request
// recorded under the same key. This module imports no process or file API, so the control plane writes the shape the
// runner decodes.
import { Schema } from "effect";

/** A lease's agentic executor values, under the input's `cloudLease` key. */
export const AgentLease = Schema.Struct({
  /** The control plane's model route on its public origin, `<origin>/v1/model/completions`. */
  modelGatewayUrl: Schema.NonEmptyString,
  /** The control plane's public origin, whose executions and log routes `ExecutionsRead` reads. */
  controlPlaneUrl: Schema.NonEmptyString,
});
export type AgentLease = typeof AgentLease.Type;

/** The `cloudLease` field every agentic input declares, so the decoded input keeps the lease's values. */
export const AgentLeaseField = {
  /** The lease's executor values; absent on a lease whose control plane writes none. */
  cloudLease: Schema.optionalKey(AgentLease),
};
