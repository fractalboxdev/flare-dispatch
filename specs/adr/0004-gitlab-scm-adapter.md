# ADR-0004 — A provider-neutral `Scm` port backs the GitLab merge-request adapter

**Status:** proposed 2026-09-15

This record stays `proposed` until maintainers accept it together with the change it documents.

## Context

FlareDispatch's review engine has so far spoken to exactly one forge: GitHub, through the
`github-app` package and the check-run-based `pr-review` run. Reviewing a **GitLab merge
request** the same way needs a second forge behind the same engine — without forking the
engine itself, and without hard-wiring a second provider's shapes (REST payloads, auth headers,
note vs. review-comment semantics) into code that should not need to know which forge it is
running against.

The review engine already solved an analogous problem for models: `modelGateway` is a
capability whose interface names the CAPABILITY, not the provider — `env.AI` / Anthropic /
Bedrock are backends selected by a Layer, and the engine calls the capability without knowing
which one is live. Source control had no equivalent seam; GitHub access was reached directly
through `github-app`, with no port between the engine and the provider.

## Decision

**Apply the `modelGateway` move to source control.** Add a small, provider-blind `Scm` port in
`packages/core` — `fetchDiff(ref) → { diff, truncated?, pages? }`, `postReview({ ref, body }) →
{ noteId }`, and `updateReview({ ref, noteId, body }) → void` — that a `defineRun` body calls
exactly like any other capability, with no forge-specific shape leaking through. `truncated` /
`pages` are optional: a Layer that cannot detect truncation (or a fake) omits them, read as "not
truncated" / "unknown page count" rather than a hard requirement every `ScmService` must compute.

Back that port for GitLab with three pieces, each doing one job:

- **`gitlab-app`** — a small, Effect-free REST adapter: token-authenticated GitLab API calls
  (`fetchMergeRequestDiff`, `postMergeRequestNote`, `updateMergeRequestNote`), no App/install
  flow, no check-run surface.
- **`scm-gitlab`** — the runtime `Scm` Layer (`makeGitlabScmLive`) that wraps `gitlab-app` onto
  the port, mapping provider errors onto the port's closed `ScmError.reason` union.
- **`mr-review`** — the run: a flat Effect over `Config | ModelGateway | Scm` reusing the
  review engine's own fan-out (noise-stripping, risk tier, domain reviewers, naive seats,
  adversarial verification) unchanged.

Two driving adapters turn a GitLab event into a run: the webhook route
(`POST /v1/webhooks/gitlab`) verifies and gates a `merge_request` event, and
`GitlabReviewWorkflow` runs the durable steps (insert a row, post a placeholder note, run the
review, post the result, notify on failure, finalize).

The adapter's output is deliberately narrow: **one note, never an approval or a commit
status.** GitLab's MR approval/status surface is not touched — the verdict lives entirely in
the posted note, the same posture the port's interface enforces (there is no `setStatus`
method to reach for).

Around that shape, the adapter carries a set of **operational controls**, load-bearing for
running unattended against a live GitLab instance rather than a demo: MR **labels**
(`skip-ai-review` / `request-ai-review`), a **draft gate** (skip Draft/WIP MRs by default), a
per-MR **throttle** (bounded dispatch rate), the **explicit-review cap** (`request-ai-review`
bypasses the throttle's CHECK but is itself capped at 6 forced reviews per MR per rolling 60
minutes), a **project allowlist** (`GITLAB_ALLOWED_PROJECT_IDS` — unset means every project the
webhook fires for is allowed), a **self-hosted base URL** (`GITLAB_BASE_URL`, default
`https://gitlab.com/api/v4`), an operator **pause key**, a **placeholder note updated in place**
(so a Workflow replay never duplicates a note), **retry once, then announce** (the review step
retries a single time before giving up and saying so on the MR), an optional **Slack alert** on a
degraded outcome, and a config-driven **path ignore** so vendored/fixture diffs never reach a
model.

