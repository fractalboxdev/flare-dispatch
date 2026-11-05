// What intake reads of a run: its request decoder, its manifest parameters and
// input schemas, its class and the FlareDispatch declarations beside
// `defineRun`'s answer (specs/run-model.md § Run catalogue).
import { Option, Schema } from "effect";
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
}

export interface IntakeRun {
  readonly name: string;
  /** The schema a manifest entry's `params` must pass (FD-INT-018). */
  readonly params: Schema.Decoder<unknown>;
  /** The run's input schema; a dispatch's inputs and a re-run's recorded inputs must pass it (FD-INT-040, FD-INT-055). */
  readonly input: Schema.Decoder<unknown>;
  /** The request decoder: the run's input for an event, or none when the run does not answer it. */
  readonly trigger: (event: DispatchEvent, entry: EntryView) => Option.Option<unknown>;
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
  /**
   * The placement constraints and capability labels a request with these inputs declares, e.g. `cloud-pinned` for
   * `worker-deploy` and a publishing `sandbox-image` (FD-GATE-061, FD-GATE-080); none when absent.
   */
  readonly placement?: (inputs: unknown) => {
    readonly constraints: readonly string[];
    readonly labels: readonly string[];
  };
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
