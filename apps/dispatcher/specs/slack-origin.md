# Slack-origin dispatches

A conversational Slack agent can sit in front of this dispatcher. Its ingress classifies inbound
Slack events by event class — never by message content — handles the conversational ones itself
(mentions, DMs, thread replies), and re-dispatches the batch-shaped ones here over the ordinary
HMAC dispatch route, carrying the Slack origin context. No event class reaches both sides.

This document is the **dispatcher's** half of that split: the envelope a slack-origin dispatch is
held to, enforced here, on this deploy, against this deploy's config. The ingress is expected to
send only what the envelope allows; the dispatcher does not depend on it having done so.

Implementation: [`../src/slack-origin.ts`](../src/slack-origin.ts) (policy),
[`../src/slack-notify.ts`](../src/slack-notify.ts) (the verdict callback and the notice),
[`../src/routes/dispatch.ts`](../src/routes/dispatch.ts) § 4.5 / § 5.5 (enforcement points).

Everything up to § The verdict callback is about runs that **came from** Slack. § The notice covers
the other direction — a scheduled run with something to say and no thread to say it in.

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
k_verdict = HKDF-SHA256(ikm, salt = "", info = "flare-dispatch/slack-notify/v1")
ikm       = SLACK_NOTIFY_SECRET, or HMAC_SECRET when that is unset
```

The notice derives from the same `ikm` under a **different** label — see § The notice.

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

## The notice

The verdict callback reaches a thread because the dispatch carried one. A **cron tick carries no
origin**, so a scheduled run — `org-spec-audit` produces a digest of open questions that belongs in
a channel — could not reach that path at all. This is the un-originated half.

A run publishes through the `notice` capability
([`packages/core/src/services/notice.ts`](../../../packages/core/src/services/notice.ts)):

```ts
notice.publish({ useCase, text, dedupeKey, links });
```

**The shape is the security property.** There is no channel, thread, recipient or URL, and no way to
express one. `useCase` is a routing *key* the receiver resolves against a map in its own deploy
config; an unmapped one is refused there. The emit side is the untrusted half — `text` may be
model-authored — so it says what it wants published and never who hears it. A signed body that could
name `C…` would turn one leaked key into workspace-wide write.

`text` is **data**. The receiver escapes `&`, `<`, `>` before posting, which neutralizes
`<!channel>`, `<@U…>` and the rest in one rule. Nothing here builds Slack markup: links that must
survive ride in the typed `links[]` field and are rendered by the receiver from a validated https
URL.

A link **label** is the one field that escaping does not cover, because it lands *inside* the
`<url|label>` span rather than in the text the receiver escapes. `>` closes that span early and `<`
opens a new one, so a model-authored label is a way back into markup — and into `<!channel>` — for
anything that only escaped `text`. The emit side therefore refuses `<`, `>`, `|` and control
characters in a label outright (`validateSlackNotice`), which is stricter than the receiver's own
length-only bound on purpose: it is the half this repo controls. The receiver should escape the
label as well; neither guard is sufficient alone.

Wire format, signature and refusal codes are the receiver's contract
(fractalbot `specs/flare-dispatch-notify.md`, `POST /flare-dispatch/notify`). The envelope matches
the verdict callback — same header, same raw-bytes canonicalization, same `SLACK_NOTIFY_SECRET` (or
`HMAC_SECRET`) keying material. `apps/dispatcher/src/slack-notify.notice.test.ts` carries the
receiver's own verification verbatim so the two repos cannot drift silently.

### The notice signs under its own key

The **label differs**, and that is a boundary rather than bookkeeping:

```
k_notice = HKDF-SHA256(ikm, salt = "", info = "flare-dispatch/slack-notice/v1")
```

One label would make the two surfaces one key, and the two payloads are not equally dangerous.
`SlackVerdictPayload.origin` carries `channel` and `thread_ts` — it *names a destination*, because
it relays a conversation the caller was already in. The notice body deliberately cannot. Under a
shared key, anything able to sign a notice could sign a verdict naming any channel the bot can see,
and "the shape is the security property" would be worth nothing: a shape bounds only while nothing
else can sign a different shape with the same key. The weaker credential is now structurally unable
to reach the stronger surface.

The `ikm` is still one secret. Two labels off one secret is domain separation; two secrets would be
a second thing to rotate for a separation HKDF already gives.

> **Deploy the receiver first.** The receiver must derive notices under the exact string
> `flare-dispatch/slack-notice/v1`. A receiver still on `flare-dispatch/slack-notify/v1` rejects
> every notice with a 401 — silently and indefinitely, because a failed notice is correctly never
> fatal, so nothing turns red and nothing pages. Verdicts are unaffected either way: their label is
> unchanged, so an already-deployed receiver keeps verifying them. Ordering: receiver accepts the
> new label → deploy this dispatcher → the dogfood below.

### At most once, across a retry

The receiver dedups on a `deliveryId`, so the guarantee it can offer is one post per id. That is
worth nothing if the id moves between attempts — and a Workflow step **can** be retried. So the id
is derived, never drawn:

```
deliveryId = "<run>:<dedupeKey>"
```

No clock, no randomness. A scheduled run passes its day string (the same value its schedule
idempotency key uses), so a retry re-sends identical bytes. `Date.now()` and `Math.random()` are
also simply unavailable on a replayed step, which makes derivation the only construction correct on
every path.

#### 409 means *delivered*, not *claimed* — a receiver obligation

A single-phase claim would be unsafe here. If the receiver marked the id taken and then died before
Slack accepted the post, the retry would meet that mark, earn a 409, and this side would record the
notice as handled while nothing was ever published — a silence with a success next to it, which is
the worst failure this capability has.

So the id carries **two** states in the receiver's store, and only the second is a duplicate:

| State       | Meaning                                             | Answer to a second POST of the same id                                       |
| ----------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `claimed`   | The post was attempted; outcome unknown or failed   | **Not** 409 — re-attempt the post, taking over the claim, or answer a 5xx     |
| `delivered` | Slack accepted the post                             | `409`                                                                          |

**`409` is reserved for `delivered`.** A receiver that answers 409 for a `claimed`-but-unposted id
breaks the reading on this side, and does it silently. Implementing the split is the receiver's half
(fractalbot `specs/flare-dispatch-notify.md`); it is written here because it is the assumption the
dispatcher's 409 handling rests on, and because the mirror test is the only place the two repos meet.

The residual window is much smaller but not zero: a post Slack accepted whose `delivered` write did
not land is re-attempted and can double-post. That is the trade this design takes on purpose — for
an announcement, a visible duplicate is cheaper than an invisible silence.

This side never upgrades a 409 into a delivery it witnessed. `duplicate` maps to
`{ delivered: false, duplicate: true }`, so the one flag that claims a post reached Slack is set
only by a 2xx this dispatcher actually received.

### Its own URL, deliberately

`slack-notice.url`, not `slack-origin.notify-url`. Three reasons, any one sufficient: it is a
different **endpoint** (a different route taking a different payload); `slack-origin.*` is the
namespace of the **origin-gated policy** and a cron notice must not inherit that policy's trust or
be enabled as a side effect of it; and the two have different **blast radii**, so pointing the
announcement path elsewhere must not silence in-thread verdicts a human is waiting on.

The radii differ in the **key**, not only in the URL. Each surface derives under its own HKDF label
(§ The notice signs under its own key), so what a notice endpoint holds is a credential that can
publish a use case and cannot name a channel. Pointing `slack-notice.url` at a staging receiver
hands that receiver exactly that and no more — it cannot forge a verdict into a room. Before the
split the separation stopped at the URL: one derived key signed both, so an operator moving the
announcement path was moving an endpoint while the authority behind it stayed whole.

Delivery is best-effort, like the verdict callback and the completion-notify email: no ingress
configured, no signing key, a 5xx, a timeout — all are a logged line and `delivered: false`. A run's
verdict is earned by what it did, and an announcement that did not land is not one of those things.
`org-spec-audit` keeps its questions PR either way; the file in git is the record, the notice is the
announcement, and **empty means silent** — no questions, no PR, no notice.

## Operator configuration

The batch path is **off** until a target repo is pinned. Nothing here is set by default.

| Setting | Where | Purpose |
| --- | --- | --- |
| `slack-origin.repo` | CONFIG_KV | The one repo slack-origin dispatches may target |
| `SLACK_ORIGIN_REPO` | wrangler var | Same, lower precedence — CONFIG_KV wins |
| `slack-origin.runs` | CONFIG_KV | Narrow the run allowlist (comma-separated); cannot widen |
| `slack-origin.notify-url` | CONFIG_KV | Where the verdict callback POSTs |
| `SLACK_NOTIFY_URL` | wrangler var | Same, lower precedence |
| `slack-notice.url` | CONFIG_KV | Where a notice POSTs — the receiver's `/flare-dispatch/notify` |
| `SLACK_NOTICE_URL` | wrangler var | Same, lower precedence |
| `SLACK_ORIGIN_HMAC_SECRET` | Worker secret | Optional Slack-scoped dispatch key |
| `SLACK_NOTIFY_SECRET` | Worker secret | Optional dedicated key material for **both** callbacks — one secret, two keys (one HKDF label each) |

```bash
wrangler kv key put --binding=CONFIG_KV "slack-origin.repo" "owner/repo"
wrangler kv key put --binding=CONFIG_KV "slack-origin.notify-url" "https://ingress.example/verdict"
wrangler kv key put --binding=CONFIG_KV "slack-notice.url" "https://ingress.example/flare-dispatch/notify"
```

Unset `slack-notice.url` ⇒ every `notice.publish` is a logged no-op. The receiver additionally needs
the use case mapped in its own `FLARE_NOTIFY_CHANNELS` — an unmapped one is a 403 there, never a
message in a room nobody chose.

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

## Dogfood: a scheduled digest reaches a channel with no thread to reply to

Needs a deployed dispatcher and a deployed receiver, so it is an operator step. Run it once after
the first deploy that carries the notice path.

1. **Point it.** `wrangler kv key put --binding=CONFIG_KV "slack-notice.url" …` (command above), and
   confirm the receiver maps `org-spec-audit` in its own `FLARE_NOTIFY_CHANNELS`.
2. **Sync the key material, and check the label.** The receiver's `FLARE_NOTIFY_SECRET` must equal
   `SLACK_NOTIFY_SECRET` here (or both sides share `HMAC_SECRET`) — and the receiver must derive the
   notice key under `flare-dispatch/slack-notice/v1`, not the verdict label. A 401 means drift, and
   with a matching secret the label is what to check first.
3. **The round trip.** Let the 05:45 UTC tick run against an estate with at least one open question.
   Expect the questions PR on the control repo **and** the same text in the mapped channel, carrying
   the receiver's `via flare-dispatch` footer and the PR link.
4. **The replay.** Re-run the same day. The receiver must answer 409 and post **nothing** a second
   time — the delivery id is `org-spec-audit:<day>` on both attempts.
5. **Silence.** Re-run against an estate with no open questions. No PR, no message.
6. **Ingress down.** Point `slack-notice.url` at an unroutable host and run again. The PR must still
   open, the run must still be `success`, and the Worker log must carry
   `notice.publish: org-spec-audit not delivered`.
