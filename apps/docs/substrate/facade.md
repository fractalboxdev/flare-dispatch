# Consuming the facade

The facade is the only way into the substrate ([ADR-0003](../../substrate/specs/adr/0003-facade-only-consumption.md)).
A consumer holds no Durable Object binding, no container class, no D1 — one service binding, eight
methods, plain structural types. Every type named below is documented in the
[generated reference](../reference/substrate-contract/README.md); this page is the sequence and the
handling patterns the reference does not carry.

## Bind

```jsonc
// the consumer's wrangler.jsonc
"services": [
  {
    "binding": "SUBSTRATE",
    "service": "flare-dispatch-substrate",
    "entrypoint": "FractalbotFacade"
  }
]
```

**The entrypoint name is the consumer identity.** `DispatcherFacade` and `FractalbotFacade` are
separate `WorkerEntrypoint` classes over the same implementation; which one a binding targets decides
the pool an execution lands in, the namespace its sandbox keys live in, and the ceiling its spend is
counted against. No runtime field carries identity and the substrate never trusts one
([ADR-0009](../../substrate/specs/adr/0009-two-tier-budgets.md)) — a consumer cannot claim to be
another by any value it sends. Adding a consumer means adding an entrypoint class in a reviewed PR.

Declare the binding as the contract interface:

```ts
import type {
  SubstrateFacade,
  SubstrateRecipe,
} from "@fractalboxdev/flare-dispatch-substrate-contract";

interface Env {
  /** Service binding to `flare-dispatch-substrate`, entrypoint `FractalbotFacade`. */
  readonly SUBSTRATE: SubstrateFacade;
}
```

The contract has no dependencies and imports nothing, so it never forces a consumer onto a framework.
Effect-side consumers wrap it in a layer and match refusals on `kind`; the boundary itself stays
Effect-free.

## The recipe rides every call

`SubstrateRecipe` is the consumer's one input to grant derivation, and it is passed on `ensureSandbox`,
`execUnderGrant`, `admissionEnqueue` and `admissionAttempt` rather than stored. That is deliberate:
the substrate re-derives the pool and the egress grant from the recipe on every call and never reads
state back out of a consumer, so a consumer's stale or tampered record cannot widen anything.

```ts
const recipe: SubstrateRecipe = {
  version: 3,                                   // bump to force a rebuild
  repo: { owner: "fractalboxdev", name: "flare-dispatch", ref: "main" },
};
```

The security property rides with `repo`: it must come from an input no model authored. fractalbot
parses it from the human's message and freezes it; dispatcher runs carry it in reviewed definitions.
A model-chosen repo is a model-chosen egress grant.

`version` makes restore-or-rebuild decidable without the substrate asking anyone: a call carrying a
higher version than the environment was built at gets a rebuild, and the returned
`EnsureResult.generation` bumps with `rebuilt: true`. Compare `generation` against the last one you
saw to detect that you are no longer on the tree you left.

## Two admission shapes

Wait semantics are the consumer's choice, because the two consumers need opposite ones
([ADR-0004](../../substrate/specs/adr/0004-admission-enforced-by-ticket.md)).

**Interactive work refuses fast.** An interactive task must never silently queue behind CI:

```ts
const ensured = await env.SUBSTRATE.ensureSandbox(key, recipe, { mode: "refuse" });
if (!ensured.ok) return render(ensured.refusal);  // admission-refused carries pool, busy, cap
```

**Batch work queues in the consumer's own durable machinery.** `ensureSandbox` never blocks on a
queue in either mode — the consumer drives the line and hibernates between attempts, so a wait costs
a durable step rather than a held request:

```ts
await env.SUBSTRATE.admissionEnqueue(key, recipe);
// ... in a durable step, with the consumer's own backoff:
const attempt = await env.SUBSTRATE.admissionAttempt(key, recipe);
if (!attempt.admitted) return retryLater(attempt);   // position, poolBusy, cap
```

`{ mode: "queue" }` on `ensureSandbox` expects that line to have already been driven to admission; it
refuses rather than blocks when it has not. Call `admissionRelease` when you abandon a wait, and note
that `checkpoint` and `abort` release the slot for you.

An admitted ticket expires 10 minutes after it is minted and is refreshed by exec'ing, so an
execution that sits idle past that window re-admits on its next call — which can refuse. A resume
after a long approval wait is exactly this case.

## Exec, and the fence you do not assemble