Two further controls are the webhook route's OWN admission story, not the review's: a **fail-closed
503** when `IDEMPOTENCY_KV` is absent — the throttle, the explicit-review cap, the delivery-UUID
dedup and the per-head marker all live there, so a deploy missing it refuses every delivery
rather than running unthrottled and undeduped. Four such `503` answers in a row make GitLab
disable the webhook — BY DESIGN: a misconfigured deploy failing loud (a disabled hook, visible to
`health.sh`-style monitoring) beats one that silently reviews without a throttle. And a
**`202`-for-payload-shape policy**: once the token has verified, a payload-shape problem (bad
JSON, a non-object body, a forged/non-integer id, a missing head sha, a disallowed project) acks
`202 {"ignored":true,...}` rather than `4xx` — GitLab counts `4xx` the same as `5xx` toward that
same auto-disable, and a shape problem is GitLab's fault or a config mismatch, never something a
redelivery fixes.

The review side carries one more control worth naming: every model call the engine makes over a
diff — the domain-reviewer fan-out and the adversarial verifier — frames the diff as **untrusted
data** behind a randomized `<untrusted-diff-…>` tag boundary the model is told never to treat as
instructions, so a diff crafted to talk to the reviewer (or to a verifier) cannot manipulate its
own verdict.

## Rationale

**A port, not a second copy of `github-app`.** Without a shared interface, a second forge means
a second run, a second set of driving adapters, and no shared vocabulary for "diff" or "review
verdict" — every future forge multiplies the same fork. A port pays that cost once.

**`Scm`'s shape mirrors `modelGateway` on purpose.** A second capability with a different
shape (return conventions, error handling, how a Layer degrades when unconfigured) would be a
second pattern to learn. Reusing the established one keeps the codebase's capability seam
uniform.

**GitLab's own webhook contract forces the operational controls, not taste.** GitLab retries a
non-2xx delivery and auto-disables a webhook after repeated failures — a webhook route that
free-runs without a throttle, a pause key, and a draft gate is not survivable against a busy
project; these controls are the adapter's admission story, not polish.

**Note-only output is the smallest correct surface for a first GitLab integration.** Approvals
and commit statuses are per-provider concepts with no natural home on the neutral port yet;
shipping only what the port already expresses (`postReview`/`updateReview`) avoids designing
that generalization under one adapter's assumptions.

## Consequences

- A second forge is now a Layer choice, not a fork: the run and the engine's fan-out are
  provider-blind by construction.
- Three follow-ups are explicitly still open after this branch, not resolved by it:
  - The **persona and naive fan-out** still receive the whole (capped) diff on every call; only
    the verify stage is scoped to the finding's own file section — fine at today's diff sizes, a
    real cost at larger ones.
  - The **throttle counter** (and the explicit-review cap) is a read-modify-write over KV,
    which is only eventually consistent — a burst of concurrent deliveries can race past the
    nominal cap under contention.
  - **Note creation is not idempotent.** The placeholder step never retries (a lost response
    would otherwise post a duplicate) and the result step repeats the idempotent update through
    transient failures, creating a note only when the placeholder is gone — but a Workflow
    replayed mid-step, or a lost response on a create, can still post twice. An idempotency
    key on the note is the fix.
- Every operational control listed above is now part of the adapter's contract, not incidental
  behavior — changing one (e.g. the throttle window, the explicit-review cap) is a decision
  about the adapter's admission posture, not a tuning knob to flip silently.
- Provenance tags (`_seat: …_`, `_verification: …_`) are carried as optional fields on the finding, so a refactor that clones findings keeps them.

## Revisit triggers

- A **GitHub Layer for the `Scm` port** lands (`makeGithubScmLive` wrapping the existing
  `github-app` plumbing), at which point `pr-review` and `mr-review` become one run over two
  providers — the outline this ADR sets up but does not itself build.
- **A third forge** is proposed, testing whether the port's three methods still cover a
  provider that, say, models review state differently from both GitHub and GitLab.
- The **throttle/explicit-cap counter moves to a Durable Object** (or another strongly
  consistent store) — closing the eventual-consistency gap named above under real concurrent
  load.
