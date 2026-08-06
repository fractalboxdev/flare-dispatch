# Slack-origin dispatches

A conversational Slack agent can sit in front of this dispatcher. Its ingress classifies inbound
Slack events by event class — never by message content — handles the conversational ones itself
(mentions, DMs, thread replies), and re-dispatches the batch-shaped ones here over the ordinary
HMAC dispatch route, carrying the Slack origin context. No event class reaches both sides.

This document is the **dispatcher's** half of that split: the envelope a slack-origin dispatch is
held to, enforced here, on this deploy, against this deploy's config. The ingress is expected to
send only what the envelope allows; the dispatcher does not depend on it having done so.

Implementation: [`../src/slack-origin.ts`](../src/slack-origin.ts) (policy),
[`../src/slack-notify.ts`](../src/slack-notify.ts) (verdict callback),
[`../src/routes/dispatch.ts`](../src/routes/dispatch.ts) § 4.5 / § 5.5 (enforcement points).

## The dispatch body

The ordinary body plus one optional block. Absent, nothing below applies and the GHA-Action path
is unchanged in every respect.

```jsonc
{
  "run": "spec-drift-pr",
  "github": { "repo": "<owner>/<name>", "ref": "refs/heads/main", "sha": "<sha>" },
  "inputs": { "firedAt": 1712345678000 },
  "source": {
    "kind": "slack",
    "team_id": "T0…",
    "channel": "C0…",
    "thread_ts": "1712345678.123456", // optional — where the verdict lands
    "user_id": "U0…",                 // optional — audit only, never authorization
    "event_class": "slash_command"     // optional — recorded, never trusted
  }
}
```

`Idempotency-Key` is **required** on a slack-origin dispatch (the Slack event id is the natural
value). Without it the route's fallback id is `{run}:{repo}:{sha12}`, and the batch runs on the
allowlist carry no per-request input — two "run the sweep" messages against one commit would fold
onto a single execution and the second would answer 202 while nothing ran.

## What the dispatcher enforces

Checked in this order; the first refusal wins. Every refusal is **403** with
`{ "error": "<code>", "message": "<prose>", "run": "<name>" }`, and `message` is written to be
posted verbatim into the thread — one branch for the caller, one sentence for the human.

| Code | When |
| --- | --- |
| `slack_origin_context_required` | Signed with the Slack-scoped key but no `source` block (see below) |
| `slack_origin_unconfigured` | No target repo pinned on this deploy — the batch path is off |
| `credential_selection_not_permitted` | `inputs` names `secrets`, `secretPrefix`, `roleArn`, `bedrockRoleArn`, or `env` |
| `approval_required` | The run pauses for a human decision (`humanGate`) |
| `run_not_allowed_from_slack` | The run is not on this deploy's Slack allowlist |
| `payload_command_run` | The run takes a command from its dispatch payload |
| `repo_not_pinned` | `github.repo` is not the pinned target |
| `idempotency_key_required` | No `Idempotency-Key` header |

### `secrets: []`, enforced on what executes

Naming a credential is refused against the **raw** payload, before schema decoding — decoding drops
fields a run's schema does not declare, so a `secrets` array smuggled onto a run that ignores it
would otherwise vanish and the request would answer 202 to something forbidden. Refusing loudly is
what an operator reading the response needs.

Past the refusal, the inputs handed to the Workflow are normalized: `secrets: []` is forced for
every run whose schema declares the field. The guarantee is a property of what runs, not of what was
asked for.

### The run allowlist

`SLACK_ORIGIN_RUNS` in the policy module is the code-defined maximal set. CONFIG_KV
`slack-origin.runs` (comma-separated) **narrows** it — the effective set is the intersection, so no
KV write widens what a chat message reaches.

Payload-command runs are excluded structurally rather than from memory: `payloadCommandInputs` reads
each run's own `inputs` schema for `command` / `args` / `…Command` / `…Script` fields, so a run that
grows one tomorrow drops out of the Slack path the moment it does. A registry-wide test asserts the
allowlist is clean, so the drift surfaces at build time, not at dispatch time.

Also excluded, and why: runs where the caller picks the URL the container dials (`deploy-smoke`,
`playwright-e2e`, `email-otp-login`, `demo-reel`, `product-demo`) — egress selection from a chat
message is the same problem wearing a URL; and `self-heal-pr`, which is the escalation target of a
diagnosis rather than something to ask for directly.

### Fail closed on an approval-needing run

A run that declares `humanGate` hibernates in `step.waitForEvent` until a person approves or
rejects. The batch path is fire-and-forget and has nowhere to ask, so such a run is refused **before
instantiation**, with a message naming the run's own `humanGate.reason` and pointing back at the
conversational path. The alternative is the failure the rule exists to prevent: a Workflow parked
for 72 hours while the thread shows nothing at all.

`humanGate` is declarative because a dispatcher cannot see a `waitForEvent` inside a run body. It
marks a **person** deciding — not a run merely waiting on an external event (`email-otp-login`
hibernates for a verification email, which arrives on its own).

### The scoped signing key

