# ADR-0012: A process that outlives the exec fence holds no grant

- **Status:** Proposed
- **Date:** 2026-08-07

## Context

[ADR-0005](0005-deny-all-egress-with-grant-profiles.md)'s fence closes the grant window when the exec
returns: apply, run, **kill, then revoke**. The kill is what makes the revoke meaningful — a
backgrounded child would otherwise still hold the grant after it closed.

Three dispatcher runs need a process that is still running when the exec returns. `cdp-acceptance`
and `product-demo` start an app and then drive it; `self-heal-pr` runs a 10–20-minute agent whose
turn is indivisible and would blow past any exec timeout. Each uses `sandbox.runDetached` on the
dispatcher's own fleet. On the facade there is no equivalent, and the reason is not a missing
method: **what a grant means for a process the substrate is not synchronously awaiting is
undecided**, and `killAllProcesses()` is all-or-nothing, so the fence cannot spare one.

Two related surfaces are blocked behind the same runs. A preview URL (`sandbox.exposePort`) is an
*inbound* path the facade has no way to express. Tarring a directory out of the container
(`artifact.upload({ container })`) has no facade equivalent — `checkpoint` snapshots `/workspace` as
a restore cache, which is a different thing from handing a caller a blob.

Cost of leaving it: two container fleets share one account ceiling behind two admission gates — the
condition [ADR-0004](0004-admission-enforced-by-ticket.md) exists to end — and the substrate's caps
stay pinned at `CONTAINERS_CEILING = 16`.

## Decision

**A detached process holds no grant. Ever.**

The fence's grant window is the exec. A process that outlives the exec outlives the window and keeps
running under the container's floor posture: `enableInternet = false`, empty allowlist, no handler
mapped. It can serve, it can be dialled on `localhost` by a later command, and it cannot reach the
network. Egress a run needs happens inside a fence — install dependencies in one exec, start the
server detached in the next, where it needs none.

This is a decision about *semantics*, and it makes the surface small:

- `startDetached(key, input)` starts a process and returns a substrate-assigned id. It runs
  `ensure()` behind the ticket gate and crosses the ADR-0007 approval floor exactly as `exec` does —
  a floor command started detached must not be a way around the floor — and it applies **no grant**.
- `detachedStatus(key, processId)` answers running / exited-with-code / unknown. There is no
  `waitForExit` on the facade: a consumer polls from its own durable steps, the same shape admission
  already uses, because a Worker call that blocks for twenty minutes is not a call.
- `stopDetached(key, processId)` kills it and forgets it. `abort` and `checkpoint` clear every
  record with the container.

The fence's teardown becomes selective: kill every tracked process **except** the ones this
execution declared detached. With no declared process — the overwhelming majority of executions — it
is `killAllProcesses()` unchanged, so the hot path grows no new failure mode. When `listProcesses`
cannot be read, it falls back to `killAllProcesses()`: killing a declared process is a wrong answer,
leaving a grant-holder alive is a worse one.

### Preview URLs stay off the facade for now

`exposePort` is an inbound route into a container, not an egress grant, and the two need different
reasoning. Shipping it means the substrate worker owns a proxy route of its own (the dispatcher's
lives in its `index.ts`, bound to one container class), the hostname is substrate config rather than
a consumer input, and the token stays the SDK's random 16 characters — a consumer-chosen stable
token is a guessable, long-lived public door into a container. Until that route exists,
`cdp-acceptance` and `product-demo` stay on the dispatcher's fleet.

### A directory leaves the container by being written, not pulled

No facade method. The substrate already mounts R2 at `/artifacts` inside every container, prefixed
per container id, so a run that wants a directory out writes its own archive there — `tar -czf
/artifacts/report.tgz playwright-report` — inside a fence it already has. What the facade owes is
the other half: the consumer holds a sandbox key and never the container id, so it cannot address
what the run wrote. That is a retrieval surface, and it follows `denials()` exactly.

## Consequences

- **A detached process is unfenced, and while a later fence is open it shares that fence's grant.**
  It holds none of its own, but it lives in the container, so during an exec the open grant admits
  its requests too — bounded by that grant's own host, method and path rules, which is the same
  bound the fenced command has. Stated rather than papered over: it is the existing
  backgrounded-child residual (`KILL_COVERAGE_NOTE`), now sanctioned and named instead of accidental.
  The improvement is that between fences it has no grant at all, where a backgrounded child today
  survives into a window nobody reasoned about.
- The `killed` count in `ExecOutcome` now means "processes this fence killed", not "every process in
  the container". It was the only signal a `killAllProcesses` contract change would surface, and it
  still is — for the fenced set.
- Process ids are substrate-assigned UUIDs, never container pids. A consumer cannot name a process it
  did not start, and a pid is not a stable name across a container restart anyway.
- A detached process does not survive a checkpoint. `/workspace` is snapshotted and the container
  stops; the process is gone and its record with it. A consumer that checkpoints mid-run restarts it.
- The drain still waits on the preview-URL route: `cdp-acceptance` and `product-demo` keep the
  `expose-port` gap, so the `containers` stanza cannot leave the root `wrangler.jsonc` yet.
