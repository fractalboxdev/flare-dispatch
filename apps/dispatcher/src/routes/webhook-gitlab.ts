// FlareDispatch Dispatcher — `POST /v1/webhooks/gitlab` (GitLab adapter).
//
// The GitLab sibling of routes/webhook.ts, deliberately self-contained: GitLab
// merge_request events fan out to ONE `GitlabReviewWorkflow` per (project, MR,
// head-sha). Unlike the GitHub route it does NOT go through the run registry /
// trigger-evaluation machinery — this route dispatches the single `mr-review`
// Workflow directly.
//
// A newer head cancels the MR's running review of an older head (supersede).
//
// --- Strict opt-in (byte-parity with the GitHub route's posture) -------------
//
// GitLab mode is OFF by default: a deploy without `GITLAB_WEBHOOK_SECRET`
// returns 503 rather than accepting unverified bodies.
//
// --- Verification ------------------------------------------------------------
//
// GitLab authenticates a webhook with a plain shared *secret token* echoed in
// the `X-Gitlab-Token` header (NOT an HMAC over the body, unlike GitHub). We
// compare it to `GITLAB_WEBHOOK_SECRET` in CONSTANT TIME (`constantTimeEqual`)
// so a `===` early-return can't leak the secret's length/prefix via timing.
//
// --- Status codes: never 4xx for a payload-shape problem ---------------------
//
// GitLab counts 4xx the SAME as 5xx toward auto-disabling a webhook: four
// consecutive failed deliveries disable it (with a growing backoff, up to
// 24h), forty disable it PERMANENTLY. A malformed or unexpected payload is
// GitLab's fault or a config mismatch, never something a redelivery fixes —
// so once the token has verified, every payload-shape problem (bad JSON, a
// non-object body, a forged/non-integer id, a missing head sha, a
// disallowed project) acks `202 {"ignored":true,"reason":"<short>"}` and logs
// a `console.warn`, rather than 400. `401` stays reserved for a bad/missing token and `503` for an
// unconfigured secret or binding — both are operator faults surfaced by the
// health check, not delivery-shape problems, and GitLab redelivering them
// changes nothing.

import type { Env } from "../env";
import { toInstanceId } from "../instance-id";
import { mrInputsFromPayload } from "@fractalboxdev/flare-dispatch-runs/mr-review";
import { postMergeRequestNote, updateMergeRequestNote } from "@fractalboxdev/flare-dispatch-gitlab-app";
import { supersededNoteBody } from "../gitlab-review-outcome";
import { gitlabScmConfig } from "../gitlab-scm-config";

/** GitLab's webhook secret-token header. */
const TOKEN_HEADER = "X-Gitlab-Token";
/** GitLab's event-kind header — MR events carry exactly this value. */
const EVENT_HEADER = "X-Gitlab-Event";
/** GitLab's per-delivery id header (for optional dedup). */
const EVENT_UUID_HEADER = "X-Gitlab-Event-UUID";
/** The one event kind this route handles. */
const MERGE_REQUEST_EVENT = "Merge Request Hook";
/** The MR actions that warrant a (re)review. */
const REVIEWABLE_ACTIONS = new Set(["open", "reopen", "update"]);
/** TTL on receiver-dedup KV entries (24h) — matches the GitHub route. */
const DEDUP_TTL_SEC = 86_400;
/** A head that already has an instance (any id) needs no second one on a plain MR edit. */
const HEAD_TTL_SEC = 7 * 86_400;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_MAX = 3;
// Operator pause: presence = paused, value = reason.
// Delete the key to resume.
const PAUSE_KEY = "pr-review.paused";
// Draft gate opt-back-in: presence + exact value "true" reviews drafts too.
const REVIEW_DRAFTS_KEY = "pr-review.reviewDrafts";
// `request-ai-review`'s own rolling cap, independent of the main per-MR
// throttle above — bounds how many EXPLICIT re-reviews a label can force.
const EXPLICIT_WINDOW_MS = 60 * 60 * 1000;
const EXPLICIT_MAX = 6;
const EXPLICIT_TTL_SEC = 3600;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * A bodyless `204 No Content` acknowledgement (GitLab redelivers on a non-2xx,
 * so an ignored event must still ack). A 204 is a null-body status — a Response
 * constructed with a body + 204 THROWS — so it carries no JSON.
 */
