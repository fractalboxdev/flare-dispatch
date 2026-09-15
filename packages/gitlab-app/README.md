# @fractalboxdev/flare-dispatch-gitlab-app

Token-authenticated GitLab REST access for the `mr-review` recipe — the GitLab
analog of `@fractalboxdev/flare-dispatch-github-app`, deliberately **much smaller**.

Provider-neutral fetch code: plain typed `async` functions, no Effect
dependency. The Effect Layer (`makeGitlabScmLive` in
`@fractalboxdev/flare-dispatch-runtime-cf`) wraps these onto the neutral `Scm` capability.

## Surface

- `fetchMergeRequestDiff({ projectId, iid, token })` — GET the MR's per-file
  diffs (`GET /projects/:id/merge_requests/:iid/diffs`, paginated `per_page=100`
  following the `x-next-page` header) and assemble them into ONE standard
  `git`-style unified diff, so the review engine reads a GitLab MR exactly as it
  reads a GitHub PR.
- `postMergeRequestNote({ projectId, iid, body, token })` — POST a top-level
  note (`POST /projects/:id/merge_requests/:iid/notes`), the visible review
  comment. Returns the created note's id (as a string, `null` if the response
  carried none) — pass it to `updateMergeRequestNote` to edit the SAME note
  later instead of posting a second one.
- `updateMergeRequestNote({ projectId, iid, noteId, body, token })` — PUT a new
  body onto an existing note (`PUT /projects/:id/merge_requests/:iid/notes/:note_id`).
  A deleted note surfaces as a 404 `GitlabApiError`.
- `assembleUnifiedDiff(files)` — the pure diff-assembly helper (exported for
  reuse/tests).

## Auth — token-based, no install flow

Unlike `github-app` (App JWT → installation-token exchange → check-runs), this
package authenticates with a single **project access token** sent in the
`PRIVATE-TOKEN` header. There is **no** App registration, no per-installation
token minting, and no check-run surface — a GitLab MR review posts a note and
reports its verdict inline.

Create a project (or group) access token scoped to `api` and set it as the
Worker secret `GITLAB_TOKEN` (see "Deploying the GitLab mode" below).

## Testing

MSW mocks `https://gitlab.com/api/v4` under plain Node + Vitest (mirrors
`github-app`). `onUnhandledRequest: "error"` keeps the tests honest about which
URLs are hit.

## Deploying the GitLab mode

The design behind this adapter — the `Scm` port, the pieces backing it, and
what stays out of scope — is [ADR-0004](../../specs/adr/0004-gitlab-scm-adapter.md).
This section is the operator-facing runbook: what to provision, what to set,
and how the operational controls behave once it's live.

### Free-plan trim (`wrangler.gitlab.example.jsonc`)

Copied from the root `wrangler.jsonc`, then stripped to: `d1_databases`
(RUNS_METADATA), `kv_namespaces` (CONFIG_KV + the now-**required**
IDEMPOTENCY_KV), `ai` (AI), `workflows` (GITLAB_REVIEW_WORKFLOW →
GitlabReviewWorkflow), `observability`. **Removed**: containers, durable_objects,
migrations (no DO class is exported), browser, crons/triggers, routes/custom
domains, assets, send_email, and the ACCESS_* / PUBLIC_ORIGIN / INBOX_DOMAIN /
ADMISSION_CAP vars. `VIEWER_ACCESS_MODE=token-only` (no Access app fronts a
GitLab-mode deploy). `CLOUDFLARE_ACCOUNT_ID` / `WORKFLOW_NAME` / `GITLAB_BASE_URL`
/ `GITLAB_ALLOWED_PROJECT_IDS` (vars) and `SLACK_WEBHOOK_URL` (secret) are left
commented — all optional, see below. The committed file carries placeholder ids
(`<your-d1-id>`, …) — it is an example to copy, not a deployable config.

### Provisioning runbook