`SLACK_ORIGIN_HMAC_SECRET`, when set, is a second dispatch key whose signature **forces** this
policy whatever the body declares — the Slack ingress can then hold a credential incapable of
dispatching outside the envelope, and enforcement stops depending on a caller declaring its own
origin honestly. A body signed with it and carrying no `source` block is refused.

Unset (the default), the declared `source` selects the policy and the HMAC is the authentication.
The scoped key is ignored when it equals `HMAC_SECRET`: one value under two names is not a scope,
and silently treating every CI dispatch as slack-origin would break CI far from the mistake.

## The verdict callback

The check-run is the GitHub-side signal. For a slack-origin run the same finalize boundary also
POSTs the verdict to the ingress's callback endpoint, which posts it in-thread with the bot token.
**This dispatcher holds no Slack credential** — giving a CI dispatcher workspace-write access to
save one hop is how a token ends up somewhere nobody meant it to be.

```
POST <callback URL>
X-FlareDispatch-Signature: sha256=<hex over the raw JSON body bytes>
```

Same header, same raw-bytes canonicalization, same primitive as the inbound dispatch route — the
receiver's verification is the code it already wrote to sign dispatches, read backwards. The key is
domain-separated so a callback signature can never be replayed as a dispatch signature:

```
k = HKDF-SHA256(ikm, salt = "", info = "flare-dispatch/slack-notify/v1")
ikm = SLACK_NOTIFY_SECRET, or HMAC_SECRET when that is unset
```

Body: `version`, `executionId`, `run`, `status` (`success` | `failure` | `skipped`), `repo`, `sha`,
the echoed `origin`, a ready-to-post `text` line, and optional `checkRunName`, `logsUrl`,
`detailsUrl`, `failureSummary`. The receiver owns Slack formatting and may ignore `text`; it exists
so a receiver that just wants to post something correct does not re-derive the wording.

Delivery is best-effort and bounded (10s): a missing URL, a non-2xx, or a timeout is a logged line,
never a flip of a verdict the run already earned. The verdict is already in D1 and on the check-run.

Two 202 responses land no verdict later, by design, because they are already the answer: a dispatch
inside a run's cooldown window (`skipped: "cooldown"` + `retryAfterSec`) and a duplicate
`Idempotency-Key`. Both come back synchronously with the prior execution id for the ingress to
relay.

## Operator configuration

The batch path is **off** until a target repo is pinned. Nothing here is set by default.

| Setting | Where | Purpose |
| --- | --- | --- |
| `slack-origin.repo` | CONFIG_KV | The one repo slack-origin dispatches may target |
| `SLACK_ORIGIN_REPO` | wrangler var | Same, lower precedence — CONFIG_KV wins |
| `slack-origin.runs` | CONFIG_KV | Narrow the run allowlist (comma-separated); cannot widen |
| `slack-origin.notify-url` | CONFIG_KV | Where the verdict callback POSTs |
| `SLACK_NOTIFY_URL` | wrangler var | Same, lower precedence |
| `SLACK_ORIGIN_HMAC_SECRET` | Worker secret | Optional Slack-scoped dispatch key |
| `SLACK_NOTIFY_SECRET` | Worker secret | Optional dedicated callback key material |

```bash
wrangler kv key put --binding=CONFIG_KV "slack-origin.repo" "owner/repo"
wrangler kv key put --binding=CONFIG_KV "slack-origin.notify-url" "https://ingress.example/verdict"
```

## Dogfood: a Slack mention's verdict lands in-thread

Needs a live Slack workspace and a deployed ingress, so it is an operator step. Run it end to end
once after the first deploy that carries this path.

1. **Pin the target.** Set `slack-origin.repo` and `slack-origin.notify-url` in CONFIG_KV
   (commands above). Confirm with `wrangler kv key get --binding=CONFIG_KV "slack-origin.repo"`.
2. **Sync the callback key.** The ingress must derive the same `k` — give it `HMAC_SECRET`'s value,
   or set `SLACK_NOTIFY_SECRET` on both sides. A 401 from the ingress means drift.
3. **Refusals first, before anything real runs.** Against the deployed dispatcher, signed with
   `HMAC_SECRET`, expect a 403 and the code named:
   - a `source`-carrying dispatch of `offload-test` → `run_not_allowed_from_slack`;
   - one naming a repo other than the pin → `repo_not_pinned`;
   - one carrying `inputs.secrets` → `credential_selection_not_permitted`;
   - `release-notes` → `approval_required`, with the conversational-path pointer in `message`.
4. **The round trip.** From the Slack workspace, use the batch-shaped command the ingress maps to an
   allowlisted run (`spec-drift-pr` is the cheapest — it takes only `firedAt`). Expect: the ingress
   acks in-thread, `GET /v1/executions/<id>` shows the execution, the `flare-dispatch/<run>`
   check-run completes on the pinned repo, and the verdict arrives as a new message in the **same
   thread** carrying the run name, the status, and the full-logs link.
5. **The failure branch.** Re-run against a commit where the run fails. The in-thread message must
   read `✗` and carry the failure summary — a verdict path that only works when green is not a
   verdict path.
6. **Ingress down.** Point `slack-origin.notify-url` at an unroutable host and dispatch again. The
   run must still complete, the check-run must still post, and the Worker log must carry
   `slack-notify: verdict not delivered`. A callback failure never changes a verdict.
