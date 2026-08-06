// The substrate facade contract (apps/substrate/specs/adr/0003-facade-only-consumption.md).
//
// This is the frozen surface consumers pin: plain structural types only, so the
// shapes survive Workers RPC structured-clone and never force a consumer onto a
// framework. Effect layers wrap consumer-side; nothing here imports anything.
//
// Freeze discipline: a breaking change to any exported shape bumps
// CONTRACT_VERSION and is a consumer migration, not a refresh (fractalbot
// specs/agent-platform.md §7). Additive optional fields are non-breaking.
//
// What is deliberately NOT here:
// - No pool/image-class *input* — image class and execution tier are
//   policy-selected inside the substrate from (consumer, recipe), never named
//   by a consumer, a model, or a payload (ADR-0010). Pool names appear only in
//   refusals and poolStatus(), as observability.
// - No grant vocabulary — grants derive from definitions reviewed inside the
//   substrate (ADR-0005). A recipe may only *select* among named profiles.
// - No admission ticket — the ticket is minted and verified inside the
//   substrate (ADR-0004); consumers never carry it.

/** Bumped on any breaking change to an exported shape. */
export const CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------
// Recipes — the consumer's one input to grant derivation
// ---------------------------------------------------------------------------

export type SubstrateRepoRef = {
  owner: string;
  name: string;
  /** Branch, tag or sha. Defaults to the repository's default branch. */
  ref?: string;
};

/**
 * Named, substrate-reviewed grant profiles (ADR-0005). A recipe may select
 * among them; it can never define one. v1 of the engine serves
 * `public-repo-read` (derived from `repo`); the rest of the catalog lands with
 * the dispatcher's run migration.
 */
export type GrantProfileName =
  | "public-repo-read"
  | "js-install"
  | "rust-install"
  | "browser-fetch"
  | "cf-api"
  | "github-api-read";

/**
 * What the substrate needs to build (or restore) an execution environment and
 * to derive its egress grant. The security property rides with it: `repo` must
 * come from an input no model authored — fractalbot parses it from the human's
 * message and freezes it (its ADR-0005); dispatcher runs carry it in reviewed
 * definitions. `version` is what makes restore-or-rebuild decidable without the
 * substrate ever reading state back from a consumer.
 */
export type SubstrateRecipe = {
  version: number;
  /** Absent for work that needs a shell but no repository — and then NO egress. */
  repo?: SubstrateRepoRef;
  /** Admits the LFS object host, whose paths cannot be repo-scoped. Off by default. */
  lfs?: boolean;
  /** Profile selection (never definition). Omitted ⇒ derived from `repo` alone. */
  profiles?: readonly GrantProfileName[];
};

