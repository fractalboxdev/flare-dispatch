// The run catalogue's declarations. This module imports no process or file API, so the control plane's Worker reads
// the same declarations the runner child executes.
import { buildProfile, type Deployment } from "@fractalboxdev/flare-dispatch-profile";
import { Match, Schema } from "effect";

const Label = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/));

/** The run ceiling of `check` (specs/runs/gate.md § Recipes). */
export const CHECK_MAX_DURATION_SEC = 4500;

/** The job timeout of a step that names none (FD-GATE-019). */
export const DEFAULT_STEP_TIMEOUT_SEC = 600;

/** One command of a `check` execution, taken from the dispatch inputs (FD-GATE-001). */
export const CheckStep = Schema.Struct({
  label: Label,
  command: Schema.NonEmptyString,
  timeoutSec: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: CHECK_MAX_DURATION_SEC }),
    ),
  ),
});
export type CheckStep = typeof CheckStep.Type;

export const CheckInput = Schema.Struct({
  /** The URL `git fetch` reads the commit from. */
  repo: Schema.NonEmptyString,
  sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  ref: Schema.String,
  steps: Schema.Array(CheckStep).check(Schema.isMinLength(1)),
});
export type CheckInput = typeof CheckInput.Type;

/** Each class's rank in the profile, which `defineRun` checks a run's classes against (FD-RUN-061). */
export const classRanks: Readonly<Record<string, number>> = Object.fromEntries(
  buildProfile("production").classes.map((c) => [c.name, c.rank]),
);

export const checkSpec = {
  name: "check",
  version: "2.0.0",
  input: CheckInput,
  requires: ["Workspace", "Exec"],
  labels: [],
  limits: { maxDurationSec: CHECK_MAX_DURATION_SEC, qosClass: "batch", qosCeiling: "batch" },
  retries: 0,
  constraints: [],
  grants: { setup: [], agent: [] },
  outputPaths: [],
  needsModel: false,
  intentKinds: [],
} as const;

/** What the control plane reads of a run: `defineRun`'s fields and the declarations beside them (FD-RUN-062). */
export interface CatalogEntry {
  readonly spec: typeof checkSpec;
  /**
   * The run executes on the device's host OS, outside any job sandbox. MAMEKO-ISO-001 forbids that, and no conformant
   * macOS runtime exists, so such a run stays reachable only under the `development` deployment.
   */
  readonly hostExecution: boolean;
}

const entries: Readonly<Record<string, CatalogEntry>> = {
  check: { spec: checkSpec, hostExecution: true },
};

export type RunLookup =
  | { readonly _tag: "Available"; readonly entry: CatalogEntry }
  | { readonly _tag: "HostExecutionRefused" }
  | { readonly _tag: "NotInCatalogue" };

/** Whether a run is dispatchable under a deployment; `production` refuses a host execution. */
export const lookupRun = (deployment: Deployment, run: string): RunLookup => {
  const entry = Object.hasOwn(entries, run) ? entries[run] : undefined;
  if (entry === undefined) return { _tag: "NotInCatalogue" };
  return Match.value(deployment).pipe(
    Match.when("development", (): RunLookup => ({ _tag: "Available", entry })),
    Match.when("production", (): RunLookup =>
      entry.hostExecution ? { _tag: "HostExecutionRefused" } : { _tag: "Available", entry },
    ),
    Match.exhaustive,
  );
};

/** `production` unless the process says `development`, so a device with no configuration refuses host execution. */
export const deploymentOf = (value: string | undefined): Deployment =>
  value === "development" ? "development" : "production";