const noContent = (): Response => new Response(null, { status: 204 });

/**
 * Acknowledge a payload-shape problem (bad JSON, a forged id, …) as a
 * delivered, ignored event — see the header comment for why this is `202`,
 * never `400`. Logs the reason so it is visible in `wrangler tail` even
 * though the caller never sees more than the short string back.
 */
/** An error's message for a `reason`/log line: one line, capped — a parse
 *  error quotes attacker-controlled body text, which must never inject
 *  newlines (fake log records) or megabytes into the log or the 202 body. */
const briefError = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).replace(/[\r\n\t]+/g, " ").slice(0, 200);

const ignored = (reason: string): Response => {
  console.warn(`[webhook-gitlab] ignored: ${reason}`);
  return json({ ignored: true, reason }, 202);
};

/**
 * Constant-time string equality. Both inputs are HMAC-SHA256'd under a fresh
 * per-invocation random key, then the two fixed-length (32-byte) digests are
 * XOR-accumulated — so neither the comparison time NOR the digest length leaks
 * anything about the inputs' length or content. The double-HMAC construction is
 * the standard defence when a native constant-time `timingSafeEqual` isn't
 * available (workerd has no `node:crypto` `timingSafeEqual`). Exported for tests.
 */
export const constantTimeEqual = async (
  a: string,
  b: string,
): Promise<boolean> => {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
};

/**
 * Parse `GITLAB_ALLOWED_PROJECT_IDS` (comma-separated positive integers) into
 * a membership set — `null` when the var is unset/blank, meaning "no
 * allowlist, every project is allowed" (the default, byte-parity with every
 * other optional gate in this route). Each entry must match `^\d+$` once
 * trimmed (plain digits only — no sign, no decimal point, no exponent form
 * like `1e2`); a non-matching entry is dropped rather than failing the whole
 * list, so one typo doesn't lock out every allowed project. A non-blank
 * value where EVERY entry turns out invalid is a config mistake worth
 * surfacing, not silence: it still fails CLOSED (the returned set is empty,
 * so every project is blocked — never mistaken for "no allowlist"), and logs
 * a `console.error` so it shows up in `wrangler tail` instead of quietly
 * blocking every delivery. PURE — exported for tests.
 */
export const parseAllowedProjectIds = (
  raw: string | undefined,
): ReadonlySet<number> | null => {
  if (raw === undefined || raw.trim().length === 0) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map((s) => Math.trunc(Number(s)))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) {
    console.error(
      `[webhook-gitlab] GITLAB_ALLOWED_PROJECT_IDS is set ("${raw}") but every entry is invalid — failing closed, every project is blocked`,
    );
  }
  return new Set(ids);
};

/** The GitLab merge_request webhook payload slice this route reads. */
type GitlabMrPayload = {
  object_kind?: string;
  project?: { id?: number; web_url?: string };
  object_attributes?: {
    iid?: number;
    action?: string;
    title?: string;
    source_branch?: string;
    target_branch?: string;
    last_commit?: { id?: string };
    oldrev?: string;
    diff_refs?: { base_sha?: string; head_sha?: string };
    labels?: Array<{ title?: string }>;
    /** Newer GitLab instances — true while the MR is marked Draft. */
    draft?: boolean;
    /** Older GitLab instances carry the same flag under this name. */
    work_in_progress?: boolean;
  };
};