`execUnderGrant` runs the whole fence inside the substrate: stale-revoke, ensure, apply grant, run,
kill-before-revoke. A consumer supplies a command and gets back facts.

```ts
const outcome = await env.SUBSTRATE.execUnderGrant(key, {
  recipe,
  command: "pnpm install --frozen-lockfile && pnpm test",
  idempotencyKey: `${taskId}:${ordinal}`,
  logPath: `steps/${ordinal}.log`,
  timeoutMs: 600_000,
  tailBytes: 8_000,
});
```

`idempotencyKey` is a correctness requirement, not a convenience. It must be stable across retries of
one durable step and distinct across steps: a retried call with the same key joins the in-flight
command or returns its recorded receipt with `deduped: true`, and never re-runs it. Workflow replays
are the normal case, and a key derived from a timestamp turns every replay into a second execution of
the same command.

`command` is the one possibly-model-authored value on this path. It is passed through unwrapped —
running it is the point — and the boundary is the egress policy and the credential-free container,
not a shell parser. Commands matching the irreversible floor (`git push`, `wrangler deploy|secret|d1`,
`terraform apply`, `kubectl apply|delete`, package publishes, `gh release`) are refused unless the
call carries an `ApprovalAttestation`
([ADR-0007](../../substrate/specs/adr/0007-approval-attestation-at-exec.md)). The attestation binds to
the exact command text through `commandSha256` and to one step through `(taskId, ordinal)`, so an
approval clicked for step 3 cannot satisfy step 7 and cannot be replayed onto a different command.

On success you get an `ExecReceipt` — exit code, duration, a byte-clamped tail, `truncated` — plus
the `granted` host list and the count of processes the pre-revoke kill reported. Full output lives in
artifacts at `logPath`; the tail is a bounded summary, not the log.

## Every failure is a value

The substrate never throws across the boundary. Both outcome types are a discriminated union on `ok`,
and a refusal is a `SubstrateRefusal` a consumer renders directly:

```ts
if (!outcome.ok) {
  switch (outcome.refusal.kind) {
    case "admission-refused":   return busy(outcome.refusal);        // pool, poolBusy, cap, retryAfterMs
    case "approval-required":   return askHuman(outcome.refusal);    // the rule that matched, never the command
    case "attestation-rejected":return rejected(outcome.refusal);
    case "budget-stop":         return spent(outcome.refusal);       // scope + meter state
    case "recipe-rejected":     return badInput(outcome.refusal);
    case "ticket-rejected":     return retry(outcome.refusal);
    case "sandbox-unavailable": return infra(outcome.refusal);
  }
}
```

Handle every kind. `SubstrateRefusal` is the substrate's whole vocabulary for things a consumer must
act on, and a default branch that logs "something failed" throws away the one field that made the
refusal actionable. Widening this union is a breaking contract change for exactly this reason — see
[the versioning policy](contract-versioning.md).

`abort` is the exception: it never refuses. It kills what can be killed, releases the slot, reports
the count, and is idempotent on an already-gone container.

## What you do not get, on purpose

- **No pool or image class input.** Both are policy-selected inside the substrate from
  (consumer, recipe) ([ADR-0010](../../substrate/specs/adr/0010-named-image-classes-policy-selected.md)).
  `PoolName` appears only in refusals and `poolStatus()`, as observability. An execution backend a
  model can name is an egress posture a model can choose.
- **No grant vocabulary.** Grants derive from profiles reviewed inside the substrate. A recipe may
  select among named profiles through `profiles`; it can never define one. See
  [authoring a grant profile](grant-profiles.md).
- **No admission ticket.** It is minted and verified inside the substrate; consumers never carry it.
- **No verdicts.** Exit codes, durations, generations, meter state, denial counts — execution facts
  only, permanently ([ADR-0008](../../substrate/specs/adr/0008-verdict-neutral-execution-facts.md)).
  Mapping facts onto "passed", "needs review" or "awaiting human" is consumer semantics.

## Ending an execution

`checkpoint(key, reason)` snapshots the workspace, stops the container and releases the pool slot; the
next `ensureSandbox` or `execUnderGrant` restores from it. `abort(key)` skips the snapshot — the
off-switch. Neither is optional in practice: an admitted slot stops counting only once its heartbeat
goes 10 minutes stale, so a consumer that walks away from an execution parks a slot for that long,
and the default caps (`lean` 6, `browser` 3, `agent` 3, `task` 4) are small enough to feel it.
