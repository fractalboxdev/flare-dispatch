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

##### readFile()

```ts
readFile(key, path): Promise<ReadFileOutcome>;
```

Read one container file's full text. No grant is involved and no command
runs — this is a read of the execution's own filesystem, behind the same
ticket gate every other call crosses.

###### Parameters

###### key

`string`

###### path

`string`

###### Returns

`Promise`\<[`ReadFileOutcome`](#readfileoutcome)\>

##### startDetached()

```ts
startDetached(key, input): Promise<StartDetachedOutcome>;
```

Start a process that outlives this call, under no grant at all (ADR-0012).
The substrate's fence spares it when a later `execUnderGrant` tears down,
so a dev server started here is still listening when the next command
dials `localhost` — and still cannot reach the network between fences.

###### Parameters

###### key

`string`

###### input

[`StartDetachedInput`](#startdetachedinput)

###### Returns

`Promise`\<[`StartDetachedOutcome`](#startdetachedoutcome)\>

##### detachedStatus()

```ts
detachedStatus(key, processId): Promise<DetachedStatusOutcome>;
```

Poll one detached process. There is deliberately no `waitForExit`: a
consumer waits in its own durable steps, the shape admission already uses,
because a Worker call that blocks for a twenty-minute agent turn is not a
call.

###### Parameters

###### key

`string`

###### processId

`string`

###### Returns

`Promise`\<[`DetachedStatusOutcome`](#detachedstatusoutcome)\>

##### stopDetached()

```ts
stopDetached(key, processId): Promise<{
  ok: true;
  stopped: boolean;
}>;
```

Kill one detached process and forget it. Idempotent.

###### Parameters

###### key

`string`

###### processId

`string`

###### Returns

`Promise`\<\{
  `ok`: `true`;
  `stopped`: `boolean`;
\}\>

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

##### denials()

```ts
denials(key): Promise<readonly DenialEvent[]>;
```

The execution's egress denials, aggregated (ADR-0005). Retrieved alongside
its artifacts — a consumer renders them into a run's diagnostics or a
thread; the container is never told any of it. Empty when nothing was
refused, which is also what a `report`-mode run wants to see before it
graduates to `enforce`.

###### Parameters

###### key

`string`

###### Returns

`Promise`\<readonly [`DenialEvent`](#denialevent)[]\>

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
among them; it can never define one. The full catalog is served — the host
sets, method/path rules and deny-overrides live in the substrate's
`engine/profiles.ts`, which is the only place they can be changed.

***

### EnforcementPosition

```ts
type EnforcementPosition = "legacy" | "report" | "enforce";
```

Per-run rollout position for the egress floor (ADR-0005). A run graduates
`legacy` → `report` → `enforce`, and only after a clean report window.

- `legacy` — the pre-substrate posture: every host reachable, nothing
  inspected, nothing recorded. What a dispatcher run had before adoption.
- `report` — the same reachability, but every request is decided against the
  grant the run *would* get and each refusal is recorded as a would-be denial
  (`would-deny: …`). This is the grant-authoring loop; it blocks nothing.
  It records the missing-host case as well as the wrong-path one, because the
  position admits every host precisely so each request reaches the engine.
  It is still bounded by what the container runtime routes through that
  engine — so a clean window is evidence about observed traffic, not a proof
  that a profile is complete.
- `enforce` — deny-all with the composed grant: unadmitted hosts never leave
  the container, admitted ones are method/path-asserted, refusals are 403s.

Absent ⇒ `enforce`. A consumer that forgets the field gets the floor, never
the opt-out.

***

### SubstrateRecipe

```ts
type SubstrateRecipe = {
  version: number;
  repo?: SubstrateRepoRef;
  lfs?: boolean;
  profiles?: readonly GrantProfileName[];
  targets?: readonly string[];
  enforcement?: EnforcementPosition;
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

##### targets?

```ts
optional targets?: readonly string[];
```

Concrete hostnames for a profile that accepts dynamic targets (today only
`browser-fetch`: an e2e run drives an app whose host is a dispatch input).

The security property is where the check happens, not that one happens: a
consumer validates each host against the **host-pattern schema declared in
its reviewed run definition** and fails the dispatch when it does not match
(ADR-0005). By the time a host reaches here it has already passed that gate,
so the substrate's job is narrower — refuse a target when no selected
profile accepts one, and admit nothing that is not listed.

##### enforcement?

```ts
optional enforcement?: EnforcementPosition;
```

Rollout position for this run's egress floor. Absent ⇒ `enforce`.
Only reviewed consumer code sets it; no dispatch payload reaches this field.

***

### CredentialDescriptor

```ts
type CredentialDescriptor = {
  secretName: string;
  host: string;
  headerTemplate: string;
};
```

How a credential attaches to one host, for the writes that cannot ride
worker-side writeback (ADR-0006). The descriptor names a secret; it never
carries one, and nothing in it ever reaches a container.

The shape is exported here so consumers can *read* what a profile attaches
(documentation, refusal text) — never author it. Descriptors are frozen in
the substrate's reviewed catalog and selected by `GrantProfileName`, the same
rule ADR-0005 applies to grants: a payload may select among pre-authored
definitions, never define one. A consumer-supplied descriptor would let a
dispatch body name the secret it wants injected, which is the whole attack.

#### Properties

##### secretName

```ts
secretName: string;
```

The substrate Worker's own secret binding name (`CLOUDFLARE_API_TOKEN`).
Resolvable only against a frozen allowlist inside the substrate, so a
mis-authored descriptor cannot reach `TICKET_SECRET`.

##### host

```ts
host: string;
```

The exact host this credential attaches to. Never a glob — see below.

##### headerTemplate

```ts
headerTemplate: string;
```

The header line to send, `Name: value`, with `{{secret}}` as the single
substitution point — e.g. `authorization: Bearer {{secret}}`. A line rather
than a pair because the ADR's descriptor is a triple; it is parsed and
validated once at catalog authoring time, and a template with a CR/LF, a
malformed name, or anything other than exactly one `{{secret}}` is refused
before it can be used.

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

#### Union Members

##### Type Literal

```ts
{
  admitted: true;
  expiresAt: number;
}
```

###### admitted

```ts
admitted: true;
```

###### expiresAt

```ts
expiresAt: number;
```

ms-epoch the admission ticket expires; heartbeat by exec'ing.

***

\{
  `admitted`: `false`;
\} & [`QueuePosition`](#queueposition)

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

### DetachedProcess

```ts
type DetachedProcess = {
  id: string;
  startedAt: number;
};
```

A process the substrate is not synchronously awaiting (ADR-0012).

The id is substrate-assigned and opaque — never a container pid, which is not
a stable name across a restart and would let a consumer address a process it
did not start.

#### Properties

##### id

```ts
id: string;
```

##### startedAt

```ts
startedAt: number;
```

***

### DetachedStatus

```ts
type DetachedStatus = 
  | {
  state: "running";
}
  | {
  state: "exited";
  exitCode: number;
}
  | {
  state: "gone";
  reason: string;
};
```

What a detached process is doing. `unknown` is its own state rather than an
error: a container that slept, restarted or was checkpointed no longer has
the process, and a consumer polling from a durable step needs to tell that
apart from "still running" without catching a throw.

***

### StartDetachedInput

```ts
type StartDetachedInput = {
  recipe: SubstrateRecipe;
  command: string;
  idempotencyKey: string;
  logPath: string;
  approval?: ApprovalAttestation;
};
```

Start a process that outlives the call. **No grant is applied** — a detached
process runs under the container's deny-all floor (ADR-0012), so anything it
needs from the network has to happen inside a fenced exec instead.

`command` still crosses the ADR-0007 approval floor: starting a floor command
detached must not be a way around the floor.

#### Properties

##### recipe

```ts
recipe: SubstrateRecipe;
```

##### command

```ts
command: string;
```

##### idempotencyKey

```ts
idempotencyKey: string;
```

Stable across retries of one durable step. A retry returns the same process.

##### logPath

```ts
logPath: string;
```

Path under the execution's artifact prefix that the process's output streams to.

##### approval?

```ts
optional approval?: ApprovalAttestation;
```

Required when the command matches the irreversible floor (ADR-0007).

***

### StartDetachedOutcome

```ts
type StartDetachedOutcome = 
  | {
  ok: true;
  process: DetachedProcess;
}
  | {
  ok: false;
  refusal: SubstrateRefusal;
};
```

***

### DetachedStatusOutcome

```ts
type DetachedStatusOutcome = 
  | {
  ok: true;
  status: DetachedStatus;
}
  | {
  ok: false;
  refusal: SubstrateRefusal;
};
```

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

### ReadFileOutcome

```ts
type ReadFileOutcome = 
  | {
  ok: true;
  content: string;
}
  | {
  ok: false;
  refusal: SubstrateRefusal;
};
```

A container file read back into the consumer's Worker. The companion to
`execUnderGrant` for output too large for a receipt tail — a run writes the
full text to a file and reads it here (the dispatcher's `pr-review` does this
with `git diff --output`). Bounding what a consumer does with the content is
the consumer's problem; bounding what leaves the container is not this call's
job — the workload already authored the bytes.

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

***

### SUBSTRATE\_RECIPE\_KEYS

```ts
const SUBSTRATE_RECIPE_KEYS: readonly keyof SubstrateRecipe[];
```

Every field a recipe declares, as a value rather than a type — the runtime
witness of this contract's shape.

ADR-0010's "no pool or image *input*" was enforced only by the absence of a
field in [SubstrateRecipe](#substraterecipe), and a TypeScript type is erased. A consumer
sending `{ version: 1, pool: "agent" }` over RPC had it silently ignored — the
correct outcome — but nothing asserted the ignoring, and nothing failed if a
later refactor threaded such a field into pool selection.

This is what the substrate projects a recipe through before its admission
policy reads a field (`apps/substrate/src/admission/pools.ts`), so an
undeclared key is dropped by construction rather than ignored by luck. A
projection and not a refusal, deliberately: additive optional fields are
non-breaking here, so a newer consumer's recipe legitimately carries keys an
older substrate build has never heard of.

Consumers can read it to check what a build of this contract understands.

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