```bash
CFG=apps/dispatcher/wrangler.gitlab.example.jsonc   # copy first, then edit ids

# 1. D1 + apply the shared migrations.
wrangler d1 create flare-dispatch-gitlab              # paste database_id into $CFG
wrangler d1 migrations apply RUNS_METADATA --remote --config $CFG

# 2. KV — CONFIG_KV for the config capability, IDEMPOTENCY_KV for the
#    throttle/dedup contract. BOTH are required: the webhook route refuses
#    every delivery (503 throttle_not_configured) without IDEMPOTENCY_KV.
wrangler kv namespace create CONFIG_KV                # paste id into $CFG
wrangler kv namespace create IDEMPOTENCY_KV           # paste id into $CFG

# 3. Secrets.
wrangler secret put GITLAB_TOKEN --config $CFG          # project access token, scope: api
wrangler secret put GITLAB_WEBHOOK_SECRET --config $CFG # a long random string
# Optional: wrangler secret put SLACK_WEBHOOK_URL --config $CFG (failure alerts)

# 4. Point the review at a model (shared pr-review.* namespace).
wrangler kv key put --binding CONFIG_KV pr-review.backend workers-ai --config $CFG
wrangler kv key put --binding CONFIG_KV pr-review.workers-ai.model "@cf/meta/llama-3.3-70b-instruct-fp8-fast" --config $CFG
# Optional: pr-review.agents=multi (tier-scaled personas; default single),
#           pr-review.workers-ai.mode=json (for reasoning models),
#           pr-review.guidelines="..." (house rules),
#           pr-review.reviewDrafts=true (review draft MRs too; default off),
#           pr-review.ignorePaths="fixtures/**,vendor/**" (comma-separated
#           globs excluded from the reviewed diff).

# 5. Deploy.
wrangler deploy --config $CFG
```

### GitLab side

1. **Project access token** — Project → Settings → Access Tokens → role
   `Developer` (or higher), scope **`api`**. This is `GITLAB_TOKEN`.
2. **Webhook** — Project → Settings → Webhooks → URL
   `https://<worker>.workers.dev/v1/webhooks/gitlab`, **Secret token** = the same
   value as `GITLAB_WEBHOOK_SECRET`, trigger **Merge request events**. Add SSL
   verification. GitLab sends `X-Gitlab-Token` = the secret; the route
   constant-time-compares it.

### Env vars and secrets reference

| Name | Kind | Required | What |
| --- | --- | --- | --- |
| `GITLAB_WEBHOOK_SECRET` | secret | yes | Verifies `X-Gitlab-Token`. Absent/blank → the route `503`s every delivery (GitLab mode is opt-in). |
| `IDEMPOTENCY_KV` | KV binding | yes | Backs the per-MR throttle, the explicit-review cap, the delivery-UUID dedup, and the per-head marker. Absent → the route `503`s (`throttle_not_configured`) and dispatches nothing. |
| `GITLAB_REVIEW_WORKFLOW` | Workflow binding | yes | Instantiates `GitlabReviewWorkflow`. Absent → the route `503`s (`workflow_not_configured`). |
| `GITLAB_TOKEN` | secret | no | Project/group access token, scope `api`. Absent, or blank/whitespace-only, degrades the `scm` Layer: `fetchDiff` fails `auth-failed`, note posting is a logged no-op. |
| `GITLAB_BASE_URL` | var | no | API base override for a self-hosted GitLab instance. Absent → `https://gitlab.com/api/v4`. Blank/whitespace-only is treated as absent. |
| `GITLAB_ALLOWED_PROJECT_IDS` | var | no | Comma-separated GitLab project ids. When set, a delivery for any other project is acknowledged and ignored (`202 {"ignored":true,"reason":"project not allowed"}`), never dispatched. |
| `SLACK_WEBHOOK_URL` | secret | no | A Slack incoming-webhook URL. When set, a `failure`/`skipped-quota` outcome posts an alert there. |
| `CLOUDFLARE_ACCOUNT_ID`, `WORKFLOW_NAME` | vars | no | Together, build the Slack alert's Cloudflare-dashboard Workflow-instance link. Either alone omits the link. |
| `CONFIG_KV` | KV binding | no | The shared `pr-review.*` config namespace (backend/model choice, guidelines, draft/path-ignore config). Absent → the config-reading run fails loudly. |

### Status codes

GitLab retries a non-2xx delivery and, after **four consecutive** failed
deliveries, disables the webhook (backoff growing to 24h); **forty** disables it
**permanently** — and it counts `4xx` exactly the same as `5xx` toward that
(GitLab documentation, read 2026-09-14).
This route's contract, once the token has verified: a payload-shape problem
(bad JSON, a non-object body, a forged/non-integer id, a missing head sha, a
disallowed project) acks `202 {"ignored":true,"reason":"<short>"}`, never `4xx`.
`401` is reserved for a bad/missing token; `503` for an unconfigured secret or
binding (an operator fault the health check surfaces, not something a
redelivery fixes).

### Operational controls