/**
 * Cancel this MR's still-running review of an OLDER head, after a newer head
 * has already been dispatched.
 *
 * Why: two pushes inside one minute each created their own instance, left two
 * "review started" placeholder notes on the MR, and paid for two full reviews.
 * The newer head's review supersedes the older one. The new review already
 * exists when this runs, so every D1 / network call below is best-effort:
 * each has its own try/catch that `console.warn`s and continues, and this
 * function NEVER throws.
 *
 * `terminate()` stops the old instance but does NO cleanup of its own: the
 * instance's `executions` row still says `running` and its "review started"
 * placeholder note still sits on the MR. This function does both — it marks
 * the row `superseded` and rewrites the placeholder to name the winning head.
 *
 * The race where the old instance finishes between the status read and the
 * terminate call is covered by the workflow's own post-review guard: the
 * workflow checks for a newer instance before it posts, so a lost race costs
 * a wasted review, never a stale comment.
 */
async function supersedeRunningReviews(
  env: Env,
  args: { projectId: number; iid: number; newHeadSha: string; newInstanceId: string },
): Promise<void> {
  const newHead12 = args.newHeadSha.slice(0, 12);
  let rows: Array<{ id: string; sha: string; summary_json: string | null }> = [];
  try {
    const res = await env.RUNS_METADATA.prepare(
      "SELECT id, sha, summary_json FROM executions WHERE status = ? AND id LIKE ? ESCAPE '\\' AND id != ?",
    )
      .bind("running", `mr-review\\_${args.projectId}\\_${args.iid}\\_%`, args.newInstanceId)
      .all<{ id: string; sha: string; summary_json: string | null }>();
    rows = res.results;
  } catch (e) {
    console.warn(`[webhook-gitlab] supersede query failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  for (const row of rows) {
    // A re-run of the SAME commit (`_r<seconds>`) is not superseded. A row with
    // no usable sha (legacy/malformed) is treated as another head.
    if (typeof row.sha === "string" && row.sha.startsWith(newHead12)) continue;
    let live = false;
    try {
      const inst = await env.GITLAB_REVIEW_WORKFLOW!.get(row.id);
      const st = await inst.status();
      live = ["queued", "running", "paused", "waiting", "waitingForPause"].includes(st.status);
      if (live) await inst.terminate();
    } catch (e) {
      // Not terminated → not superseded: the row keeps `running` so the run can
      // still finish and post; the next push retries the cancel.
      console.warn(`[webhook-gitlab] supersede terminate failed id="${row.id}": ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    // Not live (already complete/errored/terminated) — leave the row alone.
    if (!live) continue;
    try {
      await env.RUNS_METADATA.prepare(
        "UPDATE executions SET status = 'superseded', completed_at = ?, summary_json = json_set(coalesce(summary_json, '{}'), '$.supersededBy', ?) WHERE id = ? AND status = 'running'",
      )
        .bind(Date.now(), newHead12, row.id)
        .run();
    } catch (e) {
      console.warn(`[webhook-gitlab] supersede update failed id="${row.id}": ${e instanceof Error ? e.message : String(e)}`);
    }
    let noteId: string | undefined;
    try {
      const parsed = JSON.parse(row.summary_json ?? "{}") as { placeholderNoteId?: unknown };
      const raw = parsed.placeholderNoteId;
      if (typeof raw === "string") noteId = raw;
      else if (typeof raw === "number" && Number.isFinite(raw)) noteId = String(raw);
    } catch (e) {
      console.warn(`[webhook-gitlab] supersede summary parse failed id="${row.id}": ${e instanceof Error ? e.message : String(e)}`);
    }
    if (noteId !== undefined) {
      const scmCfg = gitlabScmConfig(env);
      if (scmCfg.token !== undefined) {
        try {
          await updateMergeRequestNote({
            token: scmCfg.token,
            projectId: args.projectId,
            iid: args.iid,
            noteId,
            body: supersededNoteBody({ newHeadSha: args.newHeadSha }),
            ...(scmCfg.baseUrl !== undefined ? { apiBase: scmCfg.baseUrl } : {}),
          });
        } catch (e) {
          console.warn(`[webhook-gitlab] supersede note failed id="${row.id}": ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    console.log(JSON.stringify({ event: "mr-review.superseded", projectId: args.projectId, iid: args.iid, superseded: row.id, by: args.newInstanceId }));
  }
}

/** Handle `POST /v1/webhooks/gitlab`. */
export const handleGitlabWebhook = async (
  request: Request,
  env: Env,
): Promise<Response> => {
  // 1. Opt-in: refuse if no webhook secret is provisioned. An empty / whitespace
  //    secret is treated as UNSET (never as a valid credential) — otherwise a
  //    blank env var would accept an empty X-Gitlab-Token.
  const secret = env.GITLAB_WEBHOOK_SECRET;
  if (secret === undefined || secret.trim().length === 0) {
    return json(
      {
        error: "webhook_not_configured",
        message: "GITLAB_WEBHOOK_SECRET is unset; GitLab mode is off on this deploy",
      },
      503,
    );
  }

  // 2. Constant-time verify X-Gitlab-Token against the secret.
  const token = request.headers.get(TOKEN_HEADER) ?? "";
  const ok = await constantTimeEqual(token, secret);
  if (!ok) {
    return json(
      { error: "unauthorized", message: "X-Gitlab-Token missing or invalid" },
      401,
    );
  }

  // 2b. Fail CLOSED without the throttle binding. The per-MR throttle, the
  //     delivery-UUID dedup and the per-head marker all live in
  //     IDEMPOTENCY_KV — a deploy without it cannot honour any of that
  //     contract, so it refuses every delivery rather than silently running
  //     unthrottled and undeduped.
  if (env.IDEMPOTENCY_KV === undefined) {
    return json(
      {
        error: "throttle_not_configured",
        message: "IDEMPOTENCY_KV binding is absent; the throttle, the delivery dedup and the per-head marker need it",
      },
      503,
    );
  }

  // 3. Only merge_request events; anything else is acknowledged + ignored.
  const event = request.headers.get(EVENT_HEADER);
  if (event !== MERGE_REQUEST_EVENT) {
    return noContent();
  }

  // 4. Parse the body and gate on object_kind + action. A parse/shape problem
  //    is GitLab's fault or a config mismatch, never something a redelivery
  //    fixes — ack it `202 ignored`, never `400` (see the header comment).
  let payload: GitlabMrPayload;
  try {
    payload = (await request.json()) as GitlabMrPayload;
  } catch (cause) {
    return ignored(`invalid json: ${briefError(cause)}`);
  }
  if (typeof payload !== "object" || payload === null) {
    return ignored("body is not a JSON object");
  }
  const action = payload.object_attributes?.action;
  if (payload.object_kind !== "merge_request" || action === undefined || !REVIEWABLE_ACTIONS.has(action)) {
    return noContent();
  }

  // 4b. Validate the identifiers BEFORE they are interpolated into a GitLab API
  //     URL. `project.id` + `iid` MUST be positive integers — a forged string
  //     (e.g. "../../projects/2/merge_requests/1") is rejected here (defence in
  //     depth over gitlab-app's own URL-encoding).
  const projectId = Math.trunc(Number(payload.project?.id));
  const iid = Math.trunc(Number(payload.object_attributes?.iid));
  if (!Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(iid) || iid <= 0) {
    return ignored("project.id and object_attributes.iid must be positive integers");
  }

  // 4b2. Optional project allowlist. Unset → every project is allowed (the
  //      default). A payload for a project not on the list is ignored, not
  //      rejected — the same posture as every other "not for us" gate here.
  const allowedProjectIds = parseAllowedProjectIds(env.GITLAB_ALLOWED_PROJECT_IDS);
  if (allowedProjectIds !== null && !allowedProjectIds.has(projectId)) {
    return ignored("project not allowed");
  }
  const lb = payload.object_attributes?.labels;
  const ti = Array.isArray(lb) ? lb.map((l) => (l as { title?: unknown })?.title).filter((t): t is string => typeof t === "string") : [];
  if (ti.includes("skip-ai-review")) {
    return noContent();
  }
  const bypass = ti.includes("request-ai-review");

  // 4c. Draft gate: review only non-draft MRs by default. GitLab's payload
  // carries `object_attributes.draft` on newer instances; older instances use
  // `work_in_progress` for the same flag — check both. The `request-ai-review`
  // label bypasses the gate for one MR; a deploy-wide CONFIG_KV key turns
  // drafts back on entirely. A KV read failure fails CLOSED (stays gated) —
  // the opposite default from the operator-pause key below, because "don't
  // review drafts" is this gate's safe default, not "do". When a draft moves
  // to ready, GitLab fires an `update` event with draft=false, so the MR's
  // first review happens naturally on that event — no separate transition
  // logic is needed here.
  const oaDraft = payload.object_attributes ?? {};
  const isDraft = oaDraft.draft === true || oaDraft.work_in_progress === true;
  if (isDraft && !bypass) {
    let reviewDrafts = false;
    try {
      reviewDrafts = (await env.CONFIG_KV?.get(REVIEW_DRAFTS_KEY)) === "true";
    } catch (e) {
      console.warn(`[webhook-gitlab] reviewDrafts get failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!reviewDrafts) {
      return noContent();
    }
  }

  // 4d. Operator pause: CONFIG_KV pr-review.paused presence pauses dispatch.
  // Value is the free-text reason; delete the key to resume. No Workflow,
  // throttle or dedup writes occur while paused; request-ai-review does not bypass.
  let paused: string | null = null;
  try {
    paused = (await env.CONFIG_KV?.get(PAUSE_KEY)) ?? null;
  } catch (e) {
    console.warn(`[webhook-gitlab] pause get failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (paused !== null) {
    const reason = paused.trim().slice(0, 200);
    return json({ status: "paused", reason }, 200);
  }
  // 4e. One review per head. GitLab fires `update` on every MR edit (labels, title,
  //     assignees); a head already reviewed under any instance id needs nothing more, and
  //     it must not consume the throttle either, so this runs before dedup and throttle.
  // IDEMPOTENCY_KV's presence was verified in step 2b — narrow it once here
  // so the rest of the handler reads a plain `KVNamespace`, not an optional
  // one, and the now-dead `!== undefined` guards below can drop.
  const idempotencyKv = env.IDEMPOTENCY_KV;
  const oa = payload.object_attributes ?? {};
  const earlyHead = oa.diff_refs?.head_sha ?? oa.last_commit?.id ?? "";
  const headKey = `head:${projectId}:${iid}:${earlyHead}`;
  if (!bypass && earlyHead.length > 0) {
    try {
      const seen = await idempotencyKv.get(headKey);
      if (seen !== null) {
        return json({ deduped: true, head: earlyHead, executionId: seen }, 202);
      }
    } catch (e) {
      console.warn(`[webhook-gitlab] head get failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // 5. Optional receiver-level dedup on the delivery UUID. Only the GET (the
  //    check) happens here — the marker is written only once the dispatch
  //    below actually succeeds or is itself the duplicate-create path (step
  //    8), so a failed `create` never poisons a later redelivery into a
  //    silent no-op.
  const deliveryId = request.headers.get(EVENT_UUID_HEADER);
  if (deliveryId !== null && deliveryId.length > 0) {
    try {
      const seen = await idempotencyKv.get(`gl-delivery:${deliveryId}`);
      if (seen !== null) {
        return json({ deduped: true, deliveryId }, 202);
      }
    } catch (e) {
      console.warn(`[webhook-gitlab] dedup get failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const tKey = `throttle:${projectId}:${iid}`;
  let tState: { starts: number[]; notedAt?: number } | null = null;
  {
    const now = Date.now();
    const st: { starts: number[]; notedAt?: number } = { starts: [] };
    try {
      const raw = await idempotencyKv.get(tKey);
      if (raw !== null) {
        try {
          const p = JSON.parse(raw) as { starts?: unknown; notedAt?: unknown };
          if (Array.isArray(p.starts)) st.starts = p.starts.filter((x): x is number => typeof x === "number");
          if (typeof p.notedAt === "number") st.notedAt = p.notedAt;
        } catch {}
      }
    } catch (e) {
      console.warn(`[webhook-gitlab] throttle get failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    st.starts = st.starts.filter((s) => s <= now && now - s < THROTTLE_WINDOW_MS).sort((a, b) => a - b);
    if (!bypass && st.starts.length >= THROTTLE_MAX) {
      const retryAt = st.starts[0]! + THROTTLE_WINDOW_MS;
      const retryAfterSec = Math.min(900, Math.max(1, Math.ceil((retryAt - now) / 1000)));
      if (st.notedAt === undefined || now - st.notedAt >= THROTTLE_WINDOW_MS) {
        const hhmm = new Date(retryAt).toISOString().slice(11, 16);
        const noteBody = `Review throttled: three reviews in the last 15 minutes. The next review runs after ${hhmm} UTC, or add the \`request-ai-review\` label.\n\n<!-- flare-dispatch: mr-review-throttle -->`;
        // Same token/base-URL hygiene as the Workflow's own scm Layer (trims,
        // treats blank as absent) — a self-hosted deploy's throttle note must
        // reach GITLAB_BASE_URL, never gitlab.com, when one is configured.
        const scmCfg = gitlabScmConfig(env);
        if (scmCfg.token !== undefined) {
          try {
            await postMergeRequestNote({
              token: scmCfg.token,
              projectId,
              iid,
              body: noteBody,
              ...(scmCfg.baseUrl !== undefined ? { apiBase: scmCfg.baseUrl } : {}),
            });
            // Only a delivered note suppresses the next one; a failed or skipped
            // post leaves notedAt unset so the next trigger retries the note.
            st.notedAt = now;
          } catch (e) {
            console.warn(`[webhook-gitlab] throttle note failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      try {
        await idempotencyKv.put(tKey, JSON.stringify(st), { expirationTtl: 900 });
      } catch (e) {
        console.warn(`[webhook-gitlab] throttle put failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      console.log(JSON.stringify({ event: "mr-review.throttled", projectId, iid, retryAfterSec }));
      return json({ status: "throttled", retryAfterSec }, 202);
    }
    tState = st;
  }

  // 5b. `request-ai-review`'s OWN rolling cap — independent of the per-MR
  //     throttle above (which a bypass request skips the CHECK of, but still
  //     records a slot into). Without this, a labelling bot or a flapping
  //     label could force unlimited reviews. Over the cap → 202, no note (the
  //     main throttle already covers the "tell the author why" case; a
  //     second throttle note for the SAME MR would be noisy).
  let bypassState: { starts: number[] } | null = null;
  if (bypass) {
    const bKey = `throttle-bypass:${projectId}:${iid}`;
    const now = Date.now();
    let starts: number[] = [];
    try {
      const raw = await idempotencyKv.get(bKey);
      if (raw !== null) {
        try {
          const p = JSON.parse(raw) as { starts?: unknown };
          if (Array.isArray(p.starts)) starts = p.starts.filter((x): x is number => typeof x === "number");
        } catch {}
      }
    } catch (e) {
      console.warn(`[webhook-gitlab] bypass throttle get failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    starts = starts.filter((s) => s <= now && now - s < EXPLICIT_WINDOW_MS).sort((a, b) => a - b);
    if (starts.length >= EXPLICIT_MAX) {
      return json({ status: "throttled", scope: "explicit" }, 202);
    }
    bypassState = { starts };
  }

  // 6. The review Workflow must be bound to dispatch.
  if (env.GITLAB_REVIEW_WORKFLOW === undefined) {
    return json(
      {
        error: "workflow_not_configured",
        message: "GITLAB_REVIEW_WORKFLOW binding is absent on this deploy",
      },
      503,
    );
  }

  // 7. Extract the run inputs (mrInputsFromPayload is the run's canonical
  //    mapping — prefers diff_refs endpoints). Override projectId/iid with the
  //    VALIDATED integers above (mrInputsFromPayload coerces; these are checked).
  //    Add source/target branch context.
  const input = {
    ...mrInputsFromPayload(payload),
    projectId: String(projectId),
    iid,
    ...(payload.object_attributes?.source_branch !== undefined
      ? { sourceBranch: payload.object_attributes.source_branch }
      : {}),
    ...(payload.object_attributes?.target_branch !== undefined
      ? { targetBranch: payload.object_attributes.target_branch }
      : {}),
  };
  // GitLab omits `diff_refs` on merge_request events (observed on gitlab.com,
  // 2026-09-14, for both `open` and `update`): the head comes from
  // `last_commit.id` and the base is unknown until the diff API answers. The
  // diff fetch keys on the iid, so only the head is required here.
  if (input.headSha.length === 0) {
    return ignored("missing head sha (no diff_refs.head_sha or last_commit.id)");
  }

  // 8. Dispatch — a stable id collapses redeliveries at the platform layer.
  // The semantic key MUST pass through toInstanceId: CF Workflows accepts only
  // [A-Za-z0-9_-] (≤64 chars) — a raw `:`-joined key fails instance.invalid_id.
  const baseId = `mr-review:${input.projectId}:${input.iid}:${input.headSha.slice(0, 12)}`;
  // `request-ai-review` means "one review now": a head that already has an instance (finished
  // or errored — instance ids live forever) gets a per-second suffix so the review really runs.
  const id = toInstanceId(bypass ? `${baseId}:r${Math.floor(Date.now() / 1000)}` : baseId);
  let duplicated = false;
  try {
    await env.GITLAB_REVIEW_WORKFLOW.create({ id, params: { executionId: id, input } });
  } catch (cause) {
    const message = briefError(cause);
    // A duplicate create IS the dedup path — treat it as accepted.
    if (!/already.?exists|duplicate/i.test(message)) {
      console.error(`[webhook-gitlab] create failed id="${id}": ${message}`);
      return json({ error: "dispatch_failed", detail: message }, 500);
    }
    duplicated = true;
  }
  // 9. Supersede — a newer head cancels the MR's running review of an older
  //    head. The new instance already exists; the old one (if still live) is
  //    terminated and its row + placeholder note are updated. Best-effort,
  //    never throws.
  if (!duplicated) {
    await supersedeRunningReviews(env, { projectId, iid, newHeadSha: input.headSha, newInstanceId: id });
  }
  // The delivery-UUID marker is written ONLY once dispatch actually succeeded
  // or was itself the duplicate-create path — never on the 500 branch above,
  // which returns before reaching here — so a genuinely failed create leaves
  // no marker behind and the SAME delivery UUID redelivers cleanly.
  if (deliveryId !== null && deliveryId.length > 0) {
    try {
      await idempotencyKv.put(`gl-delivery:${deliveryId}`, "1", { expirationTtl: DEDUP_TTL_SEC });
    } catch (e) {
      console.warn(`[webhook-gitlab] dedup put failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!duplicated) {
    try {
      await idempotencyKv.put(headKey, id, { expirationTtl: HEAD_TTL_SEC });
    } catch (e) {
      console.warn(`[webhook-gitlab] head put failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!duplicated && tState !== null) {
    tState.starts.push(Date.now());
    try {
      await idempotencyKv.put(tKey, JSON.stringify(tState), { expirationTtl: 900 });
    } catch (e) {
      console.warn(`[webhook-gitlab] throttle record failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // A duplicate create is the SAME instance the caller already has — it never
  // ran a second review, so it must not also consume a second explicit-cap
  // slot (mirrors the head/throttle records above, which use the same guard).
  if (!duplicated && bypassState !== null) {
    bypassState.starts.push(Date.now());
    try {
      await idempotencyKv.put(`throttle-bypass:${projectId}:${iid}`, JSON.stringify(bypassState), {
        expirationTtl: EXPLICIT_TTL_SEC,
      });
    } catch (e) {
      console.warn(`[webhook-gitlab] bypass throttle record failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return json({ accepted: true, executionId: id, action }, 202);
};
