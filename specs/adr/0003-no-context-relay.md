# ADR-0003 — Context backends ingest GitHub directly; FlareDispatch does not relay

**Status:** proposed 2026-08-06
**Related:** [ADR-0002](./0002-memory-capability.md) — closes its final revisit trigger (a Dispatcher read endpoint for backends to pull CI-surface data)

## Context

[ADR-0002](./0002-memory-capability.md) established that runs *consume* organizational context
and never produce it, and deliberately left one question open: whether the Dispatcher should
expose a read endpoint so a context backend could pull CI-surface data from us instead of from
GitHub. We already receive every relevant webhook, hold the App installation, and keep run
history in D1 and R2 — so the relay is cheap to imagine.

Two paths were on the table for how a backend learns what happened in CI:

- **Direct** — the backend's own GitHub connector pulls from GitHub's API on its own schedule.
- **Relay** — FlareDispatch exposes a read endpoint over what it sees, and the backend pulls
  from us.

The argument for a relay rested on GitHub's API being awkward for this data. Checked against the
API rather than assumed, that argument is half true:

| Data | GitHub API | Verdict |
|---|---|---|
| Review comments | `GET /repos/{o}/{r}/pulls/comments?since=` — repo-wide, cursored | clean incremental poll |
| Workflow runs | `GET /repos/{o}/{r}/actions/runs?created=>=…` — repo-wide, filtered | clean incremental poll |
| Reviews | no repo-wide endpoint (`/pulls/reviews` → 404) — per-PR only, no `since` | per-PR fan-out |
| Check runs | no repo-wide endpoint (`/check-runs` → 404) — hangs off a ref or check-suite id | per-SHA fan-out, scales with push volume |

So two of the four are trivial, and two cost a fan-out against the 5,000/hour installation rate
limit with self-managed high-water marks.

Separately, and unaffected by any of that, a layer of what we know never reaches GitHub in a
retrievable form at all. `Finding` is a structured object — `path`, `startLine`/`endLine`,
`level`, `title`, `message` (`packages/review-agent/src/schemas.ts:24-31`) — that GitHub only
ever sees rendered, as a check annotation and as prose inside a review comment. Fetching that
comment back recovers the prose, not the structure, nor the risk tier that selected which
reviewers ran, nor the coordinator's verdict, nor the model and backend used, token spend,
admission queue time, or container timings. Our outcome taxonomy is lossy on the way out too: a
`RunSkipped` for `context-overflow` renders as a neutral check indistinguishable from any other
neutral, and the distinction exists only in our D1 row. `AcceptanceFailed.summaryMd`,
`incident/v1` packs, and writeback manifests have no GitHub representation whatsoever.

## Decision

**FlareDispatch does not relay CI or review data to context backends.** Backends ingest GitHub
through their own connector, at their own cadence, under their own credential.

Concretely, we build none of: a read endpoint for backends to poll, a push path into a backend,
a bulk export, or a stable published schema over executions, findings, or run history. The
derived layer above — structured findings, tier, verdict, cost, timings, outcome taxonomy —
stays internal and is not offered as an ingestion surface.

This closes ADR-0002's revisit trigger on the subject. Reopening it requires a new record.

## Rationale

**A relay makes someone else's ingestion depend on our uptime and our retention.** GitHub is the
more available and more durable source for everything GitHub already holds; interposing
ourselves adds a failure mode and a retention obligation without adding information.

**A pull endpoint is a product surface, not an endpoint.** Serving arbitrary backends means a
stable schema, pagination, authentication, backfill semantics, and versioning — a compatibility
contract owed indefinitely, initially for one consumer. The cost is not the route; it is never
being able to change `Finding`, `RunOutcome`, or the `executions` schema again without a
migration story for an external store.

**It reverses the ownership boundary ADR-0002 drew.** That ADR made us a consumer of context on
purpose. A relay makes us a data plane for someone else's store, which is a different product
commitment, and it is also not what a context engine's own design assumes — connectors owning
their sources is the whole point of a connector.

**The API-awkwardness argument does not carry the weight it was given.** Half the surface polls
cleanly. The remaining fan-out is a known connector-engineering problem with ordinary solutions
on the connector's side; it is not an architectural gap only we can fill.

**The derived layer is real but nobody has asked for it.** No consumer has requested structured
findings, and when one does, the cheaper answer is likely publishing specific artifacts through
the surface we already have (R2 plus the artifacts route) rather than standing up and versioning
a query API.

## Consequences

- Context backends see what GitHub sees: review comments as rendered prose, check-run
  conclusions, workflow-run metadata. They do not see structured findings, risk tier,
  coordinator verdict, model or cost data, timings, or the skipped-vs-failed distinction.
- Any use case needing the derived layer — review analytics, "which reviewer persona catches
  what", cost-per-review trends — is out of reach for a backend under this decision, and should
  be met inside FlareDispatch (dashboard, D1 queries) rather than by exporting.
- A backend wanting reviews or check runs pays per-PR and per-SHA fan-out against the
  installation rate limit. That is their engineering problem, and it is a real cost we are
  choosing not to absorb.
- Anything GitHub ages out, a poller misses. We do not backstop retention for data we are not
  relaying. (I could not confirm GitHub's current Actions log retention window in their docs, so
  treat the size of this gap as unquantified rather than small.)
- We keep the freedom to change internal shapes without a compatibility obligation to an
  external store. This is the concrete win, and it compounds — every schema in `packages/core`
  stays ours.

## Revisit triggers

- A backend consumer names a use case GitHub's API genuinely cannot serve *and* that is worth a
  versioned contract — most plausibly the structured-findings layer for review analytics.
- We publish run artifacts under a stable, authenticated naming scheme for an unrelated reason,
  making the marginal cost of an ingestion surface close to zero.
- Per-PR/per-SHA fan-out proves infeasible at the org's actual PR volume — measured against the
  installation rate limit, not assumed.
- GitHub deprecates or degrades the endpoints a connector depends on, removing the alternative
  this decision rests on.
