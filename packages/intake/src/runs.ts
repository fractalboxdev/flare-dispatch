// What intake reads of a run: its request decoder, its manifest parameters and
// input schemas, its class and the FlareDispatch declarations beside
// `defineRun`'s answer (specs/run-model.md § Run catalogue).
import { Option, Schema } from "effect";
import type { CommitBinding, DispatchCommit } from "@fractalboxdev/flare-dispatch-catalog";
import type { TriggerContext } from "./delivery.ts";
import type { DispatchEvent } from "./event.ts";

/** A run's `cooldown { seconds, scope }` (FD-INT-057). */
export interface Cooldown {
  readonly seconds: number;
  /** The bucket within (run, repository) the window counts in. */
  readonly scope: (inputs: unknown) => string;
}

/** One manifest entry as the run's request decoder sees it. */
export interface EntryView {
  readonly label: string | null;
  readonly params: unknown;
  /** The manifest's `skipAuthors`; absent leaves each recipe's default (FD-GATE-017). */
  readonly skipAuthors?: readonly string[];
}

export interface IntakeRun {
  readonly name: string;
  /** The schema a manifest entry's `params` must pass (FD-INT-018). */
  readonly params: Schema.Decoder<unknown>;
  /** The run's input schema; a dispatch's inputs and a re-run's recorded inputs must pass it (FD-INT-040, FD-INT-055). */
  readonly input: Schema.Decoder<unknown>;
  /** The request decoder: the run's input for an event, or none when the run does not answer it. */
  readonly trigger: (
    event: DispatchEvent,
    entry: EntryView,
    context: TriggerContext,
  ) => Option.Option<unknown>;
  /** `limits.qosClass`, the class `resolveClass` starts from. */
  readonly defaultClass: string;
  /** `limits.qosCeiling`, the highest class `resolveClass` gives the run; absent caps at `required`. */
  readonly qosCeiling?: string;
  /** The run makes hosted model calls (FD-PROF-023). */
  readonly hostedModelCalls?: boolean;
  readonly maxDurationSec: number;
  /** Whether an execution of the run owns a check run. */
  readonly ownsCheck: boolean;
  /** A gating run opens its check on a merge group's head when the check is required (FD-GH-075). */
  readonly gating: boolean;
  readonly retries: number;
  readonly cooldown?: Cooldown;
  /** The run's grants per egress phase; any grant keeps it off a host-process device (MAMEKO-LEASE-084). */
  readonly grants?: { readonly setup: readonly string[]; readonly agent: readonly string[] };
  /**
   * The placement constraints and capability labels a request with these inputs declares, e.g. `cloud-pinned` for
   * `worker-deploy` and a publishing `sandbox-image` (FD-GATE-061, FD-GATE-080); none when absent.
   */
  readonly placement?: (inputs: unknown) => {
    readonly constraints: readonly string[];
    readonly labels: readonly string[];
  };
  /**
   * The serial group a request with these inputs joins, for a run that declares `serialize`: one `worker-deploy`
   * target, `worker-deploy:<repo>@<branch>[:<label>]` (FD-GATE-063). Absent or null joins none (MAMEKO-ADM-068).
   */
  readonly serialKey?: (inputs: unknown) => string | null;
  /**
   * The inputs with the fact whether the run's check name is in the target branch's required set, for a run whose
   * body reads it (FD-AGT-092, FD-AGT-093); a run without it reads no required set at intake.
   */
  readonly requiredCheck?: (inputs: unknown, required: boolean) => unknown;
  /**
   * The pull request the inputs name, for a run with `requiredCheck`: a dispatch reads its target branch from it, and
   * null leaves the branch unknown, so the check counts as required.
   */
  readonly pullNumber?: (inputs: unknown) => number | null;
  /**
   * The run starts only from a dispatch: a follow-on intent and a local submission refuse it, and its request decoder
   * answers no webhook or schedule (FD-GATE-111).
   */
  readonly dispatchOnly?: boolean;
  /**
   * The run reports under `flare-dispatch/<run>` alone, the check name its body emits its summary under, so a
   * manifest entry of it takes no label (FD-GATE-099, FD-GATE-111).
   */
  readonly labelless?: boolean;
  /**
   * The run is a read-only scan run: its declaration sets `readOnlyScan` and passes the registry validator's rule
   * (FD-GATE-113), so a `dispatch.scoped` identity may name it, and a dispatch of it carries an `Idempotency-Key`
   * (FD-IFC-092).
   */
  readonly readOnlyScan?: boolean;
  /**
   * The dispatch's inputs bound to the commit its authorization covers: the repository, the commit intake pinned and
   * its ref, so no input names another repository or commit for the run to read (FD-GATE-112). A `Mismatch` answers
   * 400 `invalid_inputs`. A run without it takes its inputs as the caller sent them.
   */
  readonly bindCommit?: (inputs: unknown, commit: DispatchCommit) => CommitBinding;
}

/** The run catalogue: a run by name, or undefined when the deployment serves no such run. */
export type RunCatalog = (name: string) => IntakeRun | undefined;

/** `flare-dispatch/<run>` or `flare-dispatch/<run>:<checkLabel>` (FD-GH-006). */
export const checkName = (run: string, label: string | null) =>
  label === null ? `flare-dispatch/${run}` : `flare-dispatch/${run}:${label}`;

/** A check name back to its run and label, or null for a name outside `flare-dispatch/`. */
export const parseCheckName = (name: string): { run: string; label: string | null } | null => {
  if (!name.startsWith("flare-dispatch/")) return null;
  const rest = name.slice("flare-dispatch/".length);
  const colon = rest.indexOf(":");
  return colon === -1
    ? { run: rest, label: null }
    : { run: rest.slice(0, colon), label: rest.slice(colon + 1) };
};
