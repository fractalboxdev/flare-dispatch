// The services the routes call. Each is FlareDispatch's application port onto a mechanism another area owns: intake's
// one door, mameko's execution record and operator operations, the incident pack, the device registry and the OIDC
// key. A route names its port; the Worker provides the Layers. Every port fails only with an error of the error model.
import { Context, type Effect } from "effect";
import type {
  DispatchBody,
  ExecutionView,
  IncidentV1,
  RegisterBody,
  VerdictName,
} from "./declaration.ts";
import type { ApiError } from "./errors.ts";

// --- Intake ----------------------------------------------------------------------------------------------------------

/** A dispatch or MCP trigger, decoded and authenticated, as intake receives it (specs/intake.md § Records). */
export interface DispatchSubmission {
  readonly trigger: "dispatch" | "mcp";
  readonly run: string;
  readonly repository: string;
  readonly ref: string | undefined;
  readonly sha: string | undefined;
  readonly workflowRef: string | undefined;
  readonly inputs: unknown;
  readonly class: string | undefined;
  readonly signals: DispatchBody["signals"];
  /** The identity the gate verified: an Access identity or `actions:<repository>:<workflow ref>`. */
  readonly caller: string;
  /** A validated `Idempotency-Key` and the canonical JSON of the body it covers (FD-INT-010). */
  readonly idempotency: { readonly key: string; readonly canonicalBody: string } | undefined;
}

export type IntakeAnswer =
  | { readonly _tag: "Admitted"; readonly executionId: string; readonly class: string }
  | { readonly _tag: "Duplicate"; readonly executionId: string; readonly class: string };

/**
 * Intake's one door (FD-INT-001): the manifest, the installation, class resolution and mameko's admission. It refuses
 * with `run_not_found` (FD-IFC-028), `invalid_inputs` (FD-IFC-029), `installation_not_found` (FD-IFC-032), `conflict`
 * with the existing id (FD-IFC-036), `rate_limited`, `intake_unavailable` or `forbidden`.
 */
export class Intake extends Context.Service<
  Intake,
  { readonly submit: (submission: DispatchSubmission) => Effect.Effect<IntakeAnswer, ApiError> }
>()("@fractalboxdev/flare-dispatch-api/Intake") {}

// --- The execution record ---------------------------------------------------------------------------------------------

export interface ExecutionFilter {
  readonly run?: string;
  readonly repository?: string;
  readonly status?: ExecutionView["status"];
  readonly class?: string;
  readonly executorKind?: string;
  /** Rows strictly older than this execution id. */
  readonly before?: string;
  readonly limit: number;
}

/** An execution as the record holds it, before the route adds links. */
export interface ExecutionRecord extends ExecutionView {
  /** The identity that dispatched it, which may cancel it (FD-IFC-046). */
  readonly dispatchedBy: string | null;
}

export class Executions extends Context.Service<
  Executions,
  {
    /** Newest first; at most `limit` rows, and whether more exist. */
    readonly list: (
      filter: ExecutionFilter,
    ) => Effect.Effect<
      { readonly rows: readonly ExecutionRecord[]; readonly more: boolean },
      ApiError
    >;
    readonly get: (id: string) => Effect.Effect<ExecutionRecord | undefined, ApiError>;
  }
>()("@fractalboxdev/flare-dispatch-api/Executions") {}

/** Cancellation and supersession ([mameko admission-qos.md § Supersession]). */
export class Cancellation extends Context.Service<
  Cancellation,
  {
    readonly cancel: (request: {
      readonly executionId: string;
      readonly identity: string;
      readonly requestId: string;
    }) => Effect.Effect<void, ApiError>;
  }
>()("@fractalboxdev/flare-dispatch-api/Cancellation") {}

/** The unbounded `incident/v1` pack of a failed execution; the route bounds it (FD-IFC-042). */
export class FailureSummaries extends Context.Service<
  FailureSummaries,
  { readonly pack: (execution: ExecutionRecord) => Effect.Effect<IncidentV1, ApiError> }
>()("@fractalboxdev/flare-dispatch-api/FailureSummaries") {}

// --- Operator operations ---------------------------------------------------------------------------------------------

export type OperatorOperation =
  | { readonly _tag: "halt"; readonly state: "run" | "halt-cloud" | "halt-all" }
  | { readonly _tag: "quarantine"; readonly target: OperationTarget }
  | { readonly _tag: "release"; readonly target: OperationTarget }
  | { readonly _tag: "force-admit"; readonly executionId: string; readonly expiresAt: number }
  | { readonly _tag: "top-up"; readonly amountMicroUsd: number; readonly expiresAt: number }
  | { readonly _tag: "drain"; readonly executor: string }
  | { readonly _tag: "revoke"; readonly executor: string }
  | { readonly _tag: "pause"; readonly installation: string }
  | { readonly _tag: "resume"; readonly installation: string };

export type OperationTarget =
  | { readonly _tag: "executor"; readonly id: string }
  | { readonly _tag: "repository"; readonly id: string };

/** What every operation passes through to the coordinator's audit row (FD-IFC-083, MAMEKO-OPS-032). */
export interface OperatorCall {
  readonly identity: string;
  readonly requestId: string;
  readonly reason: string;
  readonly now: number;
}

/**
 * mameko's operator operations. A rejected `reason` answers `reason_required` (FD-IFC-047), a rejected `expires_at`
 * `invalid_body` (FD-IFC-050), and a failed store transaction `unavailable` with no state changed (FD-IFC-049).
 */
export class Operations extends Context.Service<
  Operations,
  {
    readonly apply: (
      operation: OperatorOperation,
      call: OperatorCall,
    ) => Effect.Effect<{ readonly target: string }, ApiError>;
    /** The liveness report with installation and delivery health (FD-OPS-036). */
    readonly health: Effect.Effect<Readonly<Record<string, unknown>>, ApiError>;
  }
>()("@fractalboxdev/flare-dispatch-api/Operations") {}

// --- Enrollment ------------------------------------------------------------------------------------------------------

/** mameko's `registerDevice` under the profile's `registration` (FD-IFC-086, FD-IFC-087). */
export class DeviceRegistry extends Context.Service<
  DeviceRegistry,
  {
    readonly register: (
      body: RegisterBody,
    ) => Effect.Effect<{ readonly executorId: string; readonly postureTier: string }, ApiError>;
  }
>()("@fractalboxdev/flare-dispatch-api/DeviceRegistry") {}

// --- OIDC key --------------------------------------------------------------------------------------------------------

/** The public half of the control plane's OIDC signing key; `undefined` while none is set (FD-IFC-051). */
export class OidcKey extends Context.Service<
  OidcKey,
  { readonly publicJwk: Effect.Effect<Readonly<Record<string, unknown>> | undefined> }
>()("@fractalboxdev/flare-dispatch-api/OidcKey") {}

export type { VerdictName };
