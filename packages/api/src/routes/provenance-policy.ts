// `PUT /v1/provenance-policy`: an operator publishes one verification-policy version, a DSSE envelope signed by the
// policy root key the control plane never holds (FD-PROV-045). The control plane checks it (FD-PROV-047, FD-PROV-052)
// and appends it to the transparency log before `/.well-known/flare-dispatch/provenance-policy.json` serves it
// (FD-PROV-046). `GET /v1/provenance-policy/key-history` answers the key history the control plane recorded, the
// entries a version's key history must carry unchanged (FD-PROV-047). Both surfaces admit only identities in
// `operators`.
import { Clock, Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { FlareDispatchApi } from "../declaration.ts";
import { ProvenancePolicies } from "../ports.ts";

export const ProvenancePolicyHandlers = HttpApiBuilder.group(
  FlareDispatchApi,
  "provenancePolicy",
  (handlers) =>
    handlers
      .handle("publish", ({ payload }) =>
        Effect.gen(function* () {
          const policies = yield* ProvenancePolicies;
          return yield* policies.publish(payload.envelope, yield* Clock.currentTimeMillis);
        }),
      )
      .handle("keyHistory", () =>
        Effect.flatMap(ProvenancePolicies, (policies) => policies.keyHistory),
      ),
);
