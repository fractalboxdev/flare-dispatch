// The services the routes call. Each is FlareDispatch's application port onto a mechanism another area owns: intake's
// one door, mameko's execution record and operator operations, the incident pack, the device registry and the OIDC
// key. A route names its port; the Worker provides the Layers. Every port fails only with an error of the error model.
import type { OidcKeys } from "@fractalboxdev/flare-dispatch-cache/oidc";
import type { ConfidentialityMode } from "@fractalboxdev/flare-dispatch-profile";
import { Context, type Effect } from "effect";
import type {
  DispatchBody,
  ExecutionView,
  IncidentV1,
  KeyHistoryView,
  PolicyPublished,
  ProvenancePolicyEnvelope,
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
  /** The commit an Actions OIDC token vouches for; undefined for an Access identity or a token with no `sha`. */
  readonly vouchedSha: string | undefined;
  /** The repo manifest entry's label; undefined selects the entry with no label. */
  readonly label: string | undefined;
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
  /** Rows that finished at or after this time, in epoch milliseconds. */
  readonly finishedSince?: number;
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

/**
 * The unbounded `incident/v1` pack of a failed execution and its repository's confidentiality mode; the route bounds the
 * pack (FD-IFC-042) and strips it to the reason and the failing step names under `confidential-compute` (FD-IFC-045).
 */
export class FailureSummaries extends Context.Service<
  FailureSummaries,
  {
    readonly pack: (execution: ExecutionRecord) => Effect.Effect<IncidentV1, ApiError>;
    /** The repository's confidentiality mode ([profile.md] FD-PROF-025); `unclassified` where nothing sets one. */
    readonly confidentiality: (repository: string) => Effect.Effect<ConfidentialityMode>;
  }
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

/**
 * The GitHub App's installations, read under the App JWT across every page of `GET /app/installations` (FD-IFC-094).
 * A failed or truncated listing fails `unavailable` with no list (FD-IFC-099), and so does a deploy with no App key: an
 * empty answer would read as "no key to pause".
 */
export class DeliveryKeys extends Context.Service<
  DeliveryKeys,
  { readonly list: Effect.Effect<readonly string[], ApiError> }
>()("@fractalboxdev/flare-dispatch-api/DeliveryKeys") {}

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

/**
 * The control plane's OIDC key set: the current signing key and the keys retired by rotation, with their rotation
 * time (FD-PROV-049); `undefined` while none is set (FD-IFC-051).
 */
export class OidcKey extends Context.Service<
  OidcKey,
  { readonly keys: Effect.Effect<OidcKeys | undefined> }
>()("@fractalboxdev/flare-dispatch-api/OidcKey") {}

// --- Verification policy ---------------------------------------------------------------------------------------------

/**
 * The verification policy's versions (specs/provenance.md § Verification policy and key history). `served` answers the
 * current version, or the one `policyVersion` names, once it is logged (FD-PROV-044, FD-PROV-046); `not_found` for none.
 * `publish` checks a version (FD-PROV-047, FD-PROV-052) and appends it to the transparency log before it is served.
 * `keyHistory` answers the key history the control plane recorded, which a version must carry (FD-PROV-047).
 */
export class ProvenancePolicies extends Context.Service<
  ProvenancePolicies,
  {
    readonly served: (
      policyVersion: string | undefined,
    ) => Effect.Effect<ProvenancePolicyEnvelope, ApiError>;
    readonly publish: (
      envelope: ProvenancePolicyEnvelope,
      now: number,
    ) => Effect.Effect<typeof PolicyPublished.Type, ApiError>;
    readonly keyHistory: Effect.Effect<KeyHistoryView, ApiError>;
  }
>()("@fractalboxdev/flare-dispatch-api/ProvenancePolicies") {}

// --- Provenance statements -------------------------------------------------------------------------------------------

/** A countersigned statement as the control plane records it (specs/provenance.md § Countersignature and log). */
export interface StatementRecord {
  readonly envelopeDigest: string;
  readonly executionId: string;
  /** The repository the statement's execution ran for, `owner/name`: its visibility decides who reads it. */
  readonly repository: string;
  readonly log: "rekor" | "private";
  /** The countersigned envelope's canonical JSON: the bytes the log appends. */
  readonly envelope: string;
  /** The log's entry; `null` while the append is pending (FD-PROV-041). */
  readonly entry: {
    readonly logIndex: number;
    readonly entryId: string;
    readonly integratedTime: number;
  } | null;
}

/** One leaf's inclusion proof in the private log, against the published checkpoint. */
export interface InclusionProofRecord {
  readonly leafIndex: number;
  readonly treeSize: number;
  readonly hashes: readonly string[];
  readonly checkpoint: string;
}

/**
 * The recorded statements, read only by lookup: an execution's, or those naming one subject digest (FD-PROV-071); and
 * the private log's inclusion proof of a leaf, `null` while no published checkpoint covers it.
 */
export class ProvenanceStatements extends Context.Service<
  ProvenanceStatements,
  {
    readonly byExecution: (
      executionId: string,
    ) => Effect.Effect<readonly StatementRecord[], ApiError>;
    readonly bySubject: (digest: string) => Effect.Effect<readonly StatementRecord[], ApiError>;
    readonly inclusionProof: (
      leafIndex: number,
    ) => Effect.Effect<InclusionProofRecord | null, ApiError>;
  }
>()("@fractalboxdev/flare-dispatch-api/ProvenanceStatements") {}

/**
 * Whether a repository's GitHub visibility is `public`, which lets a caller without identity read its statements
 * (FD-IFC-053); every other visibility requires an Access JWT (FD-IFC-054). The package that mounts `/v1/provenance/*`
 * provides it. A visibility it cannot read answers `false`, so an unreadable visibility never opens a statement.
 */
export class StatementVisibility extends Context.Service<
  StatementVisibility,
  { readonly isPublic: (repository: string) => Effect.Effect<boolean> }
>()("@fractalboxdev/flare-dispatch-api/StatementVisibility") {}

export type { VerdictName };