- **Draft gate.** A draft MR (`object_attributes.draft`, or `work_in_progress`
  on older GitLab instances) is not reviewed by default — the webhook route
  answers `204` and starts no Workflow, checked right after the label handling
  and before the pause/head/dedup/throttle logic. The `request-ai-review` label
  bypasses the gate for that one MR (like it bypasses the throttle). A
  deploy-wide CONFIG_KV key `pr-review.reviewDrafts` set to the exact string
  `true` turns draft review back on for every MR. A `CONFIG_KV` read failure
  fails CLOSED here (the MR stays gated) — the opposite default from the
  operator pause below, because "don't review a draft" is this gate's safe
  default. When a draft moves to ready, GitLab fires an `update` event with
  `draft: false`, so the MR's first review happens naturally on that event —
  no separate transition handling is needed.
- **Naive seats.** After the domain-reviewer fan-out, three blind one-angle
  seats (`money-units`, `time`, `edges` — one narrow lens each, on a cheap model)
  each re-read the SAME diff independently and tag every finding they raise
  `_seat: naive/<id>_`. Config: `pr-review.naive.enabled` (default `true`),
  `pr-review.naive.model` (default `@cf/qwen/qwen3-30b-a3b-fp8`),
  `pr-review.naive.maxDiffChars` (default `60000`). A seat failure is logged and
  skipped — it never fails the run.
