// FlareDispatch Dispatcher — operator Slack alerts for failures outside a review's own
// `notify-failure` step (operator ask 2026-09-27): an uncaught exception in the fetch handler
// or the Workflow, a failed Workflow create, a missing binding, a review row that never finalized.
//
// Same incoming webhook (`SLACK_WEBHOOK_URL`) and poster as gitlab-slack-notify.ts. Anti-spam:
// one message per alert key per OPS_ALERT_COOLDOWN_MS, deduped in IDEMPOTENCY_KV; repeats inside
// the cooldown are counted and reported on the next message. A failed post never throws and never
// starts the cooldown. KV is eventually consistent, so two isolates can both post the first
// message of a burst: the guard is against a stream of alerts, not an exact-once protocol.

import { postSlackFailureNotification } from "./gitlab-slack-notify";

export const WORKER_NAME = "flare-dispatch-review";
export const OPS_ALERT_COOLDOWN_MS = 30 * 60_000;
/** The record outlives the cooldown so the repeat count reaches the next message. */
const RECORD_TTL_SECONDS = 24 * 60 * 60;
const MAX_WHAT_CHARS = 300;

export type OpsAlertInput = {
  /** Dedupe key, e.g. `workflow-create-failed`. */
  readonly key: string;
  readonly severity: "critical" | "warning" | "info";
  /** One line. No secrets, no tokens, no client code. */
  readonly what: string;
  readonly ids?: Readonly<Record<string, string | number | undefined>>;
};

export type OpsAlertEnv = {
  readonly SLACK_WEBHOOK_URL?: string;
  readonly IDEMPOTENCY_KV?: KVNamespace;
};

type AlertRecord = { sentAt: number; suppressed: number; suppressedSince?: number };

const utc = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
const escapeMrkdwn = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const formatOpsAlert = (
  input: OpsAlertInput,
  now: number,
  repeats?: { count: number; since: number },
): string => {
  const ids = Object.entries(input.ids ?? {})
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  const lines = [
    `${WORKER_NAME} [${input.severity}] ${escapeMrkdwn(input.what.slice(0, MAX_WHAT_CHARS))}`,
    `${ids ? `${escapeMrkdwn(ids)} · ` : ""}key \`${escapeMrkdwn(input.key)}\` · ${utc(now)}`,
  ];
  if (repeats !== undefined && repeats.count > 0) {
    lines.push(`(+${repeats.count} more of this key since ${utc(repeats.since)}, not sent)`);
  }
  return lines.join("\n");
};

const recordKey = (key: string): string => `ops-alert:${key}`;

