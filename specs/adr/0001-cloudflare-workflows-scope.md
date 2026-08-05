# ADR-0001 — Cloudflare Workflows scope: one instance per dispatch, hibernation only for bounded human decisions

**Status:** proposed 2026-08-06
**Related:** `packages/core/src/step.ts` · `apps/dispatcher/src/workflow.ts` · `runs/release-notes.ts` (the one sanctioned hibernating run) · the issue-triage design that forced the question

## Context

Every run already executes as one Cloudflare Workflows instance — `RunWorkflow` is the
only execution shape in the tree. What has never been written down is *which* of
Workflows' durability features a run may lean on, and how long an instance may live.
Two patterns exist today and nothing says when to reach for which:

- **Short-lived, one per dispatch.** `pr-review`, `check`, `offload-test`,
  `playwright-e2e`, `worker-deploy`: an event or Action arrives, an instance runs to
  completion in minutes, every durable fact lives outside it (check-runs, PR comments,
  D1 rows, R2 artifacts).
- **Long-lived and hibernating.** `release-notes` alone: it opens an approval PR, calls
  `step.waitForEvent("release approval", { type: "release-approval", timeout: "72 hours" })`
  (`runs/release-notes.ts:405-409`), and declares `maxDurationSec: 4 * 24 * 3600`
  (`:312`). A human merging or closing the PR resumes it through
  `resolveReleaseApproval` → `signalWorkflow`.

Designing issue triage forced the choice into the open. An issue's lifecycle — opened,
triaged, fix proposed, reporter confirms or never replies, reopened months later — is
exactly the shape that invites one hibernating instance per issue, with the state
machine expressed as ordinary control flow. The alternative is a fresh short instance
per webhook event, with the issue's labels as the authoritative state.

Platform facts, verified against Cloudflare docs on 2026-08-06 (Paid plan):

| | |
| --- | --- |
| Steps per instance | 10,000 default, configurable to 25,000 |
| Step duration (wall clock) | **unlimited** |
| Step compute time | 30 s default, configurable to 5 min |
| Maximum sleep | 365 days |
| Concurrent instances | 50,000 |
| Instance creation rate | 300/s per account |
| Retention of completed instance state | 30 days |
| Maximum step result size | 1 MiB |
| Persisted state per instance | 1 GB |
| Billing | 500,000 steps included/mo then $0.80 per additional 100,000; storage 1 GB included then $0.20/GB-mo; **step and storage billing begins 2026-08-10** |

So the platform does not forbid the hibernating design: instances are cheap, waits can
run a year, and 50,000 concurrent instances is far more than any repo's open issues.
The constraints that decide it are ours, not Cloudflare's.

Three repo facts the decision has to account for:

- **`limits.maxDurationSec` bounds nothing.** It is validated as positive at
  construction (`packages/core/src/define-run.ts:186`) and read by no runtime.
  `waitForExit` is a bare wait with no timeout (`packages/runtime-cf/src/sandbox-cf.ts:518-547`),
  and step wall-clock is unlimited, so a wedged step runs until something external kills
  it. (`runs/offload-test.ts:170`'s comment claiming `timeoutSec` "is still clamped by the
  run's `maxDurationSec`" is wrong.)
- **The instance id is the idempotency key.** A duplicate `create({ id })` raising
  `instance.already_exists` is swallowed as a successful dispatch
  (`apps/dispatcher/src/routes/webhook.ts:259-268`). Dedup is therefore a property of how
  we name instances, not of anything inside the run.
- **Replay re-executes anything not inside a completed step.** `self-heal-pr.ts:186-202`
  uses `runDetached` + `waitForExit` rather than one long `exec` precisely so a Worker
  eviction mid-agent does not re-spawn the agent and double-spend the model budget. The
  container's `sleepAfter = "10m"` (`apps/dispatcher/src/sandbox.ts:60`) exists for the
  same reason: the container filesystem is shared state *across* durable steps.

## Decision

Four rules govern how runs use Workflows.

**1. One dispatch, one instance, and the instance id is the semantic idempotency key.**
Every entry point (webhook, Action, schedule, child spawn) names its instance from the
event's identity — `{run}:{repo}:{sha}`, `…:i<issue>:c<comment>`, and so on. Naming is
the dedup mechanism; runs do not implement their own.

**2. A durable step is the unit of replay-safe work.** Anything inside a step may run
more than once. A step that spends money or mutates the outside world must be
individually replay-safe — either idempotent against the external system (check for the
existing PR/comment before creating it) or structured so replay observes rather than
repeats (`runDetached` then `waitForExit`, never one indivisible long `exec`). Step
results are capped at 1 MiB: large outputs go to R2 and the step returns a key.

**3. Hibernation is reserved for bounded human decisions with a named decider and a
declared timeout.** `step.waitForEvent` and long sleeps are legitimate when a specific
person owes a specific answer inside a stated window — release approval is the shape.
They are not a mechanism for waiting on the world in general.

**4. Long-lived entity lifecycles keep their state in the system of record, and get a
fresh instance per event.** When the thing being tracked is an external entity that
humans also act on — a GitHub issue, a PR, a deployment — the authoritative state is
that entity's own status field (labels, PR state, deployment status), and each webhook
event starts a short instance that reads state, acts, and writes state back.

Corollary to rules 3 and 4: wall-clock bounds must be written explicitly (`timeoutSec`
on exec, `Effect.timeoutFail` around waits, as `waitForPort` already does at
`sandbox-cf.ts:565-577`). Declaring `maxDurationSec` is documentation, not enforcement,
until that changes.

## Rationale

**The wait is unbounded and usually infinite.** `waitForEvent` requires a timeout.
Release approval survives a 72-hour bound because a named person owes the answer now.
Reporter confirmation on an issue arrives in an hour, in three weeks, or — for most
issues — never. Any timeout is then either short enough to abandon live work or long
enough to keep an instance per open issue indefinitely. The platform tolerates that; our
ability to reason about it does not.

**Most events are not the awaited one.** A suspended instance still has to be woken by
every comment to decide whether it is the one it was waiting for, and the majority
resolve to "keep waiting". The router gets rebuilt inside the resumed program, which is
the code the durable design was supposed to remove.

**Re-entry restarts the work anyway.** Issue retriage re-runs the whole
reproduce→diagnose→verify→fix pipeline when a comment adds new information. Inside a
hibernating instance that is either a loop back to the top — an explicit state machine
again — or killing the instance and starting another, which is rule 4 with extra
bookkeeping.

**External state must be authoritative because humans edit it.** Maintainers read and
change labels by hand; that *is* the status UI. If a suspended program held the real
state, a maintainer removing a label would desync it from what everyone sees and the
instance would keep acting on stale beliefs. When the system of record holds the state, a
human edit is simply a legal transition and costs nothing to support.

**Operational fit.** Completed-instance state is retained 30 days while the entities we
track live far longer, so an instance is the wrong place to look for history regardless —
D1 and the entity's own thread are. And with step and storage billing starting
2026-08-10, an instance that hibernates for months is a storage line item that buys us
nothing the system of record isn't already storing for free.

The counter-argument this rejects: hibernation gives in-memory continuity between phases,
so an agent session could survive from triage to confirmation. That continuity is worth
little here — the container is destroyed at the finalize boundary on every exit path
regardless (`workflow.ts:684-692`), so "continuity" would mean re-cloning and re-priming
anyway.

## Consequences

- Entity-driven runs re-read state from the system of record on every event: a couple of
  API calls per dispatch, traded for statelessness.
- No cross-event in-memory continuity. Anything that must persist between events is
  written to the entity (labels, comments, branch existence), to D1, or to R2.
- **No per-entity mutex.** Dedup by instance id, cooldown, and the container lease are
  dampers, not serialization; last-writer-wins races on a status field are accepted and
  must be documented per run.
- Observability loses "one instance = one entity" — the dashboard groups executions by
  entity instead, and an operator tracing an issue reads its thread plus D1 rows, not one
  instance timeline.
- `release-notes` stays exactly as it is, and is the reference implementation for rule 3.
  Any new hibernating run cites this ADR and names its decider and timeout.
- Step count and step-result size become design constraints runs are expected to respect,
  not incidental limits discovered in production.

## Revisit triggers

- Cloudflare ships a durable per-entity primitive (or Workflows gains cheap unbounded
  waits with queryable state), making one-instance-per-entity both affordable and
  inspectable.
- Post-2026-08-10 billing data shows per-event instance creation costing more than
  hibernation for our event volume — the step-count line is the one to watch.
- A run genuinely needs in-memory continuity across events that re-priming cannot
  reconstruct cheaply.
- We integrate a system of record with no writable status field, leaving nowhere external
  to keep entity state.
- `maxDurationSec` becomes enforced, or Workflows introduces an instance-level wall-clock
  bound, changing what rule 2's corollary has to do by hand.
