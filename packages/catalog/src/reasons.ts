// The outcomes a FlareDispatch run returns, typed so that a failure reason names a declared kind (FD-RUN-057,
// MAMEKO-RUN-055), a skip names a not-applicable detail the profile lists and a cancel names a declared cause.
import type { RunResult } from "@fractalboxdev/mameko-run";

/** The closed category union of mameko's run model (specs/run-model.md § Outcome partition). */
export type ReasonCategory =
  | "finding"
  | "infra"
  | "budget"
  | "capacity"
  | "deadline"
  | "halt"
  | "placement"
  | "unrecorded"
  | "config"
  | "policy";

/** mameko's built-in reason table. */
export const MAMEKO_REASON_KINDS = {
  finding: "finding",
  infra: "infra",
  internal: "infra",
  budget: "budget",
  capacity: "capacity",
  deadline: "deadline",
  halt: "halt",
  operator: "halt",
  placement: "placement",
  unrecorded: "unrecorded",
  config: "config",
  policy: "policy",
} as const satisfies Record<string, ReasonCategory>;

/**
 * The kinds FlareDispatch's run catalogue declares (specs/run-model.md § Reason kinds). `provenance` is the profile's
 * `reason_kinds` entry, which only the result-acceptance check produces, so no run may return it.
 */
export const FD_REASON_KINDS = {
  exit: "finding",
  timeout: "finding",
  output: "finding",
  install: "finding",
  discover: "finding",
  jobs: "finding",
  smoke: "finding",
  image: "finding",
  review: "finding",
  "no-fix": "finding",
  suppression: "infra",
  writeback: "policy",
  intent: "policy",
  release: "policy",
} as const satisfies Record<string, ReasonCategory>;

export type ReasonKind = keyof typeof MAMEKO_REASON_KINDS | keyof typeof FD_REASON_KINDS;

/** `<kind>[: <detail>]`, with a kind from the two tables; any other kind fails typecheck. */
export type Reason = ReasonKind | `${ReasonKind}: ${string}`;

/** The not-applicable details the profile lists (specs/run-model.md § Cancel causes and not-applicable details). */
export const NOT_APPLICABLE_DETAILS = [
  "draft-pr",
  "author-excluded",
  "path-filter",
  "not-configured",
  "nothing-to-lint",
  "every-job-skipped",
  "empty-range",
] as const;
export type NotApplicableDetail = (typeof NOT_APPLICABLE_DETAILS)[number];

/** mameko's cancel causes and the two the profile adds. */
export type CancelCause =
  | "superseded"
  | `superseded: ${string}`
  | "parent-ended"
  | "operator-cancel"
  | "pr-closed"
  | "merge-group-destroyed";

/** A run's result as FlareDispatch's recipes build it; every value is a valid mameko `RunResult`. */
export type Outcome =
  | { readonly _tag: "success" }
  | { readonly _tag: "failure"; readonly reason: Reason }
  | { readonly _tag: "cancelled"; readonly cause: CancelCause }
  | { readonly _tag: "skipped"; readonly detail: NotApplicableDetail };

export const Outcome = {
  success: (): Outcome => ({ _tag: "success" }),
  failure: (reason: Reason): Outcome => ({ _tag: "failure", reason }),
  cancelled: (cause: CancelCause): Outcome => ({ _tag: "cancelled", cause }),
  skipped: (detail: NotApplicableDetail): Outcome => ({ _tag: "skipped", detail }),
} as const;

/** The outcome as the runner's `RunResult`. */
export const toRunResult = (outcome: Outcome): RunResult => outcome;

/** Whether an outcome is `success`. */
export const isSuccess = (outcome: Outcome): boolean => outcome._tag === "success";

/** The kind of a reason: the text before the first `:`. */
export const reasonKind = (reason: string): string => reason.split(":")[0]!.trim();

/** The category a reason's kind belongs to, or `undefined` for a kind neither table declares. */
export const categoryOf = (reason: string): ReasonCategory | undefined => {
  const kind = reasonKind(reason);
  if (Object.hasOwn(FD_REASON_KINDS, kind))
    return FD_REASON_KINDS[kind as keyof typeof FD_REASON_KINDS];
  if (Object.hasOwn(MAMEKO_REASON_KINDS, kind))
    return MAMEKO_REASON_KINDS[kind as keyof typeof MAMEKO_REASON_KINDS];
  return undefined;
};

/**
 * The `config` reasons of a security-gate scan whose scan bundle or image is unusable, each recorded before any
 * scanner runs (specs/runs/gate.md FD-GATE-101 to FD-GATE-105, FD-GATE-109).
 */
export const ScanConfigReason = {
  notPinned: "config: scan bundle not pinned",
  missing: "config: scan bundle missing",
  digest: "config: scan bundle digest",
  /** A pinned envelope whose payload fails the scan bundle schema, naming the first failing path. */
  schema: (path: string): Reason => `config: scan bundle ${path === "" ? "payload" : path}`,
  scannerVersion: (scanner: string): Reason => `config: scanner version ${scanner}`,
  baselineCheck: (controlId: string): Reason => `config: baseline check ${controlId}`,
} as const satisfies Record<string, Reason | ((s: string) => Reason)>;