const readRecord = async (
  kv: KVNamespace | undefined,
  key: string,
): Promise<AlertRecord | null> => {
  try {
    const raw = await kv?.get(recordKey(key));
    return raw ? (JSON.parse(raw) as AlertRecord) : null;
  } catch (e) {
    console.warn(
      `[ops-alert] record read failed, alerting anyway: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
};

const writeRecord = async (
  kv: KVNamespace | undefined,
  key: string,
  rec: AlertRecord,
): Promise<void> => {
  try {
    await kv?.put(recordKey(key), JSON.stringify(rec), { expirationTtl: RECORD_TTL_SECONDS });
  } catch (e) {
    console.warn(`[ops-alert] record write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

type OpsAlertResult = "sent" | "suppressed" | "failed" | "disabled";

/** Sends one deduped operator alert. Never throws. */
export const opsAlert = async (
  env: OpsAlertEnv,
  input: OpsAlertInput,
  now: number = Date.now(),
): Promise<OpsAlertResult> => {
  try {
    return await sendOpsAlert(env, input, now);
  } catch (e) {
    console.warn(`[ops-alert] ${input.key} failed: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
};

const sendOpsAlert = async (
  env: OpsAlertEnv,
  input: OpsAlertInput,
  now: number,
): Promise<OpsAlertResult> => {
  console.warn(`[ops-alert] ${input.severity} ${input.key} ${input.what}`);
  const url = env.SLACK_WEBHOOK_URL;
  if (url === undefined || url.trim().length === 0) return "disabled";
  const rec = await readRecord(env.IDEMPOTENCY_KV, input.key);
  if (rec !== null && now - rec.sentAt < OPS_ALERT_COOLDOWN_MS) {
    await writeRecord(env.IDEMPOTENCY_KV, input.key, {
      ...rec,
      suppressed: rec.suppressed + 1,
      suppressedSince: rec.suppressedSince ?? now,
    });
    return "suppressed";
  }
  const repeats =
    rec !== null && rec.suppressed > 0
      ? { count: rec.suppressed, since: rec.suppressedSince ?? rec.sentAt }
      : undefined;
  const ok = await postSlackFailureNotification(url, { text: formatOpsAlert(input, now, repeats) });
  if (!ok) return "failed";
  await writeRecord(env.IDEMPOTENCY_KV, input.key, { sentAt: now, suppressed: 0 });
  return "sent";
};

/** A review row `running` this long never finalized (a review runs at most two 25-min attempts). */
export const STALE_REVIEW_MS = 60 * 60_000;
/** Most rows one sweep reads; the message says when there are more. */
const STALE_LIMIT = 100;
/** A stale row is named in one message only: its claim outlives any stuck row worth a message. */
const STALE_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;
const staleClaimKey = (id: string): string => `ops-alert:stale-row:${id}`;

/**
 * The cron's sweep: a Workflow instance that died without reaching its `finalize` step (e.g. a
 * deploy reset its Durable Object, WorkflowInternalError) sends no `notify-failure` and leaves its
 * row `running`. Each stale row is claimed in IDEMPOTENCY_KV once a message named it, so it is
 * alerted once, however long the sweep or Slack was down; the message counts every stale row.
 * Never throws.
 */
export const sweepStaleReviews = async (
  env: OpsAlertEnv & { readonly RUNS_METADATA?: D1Database },
  now: number = Date.now(),
): Promise<void> => {
  try {
    if (env.RUNS_METADATA === undefined) return;
    const { results } = await env.RUNS_METADATA.prepare(
      "SELECT id, started_at FROM executions WHERE status = ? AND started_at < ? LIMIT ?",
    )
      .bind("running", now - STALE_REVIEW_MS, STALE_LIMIT)
      .all<{ id: string; started_at: number }>();
    const rows = results ?? [];
    const fresh: { id: string; started_at: number }[] = [];
    for (const r of rows) {
      if ((await env.IDEMPOTENCY_KV?.get(staleClaimKey(r.id))) == null) fresh.push(r);
    }
    if (fresh.length === 0) return;
    const newest = fresh.reduce((a, b) => (b.started_at > a.started_at ? b : a));
    const total = rows.length >= STALE_LIMIT ? `${STALE_LIMIT}+` : String(rows.length);
    const sent = await opsAlert(
      env,
      {
        key: "stale-review",
        severity: "warning",
        what: `${fresh.length} new of ${total} review(s) running for over 60 min and never finalized (no notify-failure was sent)`,
        ids: { execution: newest.id },
      },
      now,
    );
    // Claim only what a message named: a suppressed or failed alert names them again later.
    if (sent !== "sent") return;
    for (const r of fresh) {
      await env.IDEMPOTENCY_KV?.put(staleClaimKey(r.id), String(now), {
        expirationTtl: STALE_CLAIM_TTL_SECONDS,
      });
    }
  } catch (e) {
    await opsAlert(
      env,
      {
        key: "exception:stale-sweep",
        severity: "critical",
        what: `stale-review sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      now,
    );
  }
};

const firstLine = (e: unknown): string =>
  (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).split("\n")[0] ?? "";

/** The fetch handler's top-level guard: an uncaught exception alerts and answers 500. */
export const guardFetch = async (
  env: OpsAlertEnv,
  handler: () => Promise<Response>,
): Promise<Response> => {
  try {
    return await handler();
  } catch (e) {
    await opsAlert(env, {
      key: "exception:fetch",
      severity: "critical",
      what: `uncaught exception in fetch: ${firstLine(e)}`,
    });
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

/**
 * The review Workflow threw out of run() (a step failed after its retries): its notify-failure
 * step never ran. The caller rethrows so the instance still ends `errored`.
 */
export const reportWorkflowException = async (
  env: OpsAlertEnv,
  payload: {
    readonly executionId?: string;
    readonly input?: {
      readonly projectId?: string;
      readonly iid?: number;
      readonly headSha?: string;
    };
  },
  e: unknown,
): Promise<void> => {
  const msg = e instanceof Error ? e.message : String(e);
  await opsAlert(env, {
    key: "exception:workflow",
    severity: "critical",
    what: `review Workflow threw: ${(msg.split("\n")[0] ?? "").slice(0, 200)}`,
    ids: {
      project: payload.input?.projectId,
      mr: payload.input?.iid,
      head: payload.input?.headSha?.slice(0, 12),
      execution: payload.executionId,
    },
  });
};
