# ADR-0002 — Org context is an optional, total `memory` capability with MCP-speaking adapters

**Status:** proposed 2026-08-06
**Related:** [ADR-0001](./0001-cloudflare-workflows-scope.md) · `packages/core/src/services/email.ts` (the total-capability precedent) · `packages/core/src/context.ts` (the `RunContext` union) · `packages/review-agent/src/backend.ts` (the namespaced-config precedent)

## Context

Runs reason from what fits in one context window: the diff, the container's clone, and
whatever the run itself fetched. `pr-review` cannot answer "was this deliberate?"; the
proposed issue-triage pipeline cannot answer "has this been reported before?"; `ci-triage-pr`
cannot answer "did this failure precede the last deploy?". Each is a retrieval question over
organizational history that no run can ask today.

Several products answer it — hosted memory services, self-hosted context engines, vector
stores behind a thin service. They differ in storage model, scoping, and freshness guarantees,
and the field moves fast enough that picking one now is picking wrong. What they increasingly
share is a protocol: MCP, with recall exposed as tools over JSON-RPC.

**FlareDispatch is a consumer of context, not a producer of it.** Backends populate themselves
by pulling their sources — GitHub included — on their own schedule. Nothing in this ADR asks a
run to write anything anywhere. (One adjacent idea is deliberately out of scope: a backend that
wants CI-surface data GitHub's API makes awkward — check runs, workflow runs, review findings,
triage verdicts — could pull it from a read endpoint on the Dispatcher, which already holds the
App installation and the run history. That is a route on the Worker, not a capability inside
the run model, and it is a separate decision.)

Two constraints shape the consuming side.

**Optionality has to be structural.** A capability most deploys don't configure must not become
a soft dependency runs quietly start needing. `email` is the precedent worth copying exactly:
it is *total* — no error channel — and an unbacked deploy gets `skipped: true` rather than a
failure (`packages/core/src/services/email.ts:39-59`). A run's verdict must never hinge on
whether a notification went out; the same holds for whether a recall returned anything.

**Recalled context is untrusted input arriving through a trusted-looking channel.** A backend
that ingests GitHub has ingested issue text written by anonymous accounts. An attacker files an
issue containing instructions, it is ingested as ordinary org content, and later a review agent
recalls it as "what the organization knows" and treats it as grounding. That is prompt
injection laundered past the fencing we already apply at the ingest edge
(`packages/core/src/incident.ts:12-22`, `ci-incident.ts:38-42`), because the payload arrives by
a different door.

On authorization: the operative control is GitHub's own, and it is already decided for us. A
run acts on a repository and posts to that repository's surfaces, so the audience of anything
it renders is exactly that repo's reader set — a fact carried on the webhook payload, not a
policy question. The one case that needs stating is cross-source: a passage from a private
non-GitHub source recalled into a public repo's PR comment leaks even though every GitHub ACL
was honored. That is handled by one rule below, not by a policy-authoring project.

## Decision

**1. A `memory` capability joins `RunContext`, exposing one total operation.**

```ts
export interface MemoryService {
  readonly recall: (req: RecallRequest) => Effect.Effect<RecallResult>;
}
```

No error channel, following `email`. Unavailability, timeouts, and backend refusals are
returned **as data**, never raised — so a run cannot fail because memory failed, and cannot be
written so that it does.

```ts
export type RecallRequest = {
  readonly query: string;
  readonly visibility: Visibility;        // rule 3
  readonly kinds?: readonly string[];     // backend-agnostic hints ("decision", "incident")
  readonly limit?: number;
};

export type RecallResult = {
  readonly passages: readonly Passage[];  // empty when unbacked, refused, or nothing matched
  readonly backend: string;               // operator-chosen id, for disclosure
  readonly skipped: boolean;              // true when no backend is configured
  readonly refusal?: RecallRefusal;       // { reason: "stale" | "scope" | "unreachable" | "timeout" | "bad-response", detail?: string }
};

export type Passage = {
  readonly text: string;
  readonly sourceLabel: string;           // human-readable provenance, always present
  readonly sourceUrl?: string;
  readonly observedAt?: string;
  readonly score?: number;
};
```

Recall only. A write operation would be speculative surface for an integration direction that
is pull-based on the backend's side.

**2. Adapters speak MCP, not a product.** Three Layers ship: `MemoryNoop` (the default — every
call returns `skipped: true`), `MemoryMcpHttp` (JSON-RPC over HTTPS to a configured endpoint),
and `MemoryMcpServiceBinding` (the same protocol over a Cloudflare Worker service binding —
same-account, no public hop, single-digit-ms). Backends are named by an operator-chosen id in
config, never by a symbol in our source. Any MCP memory server integrates by configuration; a
backend speaking something else gets its own Layer without touching the port or any run.

**3. `visibility` is a required parameter, derived from the repo, enforced by the adapter.**

