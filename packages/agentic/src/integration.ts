// The control plane's mounting points: the three local-work application ports in one Layer, the pr.propose and
// pr.close appliers, and the agentic catalogue entries.
import type { LocalRegistration, ReusePolicy, WritebackGate } from "@fractalboxdev/mameko-ports";
import { Layer } from "effect";
import { AGENTIC_CATALOG, agenticWriteback } from "./recipes/catalog.ts";
import { localRegistrationLayer } from "./local/registration.ts";
import { reusePolicyLayer } from "./local/reuse.ts";
import { localStoreD1, type D1Binding } from "./local/store.ts";
import { writebackGateLayer } from "./local/writeback-gate.ts";
import { applyPrClose, applyPrPropose, lookupPrPropose } from "./writeback/applier.ts";

export interface LocalPortsConfig {
  readonly db: D1Binding;
  /** Whether a run is in the catalogue the control plane serves. */
  readonly runKnown: (run: string) => boolean;
  readonly localWritebackRate?: number;
}

/**
 * `LocalRegistration`, `ReusePolicy` and `WritebackGate` over the control plane's D1 database. The Layer still needs
 * `ReuseInputs`, `PostureSource`, `GitData`, `WritebackRecords` and `CapacityUsage` from the control plane.
 */
export const localPortsLayer = (config: LocalPortsConfig) => {
  const store = localStoreD1(config.db);
  return Layer.mergeAll(
    localRegistrationLayer({ runKnown: config.runKnown }),
    reusePolicyLayer,
    writebackGateLayer({
      writebackFor: (run) => agenticWriteback(run)?.writeback,
      ...(config.localWritebackRate === undefined ? {} : { rate: config.localWritebackRate }),
    }),
  ).pipe(Layer.provide(store)) satisfies Layer.Layer<
    LocalRegistration | ReusePolicy | WritebackGate,
    never,
    unknown
  >;
};

/** The `pr.propose` and `pr.close` applier calls for a registered actuator to route by intent kind. */
export const writebackAppliers = (appLogin: string) => ({
  "pr.propose": {
    apply: applyPrPropose({ writebackFor: agenticWriteback, appLogin }),
    lookup: lookupPrPropose,
  },
  "pr.close": { apply: applyPrClose({ appLogin }) },
});

/** The agentic recipes as run-catalogue entries; none executes on the device's host OS. */
export const agenticCatalogEntries = Object.fromEntries(
  Object.entries(AGENTIC_CATALOG).map(([name, entry]) => [
    name,
    { spec: entry.spec, declaration: entry.declaration, hostExecution: false },
  ]),
);