/** `owner/name` — the form egress path rules are asserted against. */
export function repoSlug(repo: SubstrateRepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

// ---------------------------------------------------------------------------
// Credential descriptors (ADR-0006)
// ---------------------------------------------------------------------------

/**
 * How a credential attaches to one host, for the writes that cannot ride
 * worker-side writeback (ADR-0006). The descriptor names a secret; it never
 * carries one, and nothing in it ever reaches a container.
 *
 * The shape is exported here so consumers can *read* what a profile attaches
 * (documentation, refusal text) — never author it. Descriptors are frozen in
 * the substrate's reviewed catalog and selected by `GrantProfileName`, the same
 * rule ADR-0005 applies to grants: a payload may select among pre-authored
 * definitions, never define one. A consumer-supplied descriptor would let a
 * dispatch body name the secret it wants injected, which is the whole attack.
 */
export type CredentialDescriptor = {
  /**
   * The substrate Worker's own secret binding name (`CLOUDFLARE_API_TOKEN`).
   * Resolvable only against a frozen allowlist inside the substrate, so a
   * mis-authored descriptor cannot reach `TICKET_SECRET`.
   */
  secretName: string;
  /** The exact host this credential attaches to. Never a glob — see below. */
  host: string;
  /**
   * The header line to send, `Name: value`, with `{{secret}}` as the single
   * substitution point — e.g. `authorization: Bearer {{secret}}`. A line rather
   * than a pair because the ADR's descriptor is a triple; it is parsed and
   * validated once at catalog authoring time, and a template with a CR/LF, a
   * malformed name, or anything other than exactly one `{{secret}}` is refused
   * before it can be used.
   */
  headerTemplate: string;
};

// ---------------------------------------------------------------------------
// Admission (ADR-0004)
// ---------------------------------------------------------------------------

/**
 * One pool per image class. Consumers never choose one — this union exists so
 * refusals and poolStatus() can name what they observed.
 */
export type PoolName = "lean" | "browser" | "agent" | "task";

/**
 * Consumer-chosen wait semantics. `refuse` fails fast with a typed reason (an
 * interactive task must never silently queue behind CI); `queue` is driven by
 * the consumer's own durable machinery via admissionEnqueue/Attempt/Release —
 * ensureSandbox never blocks on a queue in either mode.
 */
export type AdmissionMode =
  | { mode: "refuse" }
  | { mode: "queue"; maxQueueAgeMs: number };

export type QueuePosition = {
  pool: PoolName;
  /** Live queued executions ahead of this one (0 when next, or when admitted). */
  position: number;
  /** Live admitted executions in the pool. */
  poolBusy: number;
  cap: number;
};

export type AttemptOutcome =
  | { admitted: true; /** ms-epoch the admission ticket expires; heartbeat by exec'ing. */ expiresAt: number }
  | ({ admitted: false } & QueuePosition);

export type PoolStatus = {
  pools: readonly {
    pool: PoolName;
    cap: number;
    busy: number;
    queued: number;
    /** Live admitted executions per consumer identity. */
    byConsumer: Readonly<Record<string, number>>;
  }[];
};

// ---------------------------------------------------------------------------
// Approvals (ADR-0007)
// ---------------------------------------------------------------------------

/**
 * The attestation that satisfies the irreversible-command floor at exec. Who
 * may assert differs by consumer: fractalbot after a human approval lands
 * (`approvedBy` = the Slack user id); dispatcher runs pre-assert in reviewed
 * definitions (`approvedBy: "run-definition"`). The gate is per
 * (taskId, ordinal) — a decision for step 3 cannot satisfy step 7 — and
 * `commandSha256` binds it to the exact command text.
 */
export type ApprovalAttestation = {
  taskId: string;
  ordinal: number;
  /** Lowercase hex SHA-256 of the exact command string passed to exec. */
  commandSha256: string;
  approvedBy: string;
  approvedAt: number;
};

// ---------------------------------------------------------------------------
// Typed refusals — every failure a consumer must render, never an opaque throw
// ---------------------------------------------------------------------------

/** Fail-fast admission refusal ({mode:'refuse'}), or a queue-mode timeout. */
export type AdmissionRefused = {
  kind: "admission-refused";
  pool: PoolName;
  poolBusy: number;
  cap: number;
  position?: number;
  queuedForMs?: number;
  retryAfterMs?: number;
};

/** The command matches the irreversible floor and no attestation was carried. */
export type ApprovalRequired = {
  kind: "approval-required";
  /** The floor rule that matched, e.g. "git push". Never the command itself. */
  rule: string;
};

/** An attestation was carried but does not satisfy the gate. */
export type AttestationRejected = {
  kind: "attestation-rejected";
  reason: string;
};

/** A budget stop from the metered tier (ADR-0009), carrying meter state. */
export type BudgetStop = {
  kind: "budget-stop";
  scope: "execution" | "consumer";
  meter: { spentUsd: number; capUsd: number };
};

/** The recipe cannot be served: malformed repo, unknown/unserved profile. */
export type RecipeRejected = {
  kind: "recipe-rejected";
  reason: string;
};

/** The admission ticket is missing, expired, or fails verification — fail closed. */
export type TicketRejected = {
  kind: "ticket-rejected";
  reason: string;
};

/** Infrastructure failure surfaced as a typed fact, never a naked throw. */
export type SandboxUnavailable = {
  kind: "sandbox-unavailable";
  reason: string;
};

export type SubstrateRefusal =
  | AdmissionRefused
  | ApprovalRequired
  | AttestationRejected
  | BudgetStop
  | RecipeRejected
  | TicketRejected
  | SandboxUnavailable;

export function isRefusalKind<K extends SubstrateRefusal["kind"]>(
  refusal: SubstrateRefusal,
  kind: K,
): refusal is Extract<SubstrateRefusal, { kind: K }> {
  return refusal.kind === kind;
}

// ---------------------------------------------------------------------------
// Facade calls
// ---------------------------------------------------------------------------

/**
 * The consumer's name for one execution environment. fractalbot uses
 * `team:channel:thread:taskId` (one sandbox per task, its ADR-0002); the
 * dispatcher uses its execution id. Opaque to the substrate beyond uniqueness
 * within a consumer; the substrate namespaces per consumer, so two consumers'
 * keys can never collide.
 */
export type SandboxKey = string;

export type EnsureResult = {
  /** Bumped on every rebuild — how a caller detects it is not on the tree it left. */
  generation: number;
  rebuilt: boolean;
};

export type EnsureOutcome =
  | ({ ok: true } & EnsureResult)
  | { ok: false; refusal: SubstrateRefusal };

export type ExecInput = {
  /** Rides every call so the substrate can restore-or-rebuild statelessly. */
  recipe: SubstrateRecipe;
  /** The one possibly-model-authored value on this path. Passed through, never wrapped. */
  command: string;
  /**
   * Stable across retries of one durable step, distinct across steps. A
   * retried call with the same key joins the in-flight command or returns its
   * recorded receipt (`deduped: true`) — it never re-runs (ADR-0003).
   */
  idempotencyKey: string;
  /** Path under the execution's artifact prefix that stdout+stderr stream to. */
  logPath: string;
  timeoutMs?: number;
  tailBytes?: number;
  lfs?: boolean;
  /** Required when the command matches the irreversible floor (ADR-0007). */
  approval?: ApprovalAttestation;
};

/** The bounded receipt for one command; full output lives in artifacts. */
export type ExecReceipt = {
  exitCode: number;
  durationMs: number;
  /** True when this call joined an earlier run of the same idempotency key. */
  deduped: boolean;
  /** Clamped tail of combined stdout+stderr — bounded by `tailBytes`. */
  tail: string;
  truncated: boolean;
};

export type ExecOutcome =
  | {
      ok: true;
      receipt: ExecReceipt;
      ensured: EnsureResult;
      /** Hosts admitted for this command. Empty when the recipe grants no egress. */
      granted: readonly string[];
      /** Processes the pre-revoke kill reported. */
      killed: number;
    }
  | { ok: false; refusal: SubstrateRefusal };

/** Why a checkpoint is being taken. Open set; these are the expected values. */
export type CheckpointReason =
  | "turn-boundary"
  | "awaiting-approval"
  | "final"
  | (string & {});

export type CheckpointOutcome =
  | { ok: true }
  | { ok: false; refusal: SubstrateRefusal };

export type AbortOutcome = { ok: true; killed: number };

/**
 * One egress denial, aggregated per execution — platform 520s and handler 403s
 * both land here. Retrievable with the execution's artifacts; never surfaced
 * into the container (oracle resistance).
 */
export type DenialEvent = {
  host: string;
  method: string;
  path: string;
  reason: string;
  count: number;
};

// ---------------------------------------------------------------------------
// The facade itself (ADR-0003)
// ---------------------------------------------------------------------------

/**
 * What a consumer's service binding exposes. Implemented by the substrate's
 * WorkerEntrypoint classes (one named entrypoint per consumer — that binding
 * choice, made in reviewed wrangler config, IS the consumer identity; no
 * runtime field carries it, ADR-0009).
 *
 * The spec writes the admission surface as `admission.enqueue/attempt/release`;
 * it is flattened to methods here because RPC method calls on a plain
 * entrypoint are the simplest shape that structured-clones. Mapping:
 * `admission.enqueue` → `admissionEnqueue`, etc.
 */
export interface SubstrateFacade {
  /**
   * Bring the keyed environment to the state the recipe describes.
   * `{mode:'refuse'}` fails fast with `admission-refused` when the pool is
   * full; `{mode:'queue'}` expects the consumer to have driven
   * admissionEnqueue/Attempt to admission first, and refuses (never blocks)
   * when it has not.
   */
  ensureSandbox(
    key: SandboxKey,
    recipe: SubstrateRecipe,
    admission: AdmissionMode,
  ): Promise<EnsureOutcome>;

  /**
   * Run one command under the recipe's grant. The whole fence — stale-revoke,
   * ensure, apply grant, run, kill-before-revoke — executes inside the
   * substrate, which derives the grant from the recipe and its own container
   * identity. Consumers never construct grants.
   */
  execUnderGrant(key: SandboxKey, input: ExecInput): Promise<ExecOutcome>;

  /** Snapshot the workspace and stop the container; releases the admission slot. */
  checkpoint(key: SandboxKey, reason: CheckpointReason): Promise<CheckpointOutcome>;

  /** Kill + stop, skipping the snapshot — the consumer's off-switch. Idempotent. */
  abort(key: SandboxKey): Promise<AbortOutcome>;

  /** Join the pool's FIFO line (idempotent). Pool is policy-selected from the recipe. */
  admissionEnqueue(key: SandboxKey, recipe: SubstrateRecipe): Promise<QueuePosition>;

  /**
   * One claim attempt — the consumer hibernates between attempts in its own
   * durable steps. The recipe rides along (as on every call) so the pool is
   * re-derived by policy, never read back from consumer state.
   */
  admissionAttempt(key: SandboxKey, recipe: SubstrateRecipe): Promise<AttemptOutcome>;

  /** Release the slot or leave the line. Idempotent. */
  admissionRelease(key: SandboxKey): Promise<void>;

  /**
   * The execution's egress denials, aggregated (ADR-0005). Retrieved alongside
   * its artifacts — a consumer renders them into a run's diagnostics or a
   * thread; the container is never told any of it. Empty when nothing was
   * refused, which is also what a `report`-mode run wants to see before it
   * graduates to `enforce`.
   */
  denials(key: SandboxKey): Promise<readonly DenialEvent[]>;

  /** Per-pool, per-consumer occupancy. */
  poolStatus(): Promise<PoolStatus>;
}