- **Adversarial verification + near-duplicate merge.** Before verification,
  findings on the same path and level with overlapping lines merge into one, so
  personas that phrase one defect three ways post it once. Each surviving
  finding then gets two independent verifier calls (`cited-line`,
  `handled-elsewhere`), both **defaulting to refuting** — a finding survives only
  if the verifier can point to where the diff actually shows the claimed defect.
  A finding both verifiers refute is dropped; the rest are marked `CONFIRMED` or
  `PLAUSIBLE`. Config: `pr-review.verify.enabled` (default `true`),
  `pr-review.verify.model` (default: the review's own model),
  `pr-review.verify.maxFindings` (default `12`, caps the fan-out). Verification
  runs as one flat fan-out over (finding, lens) pairs at concurrency 6; a
  verifier error counts as `PLAUSIBLE` rather than failing the run. (Open
  follow-up: a verifier call sends the WHOLE diff, not a scoped slice — fine at
  today's sizes, a real cost at larger ones — see ADR-0004's Consequences.)
- **Per-MR throttle.** At most 3 review dispatches per `(project, iid)` per
  rolling 15-minute window, counted in `IDEMPOTENCY_KV` under
  `throttle:<project>:<iid>`. The dispatch that would exceed the window posts
  ONE throttle note (`<!-- flare-dispatch: mr-review-throttle -->`) naming the
  retry time and starts no Workflow; it does not post a second note until the
  window rolls over. A duplicate head SHA does not consume a slot.
  `IDEMPOTENCY_KV` is a required binding (see "Status codes" above) — without
  it the route refuses every delivery rather than degrading to un-throttled.
- **Explicit-review cap.** `request-ai-review` bypasses the per-MR throttle's
  CHECK (and the draft gate), but is itself bounded: at most 6 explicit
  reviews per `(project, iid)` per rolling 60-minute window, counted separately
  in `IDEMPOTENCY_KV` under `throttle-bypass:<project>:<iid>` — independent of
  the main throttle counter. Over the cap: `202 {"status":"throttled","scope":"explicit"}`,
  no note, no Workflow. (Open follow-up: this counter, like the main throttle's,
  is a read-modify-write over eventually-consistent KV — a burst of concurrent
  deliveries can race past the nominal cap — see ADR-0004's Consequences.)
- **MR labels.** `skip-ai-review` skips the run entirely (`204`, no Workflow).
  `request-ai-review` bypasses the throttle's CHECK and the draft gate (the
  review always dispatches, subject to its own explicit-review cap above), and
  still records a slot in the main throttle counter, so a burst of manual
  re-requests still eventually throttles there too. Neither label bypasses the
  operator pause below.
- **Operator pause.** A `pr-review.paused` CONFIG_KV key (any string value = the
  pause reason) makes the webhook route answer `200 {status: "paused", reason}`
  and do nothing else — no Workflow, no throttle write, no dedup write — for
  every delivery that REACHES this check: after the token, shape, allowlist,
  label and draft-gate checks above (a draft MR, say, still gets its own `204`
  from the draft gate and never reaches the pause key at all). `request-ai-review`
  does NOT bypass it. Delete the key to resume. A `CONFIG_KV` read failure is
  treated as "not paused" (fails open) rather than silently pausing the adapter.
- **Path ignore.** `pr-review.ignorePaths` (CONFIG_KV, comma-separated globs,
  `**` spans directories) strips matching files from the diff before noise
  stripping and the size cap — vendored code or fixtures never reach a model.
  Unset → nothing is stripped.
- **Project allowlist.** `GITLAB_ALLOWED_PROJECT_IDS` (see the vars table
  above) — unset means every project the webhook fires for is allowed.
- **Placeholder note, updated in place — never stranded.** Right after
  `insert-execution`, a durable `post-placeholder` step posts a short
  provisional note (`🔎 flare-dispatch review started · head <sha12> ·
  <HH:MM UTC> · results replace this note`) carrying the same
  `<!-- flare-dispatch: mr-review -->` marker. `post-review` then UPDATES that
  same note with the finished review, the failure note, or — on
  `skipped-quota` — a short degraded status (`⏸ review skipped: model quota
  exhausted; ...`), so no run ends on stale placeholder text. It falls back to
  creating a fresh note when there was no placeholder id (posting it failed,
  or `GITLAB_TOKEN` is absent) or the update itself failed for ANY reason —
  the placeholder was deleted (`ScmError.reason === "not-found"`), a transient
  GitLab error, an auth failure, a rate limit — so an MR never ends up stuck
  on the placeholder. The trade-off: when the update fails for a reason OTHER
  than `not-found`, the placeholder note itself is still there (only its
  UPDATE failed, not the note), so the fallback create can leave the MR with
  both the stale placeholder AND a separate fresh result note, rather than one
  updated note — accepted because a visible duplicate beats an MR silently
  stuck on "review started" forever. This also makes a Workflow replay idempotent on the note: a replayed
  `post-review` updates the same note instead of posting a duplicate. If the
  review succeeded but the note could not be posted or updated, `finalize`
  records the row's status as `failure` (summary `{"error":"note not
  posted"}`) rather than `success` — the D1 row never claims success for a
  note nobody saw.
- **Retry, then announce.** The `review` step retries once on a timeout (2
  attempts total, 30s apart, 25-minute timeout each). When retries are
  exhausted the failure note says so plainly: `could not complete after 2
  attempts (review step timed out after 25 minutes each)`, or the actual reason
  for a non-timeout failure. When the outcome is `failure` or `skipped-quota`
  AND the optional secret `SLACK_WEBHOOK_URL` is set, a durable `notify-failure`
  step (after `post-review`) posts a plain-text Slack message naming the MR
  (title, or `project/iid`), a link to the MR note (or the MR itself if no note
  id), the head sha12, the status, the reason (first 200 chars), the attempt
  count, and — when the var `CLOUDFLARE_ACCOUNT_ID` is also set — a link to the
  Cloudflare dashboard Workflow-instance page (workflow name from the optional
  var `WORKFLOW_NAME`, default `gitlab-review`). A Slack failure (bad URL,
  non-2xx, network) is logged, never thrown — it cannot fail the Workflow.
- **Timing and infra-cost footer.** The finished note (success or failure)
  carries one more line above the marker: `⏱ <m>m <s>s wall time · <N|unknown>
  model calls · Workers/Workflows est. $<x>`. Wall time is the durably captured
  `reviewedAt` (its own tiny `mark-reviewed-at` step, right after `review`)
  minus the execution's `started_at` (captured once, durably, inside
  `insert-execution`'s step result) — both durable so a Workflow replay can
  never inflate the figure. Model calls are counted by a metering
  `ModelGateway` wrapper (every SUCCESSFUL domain-reviewer, naive-seat and
  verify call increments it); a `failure` outcome renders `unknown` rather than
  `0`, since a retry-exhausted review step's usage never made it out — `0`
  there would assert a true zero the review never actually confirmed. The
  dollar estimate is a pure
  `estimateInfraUsd({ modelCalls, steps, elapsedMs })` — Workers Paid list
  prices, read 2026-09-14: requests at $0.30 per million (model calls +
  Workflow steps run), CPU time at $0.02 per million CPU-ms budgeted at 20
  CPU-ms per model call and 5 per step. `elapsedMs` does not enter that formula
  (CPU-ms billing is active-compute time, not wall-clock time) — it only drives
  the line's wall-time text. Marked "est." in the note; both `elapsedMs` and
  the call count persist into `summary_json` alongside the per-model usage.
