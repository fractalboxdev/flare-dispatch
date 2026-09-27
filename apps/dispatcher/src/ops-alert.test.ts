// Operator Slack alerts beyond the per-head notify-failure (operator ask 2026-09-27).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatOpsAlert,
  guardFetch,
  OPS_ALERT_COOLDOWN_MS,
  opsAlert,
  reportWorkflowException,
  sweepStaleReviews,
} from "./ops-alert";
import { makeFakeD1, makeFakeKv } from "./test-helpers";

const T0 = Date.UTC(2026, 8, 27, 12);
const HOOK = "https://hooks.slack.invalid/services/SECRET";

const slack = (status = 200) => {
  const posts: string[] = [];
  const state = { status };
  vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
    posts.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response("", { status: state.status });
  });
  return { posts, state };
};
afterEach(() => vi.unstubAllGlobals());

const input = {
  key: "workflow-create-failed",
  severity: "critical" as const,
  what: "create failed",
};

describe("opsAlert: one message per key per 30 min, deduped in IDEMPOTENCY_KV", () => {
  it("a burst sends once, then once more with the count after the cooldown", async () => {
    const s = slack();
    const kv = makeFakeKv();
    const env = { SLACK_WEBHOOK_URL: HOOK, IDEMPOTENCY_KV: kv.binding };
    expect(await opsAlert(env, input, T0)).toBe("sent");
    expect(await opsAlert(env, input, T0 + 1000)).toBe("suppressed");
    expect(await opsAlert(env, input, T0 + 2000)).toBe("suppressed");
    expect(s.posts).toHaveLength(1);
    expect(await opsAlert(env, input, T0 + OPS_ALERT_COOLDOWN_MS)).toBe("sent");
    expect(s.posts[1]).toContain("(+2 more of this key since 2026-09-27 12:00:01 UTC, not sent)");
  });

  it("a failed post never throws and does not start the cooldown", async () => {
    const s = slack(500);
    const env = { SLACK_WEBHOOK_URL: HOOK, IDEMPOTENCY_KV: makeFakeKv().binding };
    expect(await opsAlert(env, input, T0)).toBe("failed");
    s.state.status = 200;
    expect(await opsAlert(env, input, T0 + 1)).toBe("sent");
  });

  it("no webhook: disabled; a KV error still alerts", async () => {
    const s = slack();
    expect(await opsAlert({ IDEMPOTENCY_KV: makeFakeKv().binding }, input, T0)).toBe("disabled");
    const broken = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    };
    expect(
      await opsAlert(
        { SLACK_WEBHOOK_URL: HOOK, IDEMPOTENCY_KV: broken as unknown as KVNamespace },
        input,
        T0,
      ),
    ).toBe("sent");
    expect(s.posts).toHaveLength(1);
  });

  it("format: Worker name, severity, ids, UTC; mrkdwn escaped", () => {
    expect(
      formatOpsAlert({ key: "k", severity: "warning", what: "a <b>", ids: { mr: 7 } }, T0),
    ).toBe("flare-dispatch-review [warning] a &lt;b&gt;\nmr=7 · key `k` · 2026-09-27 12:00:00 UTC");
  });
});

describe("sweepStaleReviews: a review row `running` for over 60 min never finalized", () => {
  it("alerts once with the count and the oldest id; an older row alerted already", async () => {
    const s = slack();
    const kv = makeFakeKv();
    const d1 = makeFakeD1({
      executions: [
        { id: "mr-review-old", status: "running", started_at: T0 - 61 * 60_000 },
        { id: "mr-review-ancient", status: "running", started_at: T0 - 5 * 60 * 60_000 },
        { id: "mr-review-new", status: "running", started_at: T0 - 5 * 60_000 },
      ],
    } as never);
    const env = { SLACK_WEBHOOK_URL: HOOK, IDEMPOTENCY_KV: kv.binding, RUNS_METADATA: d1.binding };
    await sweepStaleReviews(env, T0);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]).toContain("1 review(s) running for over 60 min");
    expect(s.posts[0]).toContain("execution=mr-review-old");
    // A row alerts in the sweeps of its first 15 stale minutes only, not every 30 min for ever.
    await sweepStaleReviews(env, T0 + 16 * 60_000);
    expect(s.posts).toHaveLength(1);
  });
});

describe("handler guards", () => {
  it("guardFetch: an uncaught exception alerts critical and answers 500", async () => {
    const s = slack();
    const env = { SLACK_WEBHOOK_URL: HOOK, IDEMPOTENCY_KV: makeFakeKv().binding };
    const res = await guardFetch(env, async () => {
      throw new TypeError("boom");
    });
    expect(res.status).toBe(500);
    expect(s.posts[0]).toMatch(
      /^flare-dispatch-review \[critical\] uncaught exception in fetch: TypeError: boom/,
    );
    const ok = await guardFetch(env, async () => new Response("fine"));
    expect(await ok.text()).toBe("fine");
  });

  it("reportWorkflowException: alerts with the MR ids, then the caller rethrows", async () => {
    const s = slack();
    const env = { SLACK_WEBHOOK_URL: HOOK, IDEMPOTENCY_KV: makeFakeKv().binding };
    await reportWorkflowException(
      env,
      {
        executionId: "mr-review-42-7-abc",
        input: { projectId: "42", iid: 7, headSha: "abcdef0123456789" },
      },
      new Error("D1 unavailable"),
    );
    expect(s.posts[0]).toContain("[critical] review Workflow threw: D1 unavailable");
    expect(s.posts[0]).toContain("project=42 mr=7 head=abcdef012345 execution=mr-review-42-7-abc");
  });
});