```ts
export type Visibility =
  | { readonly _tag: "Public" }                        // public repo — anyone can read what we post
  | { readonly _tag: "Private"; readonly repo: string } // private repo — that repo's readers
  | { readonly _tag: "Operator" };                     // never rendered to a repo surface
```

The run derives it structurally from `repository.private` on the dispatch payload — no operator
judgment, no per-repo policy file. The adapter maps it to the backend's scoping mechanism (a
namespace, a floor-keyed corpus, a scoped credential) via `memory.visibility.<tag>` config.
**The rule that earns the parameter:** on `Public`, a backend must return only material whose
own visibility is public, and must refuse with `reason: "scope"` rather than answer more
broadly. That is what stops a private Notion page reaching a public PR thread — the leak GitHub's
ACL cannot catch, because it was never GitHub's content.

**4. Recalled passages are fenced as untrusted data at the prompt boundary.** Same treatment as
issue bodies and log tails: byte-capped, wrapped in a data fence, with a trusted preamble built
only from trusted fields stating that passages are retrieved material, not instructions. Every
passage carries `sourceLabel`, and model output derived from recall passes the existing
per-field sanitizer before reaching a comment.

**5. Configuration follows the `resolveBackend` convention.** `memory.backend` unset means no
backend — the default everywhere. Then `memory.<backend>.endpoint`, `.timeout-ms` (default low:
recall is grounding, not a dependency), `.max-passages`, `.visibility.<tag>`, plus
`<run>.memory.enabled` so a run opts in individually. A run must behave identically, minus
grounding, with the whole namespace empty.

## Rationale

**Total beats fallible for an optional capability.** The alternative — `recall` raising a
`MemoryUnavailable` that runs are expected to catch — makes optionality a discipline enforced
by review, and every new run is one forgotten `catchTag` away from a hard dependency on a
service most deploys don't run. A total port moves the guarantee into the type: there is no
error to forget. The argument is stronger here than for `email`, because recall sits *upstream*
of the model call rather than downstream of the verdict.

**MCP is the portability layer that actually exists.** The alternatives are worse in both
directions: a bespoke HTTP contract each backend must implement (nobody will), or a
lowest-common-denominator interface derived from one product's API — which couples us to it
while pretending otherwise. MCP is what memory backends already expose, so adapters stay thin
and the port stays honest. Service-binding transport earns its place independently by removing
a public hop for same-account backends, and costs one Layer.

**Visibility is a fact, not a policy.** Scoping recall to "whoever triggered the run" fails
immediately — for a webhook-triggered review the trigger is a push, and for issue triage the
nearest thing to an asker is an anonymous account with no standing. Scoping by the destination
repo is both correct and free: `repository.private` is on every payload. Making it a required
parameter means a run cannot forget the question; putting enforcement in the adapter keeps it
away from a model that attacker-controlled text can steer.

**Fencing recalled text is not distrust of the backend.** A backend's contents are only as
trustworthy as its most public source, and any backend worth integrating will have ingested
public material. The fence costs nothing and closes a channel that would otherwise bypass
input-fencing we already do.

## Consequences

- Every deploy without `memory.backend` behaves exactly as today: `recall` returns
  `{ passages: [], skipped: true }`, runs render no grounding section. No migration, no new
  required secret, no new required binding.
- `RunContext` grows from 17 services to 18; `makeCFRuntimeLive` provides `MemoryNoop` unless
  configured; `packages/core/src/fakes/` gains a scripted `MemoryFake`.
- Runs using recall must render a disclosure when `refusal` is set — "reviewed without org
  context (backend refused: stale)" — so a degraded review is visibly degraded rather than
  silently thinner. Same posture as the writeback-outcome line on a check summary.
- An adapter contract suite becomes a requirement: every Layer passes the same tests (unbacked →
  `skipped`; refusal → data, not failure; `Public` honored or refused; passages carry
  provenance). Without it, "any MCP backend works" is an aspiration.
- We take on protocol drift risk. One JSON-RPC message per request is the assumed baseline — no
  SSE or Streamable HTTP. A backend requiring streaming needs a Layer, not a port change.
- Cold-start latency on an idle backend is real (single-digit seconds is plausible). Runs should
  issue recall early — concurrent with clone or install — rather than immediately before the
  model call, and the low default timeout keeps a cold backend from stalling a review.

## Revisit triggers

- A backend we want cannot be reached over MCP, or the protocol stops covering recall — the port
  survives, the adapter set changes, but the "adapters speak MCP" rule needs restating.
- Recall becomes load-bearing rather than additive for some run. A run that is *worthless*
  without org context is a different design, and totality stops being free; it should declare a
  hard dependency explicitly rather than lean on a total port.
- `Visibility` proves too coarse — a private repo whose readers are not one floor, or a need to
  scope by team. The union grows a case; the enforcement point does not move.
- The Dispatcher gains a read endpoint for backends to pull CI-surface data, at which point the
  producing direction gets its own ADR and this one stays consumer-only.
