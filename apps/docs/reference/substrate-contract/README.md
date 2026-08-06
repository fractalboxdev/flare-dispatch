# @fractalboxdev/flare-dispatch-substrate-contract

## Interfaces

### SubstrateFacade

What a consumer's service binding exposes. Implemented by the substrate's
WorkerEntrypoint classes (one named entrypoint per consumer — that binding
choice, made in reviewed wrangler config, IS the consumer identity; no
runtime field carries it, ADR-0009).

The spec writes the admission surface as `admission.enqueue/attempt/release`;
it is flattened to methods here because RPC method calls on a plain
entrypoint are the simplest shape that structured-clones. Mapping:
`admission.enqueue` → `admissionEnqueue`, etc.

#### Methods

##### ensureSandbox()

```ts
ensureSandbox(
   key, 
   recipe, 
admission): Promise<EnsureOutcome>;
```

Bring the keyed environment to the state the recipe describes.
`{mode:'refuse'}` fails fast with `admission-refused` when the pool is
full; `{mode:'queue'}` expects the consumer to have driven
admissionEnqueue/Attempt to admission first, and refuses (never blocks)
when it has not.

###### Parameters

###### key

`string`

###### recipe

[`SubstrateRecipe`](#substraterecipe)

###### admission

[`AdmissionMode`](#admissionmode)

###### Returns

`Promise`\<[`EnsureOutcome`](#ensureoutcome)\>

##### execUnderGrant()

```ts
execUnderGrant(key, input): Promise<ExecOutcome>;
```

Run one command under the recipe's grant. The whole fence — stale-revoke,
ensure, apply grant, run, kill-before-revoke — executes inside the
substrate, which derives the grant from the recipe and its own container
identity. Consumers never construct grants.

###### Parameters

###### key

`string`

###### input

[`ExecInput`](#execinput)

###### Returns

`Promise`\<[`ExecOutcome`](#execoutcome)\>

##### checkpoint()

```ts
checkpoint(key, reason): Promise<CheckpointOutcome>;
```

Snapshot the workspace and stop the container; releases the admission slot.

###### Parameters

###### key

`string`

###### reason

[`CheckpointReason`](#checkpointreason)

###### Returns

`Promise`\<[`CheckpointOutcome`](#checkpointoutcome)\>

##### abort()

```ts
abort(key): Promise<AbortOutcome>;
```

Kill + stop, skipping the snapshot — the consumer's off-switch. Idempotent.

###### Parameters

###### key

`string`

###### Returns

`Promise`\<[`AbortOutcome`](#abortoutcome)\>

##### admissionEnqueue()

```ts
admissionEnqueue(key, recipe): Promise<QueuePosition>;
```

Join the pool's FIFO line (idempotent). Pool is policy-selected from the recipe.

###### Parameters

###### key

`string`

###### recipe

[`SubstrateRecipe`](#substraterecipe)

###### Returns

`Promise`\<[`QueuePosition`](#queueposition)\>

##### admissionAttempt()

```ts
admissionAttempt(key, recipe): Promise<AttemptOutcome>;
```

One claim attempt — the consumer hibernates between attempts in its own
durable steps. The recipe rides along (as on every call) so the pool is
re-derived by policy, never read back from consumer state.

###### Parameters

###### key

`string`

###### recipe

[`SubstrateRecipe`](#substraterecipe)

###### Returns

`Promise`\<[`AttemptOutcome`](#attemptoutcome)\>

##### admissionRelease()

```ts
admissionRelease(key): Promise<void>;
```

Release the slot or leave the line. Idempotent.

###### Parameters

###### key

`string`

###### Returns

`Promise`\<`void`\>

##### poolStatus()

```ts
poolStatus(): Promise<PoolStatus>;
```

Per-pool, per-consumer occupancy.

###### Returns

`Promise`\<[`PoolStatus`](#poolstatus)\>

## Type Aliases

### SubstrateRepoRef

```ts
type SubstrateRepoRef = {
  owner: string;
  name: string;
  ref?: string;
};
```

#### Properties

##### owner

```ts
owner: string;
```

##### name

```ts
name: string;
```

##### ref?

```ts
optional ref?: string;
```

Branch, tag or sha. Defaults to the repository's default branch.

***

### GrantProfileName

```ts
type GrantProfileName = 
  | "public-repo-read"
  | "js-install"
  | "rust-install"
  | "browser-fetch"
  | "cf-api"
  | "github-api-read";
```

Named, substrate-reviewed grant profiles (ADR-0005). A recipe may select
among them; it can never define one. v1 of the engine serves
`public-repo-read` (derived from `repo`); the rest of the catalog lands with
the dispatcher's run migration.

***

### SubstrateRecipe

```ts
type SubstrateRecipe = {
  version: number;
  repo?: SubstrateRepoRef;
  lfs?: boolean;
  profiles?: readonly GrantProfileName[];
};
```

What the substrate needs to build (or restore) an execution environment and
to derive its egress grant. The security property rides with it: `repo` must
come from an input no model authored — fractalbot parses it from the human's
message and freezes it (its ADR-0005); dispatcher runs carry it in reviewed
definitions. `version` is what makes restore-or-rebuild decidable without the
substrate ever reading state back from a consumer.

#### Properties

##### version

```ts
version: number;
```

##### repo?

```ts
optional repo?: SubstrateRepoRef;
```

Absent for work that needs a shell but no repository — and then NO egress.

##### lfs?

```ts
optional lfs?: boolean;
```

Admits the LFS object host, whose paths cannot be repo-scoped. Off by default.

##### profiles?

```ts
optional profiles?: readonly GrantProfileName[];
```

Profile selection (never definition). Omitted ⇒ derived from `repo` alone.

***

### PoolName

```ts
type PoolName = "lean" | "browser" | "agent" | "task";
```

One pool per image class. Consumers never choose one — this union exists so
refusals and poolStatus() can name what they observed.

***

### AdmissionMode

```ts
type AdmissionMode = 
  | {
  mode: "refuse";
}
  | {
  mode: "queue";
  maxQueueAgeMs: number;
};
```

Consumer-chosen wait semantics. `refuse` fails fast with a typed reason (an
interactive task must never silently queue behind CI); `queue` is driven by
the consumer's own durable machinery via admissionEnqueue/Attempt/Release —
ensureSandbox never blocks on a queue in either mode.

***

### QueuePosition

```ts
type QueuePosition = {
  pool: PoolName;
  position: number;
  poolBusy: number;
  cap: number;
};
```

#### Properties

##### pool

```ts
pool: PoolName;
```

##### position

```ts
position: number;
```

Live queued executions ahead of this one (0 when next, or when admitted).

##### poolBusy

```ts
poolBusy: number;
```

Live admitted executions in the pool.

##### cap

```ts
cap: number;
```

***

### AttemptOutcome

```ts
type AttemptOutcome = 
  | {
  admitted: true;
  expiresAt: number;
}
  | {
  admitted: false;
} & QueuePosition;
```

***

### PoolStatus

```ts
type PoolStatus = {
  pools: readonly {
     pool: PoolName;
     cap: number;
     busy: number;
     queued: number;
     byConsumer: Readonly<Record<string, number>>;
  }[];
};
```

#### Properties

##### pools

```ts
pools: readonly {
  pool: PoolName;
  cap: number;
  busy: number;
  queued: number;
  byConsumer: Readonly<Record<string, number>>;
}[];
```

***

### ApprovalAttestation

```ts
type ApprovalAttestation = {
  taskId: string;
  ordinal: number;
  commandSha256: string;
  approvedBy: string;
  approvedAt: number;
};
```

The attestation that satisfies the irreversible-command floor at exec. Who
may assert differs by consumer: fractalbot after a human approval lands
(`approvedBy` = the Slack user id); dispatcher runs pre-assert in reviewed
definitions (`approvedBy: "run-definition"`). The gate is per
(taskId, ordinal) — a decision for step 3 cannot satisfy step 7 — and
`commandSha256` binds it to the exact command text.

#### Properties

##### taskId

```ts
taskId: string;
```

##### ordinal

```ts
ordinal: number;
```

##### commandSha256

```ts
commandSha256: string;
```

Lowercase hex SHA-256 of the exact command string passed to exec.

##### approvedBy

```ts
approvedBy: string;
```

##### approvedAt

```ts
approvedAt: number;
```

***

### AdmissionRefused

```ts
type AdmissionRefused = {
  kind: "admission-refused";
  pool: PoolName;
  poolBusy: number;
  cap: number;
  position?: number;
  queuedForMs?: number;
  retryAfterMs?: number;
};
```

Fail-fast admission refusal ({mode:'refuse'}), or a queue-mode timeout.

#### Properties

##### kind

```ts
kind: "admission-refused";
```

##### pool

```ts
pool: PoolName;
```

##### poolBusy

```ts
poolBusy: number;
```

##### cap

```ts
cap: number;
```

##### position?

```ts
optional position?: number;
```

##### queuedForMs?

```ts
optional queuedForMs?: number;
```

##### retryAfterMs?

```ts
optional retryAfterMs?: number;
```

***

### ApprovalRequired

```ts
type ApprovalRequired = {
  kind: "approval-required";
  rule: string;
};
```

The command matches the irreversible floor and no attestation was carried.

#### Properties

##### kind

```ts
kind: "approval-required";
```

##### rule

```ts
rule: string;
```

The floor rule that matched, e.g. "git push". Never the command itself.

***

### AttestationRejected

```ts
type AttestationRejected = {
  kind: "attestation-rejected";
  reason: string;
};
```

An attestation was carried but does not satisfy the gate.

#### Properties

##### kind

```ts
kind: "attestation-rejected";
```

##### reason

```ts
reason: string;
```

***

### BudgetStop

```ts
type BudgetStop = {
  kind: "budget-stop";
  scope: "execution" | "consumer";
  meter: {
     spentUsd: number;
     capUsd: number;
  };
};
```

A budget stop from the metered tier (ADR-0009), carrying meter state.

#### Properties

##### kind

```ts
kind: "budget-stop";
```

##### scope

```ts
scope: "execution" | "consumer";
```

##### meter

```ts
meter: {
  spentUsd: number;
  capUsd: number;
};
```

###### spentUsd

```ts
spentUsd: number;
```

###### capUsd

```ts
capUsd: number;
```

***

### RecipeRejected

```ts
type RecipeRejected = {
  kind: "recipe-rejected";
  reason: string;
};
```

The recipe cannot be served: malformed repo, unknown/unserved profile.

#### Properties

##### kind

```ts
kind: "recipe-rejected";
```

##### reason

```ts
reason: string;
```

***

### TicketRejected

```ts
type TicketRejected = {
  kind: "ticket-rejected";
  reason: string;
};
```

The admission ticket is missing, expired, or fails verification — fail closed.

#### Properties

##### kind

```ts
kind: "ticket-rejected";
```

##### reason

```ts
reason: string;
```

***

### SandboxUnavailable

```ts
type SandboxUnavailable = {
  kind: "sandbox-unavailable";
  reason: string;
};
```

Infrastructure failure surfaced as a typed fact, never a naked throw.

#### Properties

##### kind

```ts
kind: "sandbox-unavailable";
```

##### reason

```ts
reason: string;
```

***

### SubstrateRefusal

```ts
type SubstrateRefusal = 
  | AdmissionRefused
  | ApprovalRequired
  | AttestationRejected
  | BudgetStop
  | RecipeRejected
  | TicketRejected
  | SandboxUnavailable;
```

***

### SandboxKey

```ts
type SandboxKey = string;
```

The consumer's name for one execution environment. fractalbot uses
`team:channel:thread:taskId` (one sandbox per task, its ADR-0002); the
dispatcher uses its execution id. Opaque to the substrate beyond uniqueness
within a consumer; the substrate namespaces per consumer, so two consumers'
keys can never collide.

***

### EnsureResult

```ts
type EnsureResult = {
  generation: number;
  rebuilt: boolean;
};
```

#### Properties

##### generation

```ts
generation: number;
```

Bumped on every rebuild — how a caller detects it is not on the tree it left.

##### rebuilt

```ts
rebuilt: boolean;
```

***

### EnsureOutcome

```ts
type EnsureOutcome = 
  | {
  ok: true;
} & EnsureResult
  | {
  ok: false;
  refusal: SubstrateRefusal;
};
```

***

### ExecInput

```ts
type ExecInput = {
  recipe: SubstrateRecipe;
  command: string;
  idempotencyKey: string;
  logPath: string;
  timeoutMs?: number;
  tailBytes?: number;
  lfs?: boolean;
  approval?: ApprovalAttestation;
};
```

#### Properties

##### recipe

```ts
recipe: SubstrateRecipe;
```

Rides every call so the substrate can restore-or-rebuild statelessly.

##### command

```ts
command: string;
```

The one possibly-model-authored value on this path. Passed through, never wrapped.

##### idempotencyKey

```ts
idempotencyKey: string;
```

Stable across retries of one durable step, distinct across steps. A
retried call with the same key joins the in-flight command or returns its
recorded receipt (`deduped: true`) — it never re-runs (ADR-0003).

##### logPath

```ts
logPath: string;
```

Path under the execution's artifact prefix that stdout+stderr stream to.

##### timeoutMs?

```ts
optional timeoutMs?: number;
```

##### tailBytes?

```ts
optional tailBytes?: number;
```

##### lfs?

```ts
optional lfs?: boolean;
```

##### approval?

```ts
optional approval?: ApprovalAttestation;
```

Required when the command matches the irreversible floor (ADR-0007).

***

### ExecReceipt

```ts
type ExecReceipt = {
  exitCode: number;
  durationMs: number;
  deduped: boolean;
  tail: string;
  truncated: boolean;
};
```

The bounded receipt for one command; full output lives in artifacts.

#### Properties

##### exitCode

```ts
exitCode: number;
```

##### durationMs

```ts
durationMs: number;
```

##### deduped

```ts
deduped: boolean;
```

True when this call joined an earlier run of the same idempotency key.

##### tail

```ts
tail: string;
```

Clamped tail of combined stdout+stderr — bounded by `tailBytes`.

##### truncated

```ts
truncated: boolean;
```

***

### ExecOutcome

```ts
type ExecOutcome = 
  | {
  ok: true;
  receipt: ExecReceipt;
  ensured: EnsureResult;
  granted: readonly string[];
  killed: number;
}
  | {
  ok: false;
  refusal: SubstrateRefusal;
};
```

#### Union Members

##### Type Literal

```ts
{
  ok: true;
  receipt: ExecReceipt;
  ensured: EnsureResult;
  granted: readonly string[];
  killed: number;
}
```

###### ok

```ts
ok: true;
```

###### receipt

```ts
receipt: ExecReceipt;
```

###### ensured

```ts
ensured: EnsureResult;
```

###### granted

```ts
granted: readonly string[];
```

Hosts admitted for this command. Empty when the recipe grants no egress.

###### killed

```ts
killed: number;
```

Processes the pre-revoke kill reported.

***

##### Type Literal

```ts
{
  ok: false;
  refusal: SubstrateRefusal;
}
```

***

### CheckpointReason

```ts
type CheckpointReason = 
  | "turn-boundary"
  | "awaiting-approval"
  | "final"
  | string & {
};
```

Why a checkpoint is being taken. Open set; these are the expected values.

***

### CheckpointOutcome

```ts
type CheckpointOutcome = 
  | {
  ok: true;
}
  | {
  ok: false;
  refusal: SubstrateRefusal;
};
```

***

### AbortOutcome

```ts
type AbortOutcome = {
  ok: true;
  killed: number;
};
```

#### Properties

##### ok

```ts
ok: true;
```

##### killed

```ts
killed: number;
```

***

### DenialEvent

```ts
type DenialEvent = {
  host: string;
  method: string;
  path: string;
  reason: string;
  count: number;
};
```

One egress denial, aggregated per execution — platform 520s and handler 403s
both land here. Retrievable with the execution's artifacts; never surfaced
into the container (oracle resistance).

#### Properties

##### host

```ts
host: string;
```

##### method

```ts
method: string;
```

##### path

```ts
path: string;
```

##### reason

```ts
reason: string;
```

##### count

```ts
count: number;
```

## Variables

### CONTRACT\_VERSION

```ts
const CONTRACT_VERSION: 1 = 1;
```

Bumped on any breaking change to an exported shape.

## Functions

### repoSlug()

```ts
function repoSlug(repo): string;
```

`owner/name` — the form egress path rules are asserted against.

#### Parameters

##### repo

[`SubstrateRepoRef`](#substratereporef)

#### Returns

`string`

***

### isRefusalKind()

```ts
function isRefusalKind<K>(refusal, kind): refusal is Extract<AdmissionRefused, { kind: K }> | Extract<ApprovalRequired, { kind: K }> | Extract<AttestationRejected, { kind: K }> | Extract<BudgetStop, { kind: K }> | Extract<RecipeRejected, { kind: K }> | Extract<TicketRejected, { kind: K }> | Extract<SandboxUnavailable, { kind: K }>;
```

#### Type Parameters

##### K

`K` *extends* 
  \| `"admission-refused"`
  \| `"approval-required"`
  \| `"attestation-rejected"`
  \| `"budget-stop"`
  \| `"recipe-rejected"`
  \| `"ticket-rejected"`
  \| `"sandbox-unavailable"`

#### Parameters

##### refusal

[`SubstrateRefusal`](#substraterefusal)

##### kind

`K`

#### Returns

refusal is Extract\<AdmissionRefused, \{ kind: K \}\> \| Extract\<ApprovalRequired, \{ kind: K \}\> \| Extract\<AttestationRejected, \{ kind: K \}\> \| Extract\<BudgetStop, \{ kind: K \}\> \| Extract\<RecipeRejected, \{ kind: K \}\> \| Extract\<TicketRejected, \{ kind: K \}\> \| Extract\<SandboxUnavailable, \{ kind: K \}\>
