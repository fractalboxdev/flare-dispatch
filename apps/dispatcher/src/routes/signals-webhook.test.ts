// FlareDispatch Dispatcher — `POST /v1/webhooks/signals/:source` acceptance tests.
//
// Drives `handleSignalsWebhook` via the router with a hand-built `Request` +
// fake `Env`. Covers the spec/04-gha-integration.md § Signal ingress contract:
//   bad `:source` (not the slug shape)            → 404;
//   CONFIG_KV / token unset                       → 503 (fail closed);
//   bearer token missing/mismatch                 → 401;
//   unparseable JSON body                          → 400;
//   custom mapping (dot-paths + literal)           → 202, one signal dispatched;
//   default mapping (no signals.map.<source>)      → 202, common-field signal;
//   oversized fields                               → clamped, not rejected;
//   duplicate delivery id                          → deduped, one Workflow.create;
//   distinct alerts (no delivery header)           → two Workflow.creates;
//   unmappable payload (custom template, no hits)  → 422.

import { describe, expect, it } from "vitest";
import {
  MAX_SIGNAL_DETAIL_CHARS,
  MAX_SIGNAL_TITLE_CHARS,
} from "@fractalboxdev/flare-dispatch-core";
import { handleRequest } from "../router";
import {
  makeFakeEnv,
  makeFakeKv,
  makeFakeR2,
  makeFakeWorkflow,
} from "../test-helpers";

const HMAC_SECRET = "unused-but-required-by-env-shape";
const TOKEN = "ingress-token-please-rotate-aaaaaaaa";

const url = (source: string) =>
  `https://dispatcher.example/v1/webhooks/signals/${source}`;

const signalsRequest = (
  source: string,
  payload: unknown,
  opts: {
    token?: string | null;
    deliveryId?: string;
    rawBody?: string;
  } = {},
): Request => {
  const bodyText = opts.rawBody ?? JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== null) {
    headers["Authorization"] = `Bearer ${opts.token ?? TOKEN}`;
  }
  if (opts.deliveryId !== undefined) {
    headers["X-Delivery-Id"] = opts.deliveryId;
  }
  return new Request(url(source), { method: "POST", headers, body: bodyText });
};

const fixture = (
  opts: {
    withConfig?: boolean;
    withToken?: boolean;
    withKv?: boolean;
    map?: Record<string, string>; // source -> JSON template string
  } = {},
) => {
  const workflow = makeFakeWorkflow();
  const storage = makeFakeR2();
  const idempotencyKv = opts.withKv ? makeFakeKv() : undefined;
  const configKv = opts.withConfig === false ? undefined : makeFakeKv();
  if (configKv !== undefined && opts.withToken !== false) {
    configKv.store.set("signals.webhook.token", TOKEN);
  }
  if (configKv !== undefined && opts.map !== undefined) {
    for (const [source, template] of Object.entries(opts.map)) {
      configKv.store.set(`signals.map.${source}`, template);
    }
  }
  const env = makeFakeEnv({
    hmacSecret: HMAC_SECRET,
    workflow,
    storage,
    idempotencyKv: idempotencyKv?.binding,
    configKv: configKv?.binding,
  });
  return { workflow, env, idempotencyKv, configKv };
};

describe("POST /v1/webhooks/signals/:source — guards", () => {
  it("bad source label → 404", async () => {
    const { env, workflow } = fixture();
    const res = await handleRequest(
      signalsRequest("Bad_Source!", { title: "x" }),
      env,
    );
    expect(res.status).toBe(404);
    expect(workflow.calls).toHaveLength(0);
  });

  it("CONFIG_KV unbound → 503", async () => {
    const { env, workflow } = fixture({ withConfig: false });
    const res = await handleRequest(
      signalsRequest("vendor-a", { title: "x" }),
      env,
    );
    expect(res.status).toBe(503);
    expect(workflow.calls).toHaveLength(0);
  });

  it("token unset in CONFIG_KV → 503", async () => {
    const { env, workflow } = fixture({ withToken: false });
    const res = await handleRequest(
      signalsRequest("vendor-a", { title: "x" }),
      env,
    );
    expect(res.status).toBe(503);
    expect(workflow.calls).toHaveLength(0);
  });

  it("missing bearer token → 401", async () => {
    const { env, workflow } = fixture();
    const res = await handleRequest(
      signalsRequest("vendor-a", { title: "x" }, { token: null }),
      env,
    );
    expect(res.status).toBe(401);
    expect(workflow.calls).toHaveLength(0);
  });

  it("wrong bearer token → 401", async () => {
    const { env, workflow } = fixture();
    const res = await handleRequest(
      signalsRequest("vendor-a", { title: "x" }, { token: "not-the-token" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(workflow.calls).toHaveLength(0);
  });

  it("unparseable JSON body → 400", async () => {
    const { env, workflow } = fixture();
    const res = await handleRequest(
      signalsRequest("vendor-a", undefined, { rawBody: "{not json" }),
      env,
    );
    expect(res.status).toBe(400);
    expect(workflow.calls).toHaveLength(0);
  });

  it("wrong method → 405", async () => {
    const { env } = fixture();
    const res = await handleRequest(
      new Request(url("vendor-a"), { method: "GET" }),
      env,
    );
    expect(res.status).toBe(405);
  });
});

describe("POST /v1/webhooks/signals/:source — mapping", () => {
  it("custom mapping (dot-paths + literal) → 202, one mapped signal", async () => {
    const { env, workflow } = fixture({
      map: {
        "vendor-a": JSON.stringify({
          title: "$.alert_title",
          detail: "$.body.message",
          url: "$.links.0.href",
          count: "$.occurrences",
          source: "ignored-unknown-key",
        }),
      },
    });
    const payload = {
      alert_title: "High error rate",
      body: { message: "5xx spiked on api" },
      links: [{ href: "https://vendor-a.example/alert/1" }],
      occurrences: 42,
    };
    const res = await handleRequest(signalsRequest("vendor-a", payload), env);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { executionId: string };
    expect(body.executionId.startsWith("signals:vendor-a:")).toBe(true);

    expect(workflow.calls).toHaveLength(1);
    const params = workflow.calls[0]!.params as {
      run: string;
      github: { repo: string; sha: string };
      inputs: {
        firedAt: number;
        signals: Array<{
          source: string;
          title: string;
          detail: string;
          url?: string;
          count?: number;
        }>;
      };
    };
    expect(params.run).toBe("ci-triage-pr");
    expect(params.github.repo).toBe("signals/vendor-a");
    expect(params.inputs.signals).toHaveLength(1);
    const sig = params.inputs.signals[0]!;
    expect(sig.source).toBe("webhook:vendor-a");
    expect(sig.title).toBe("High error rate");
    expect(sig.detail).toBe("5xx spiked on api");
    expect(sig.url).toBe("https://vendor-a.example/alert/1");
    expect(sig.count).toBe(42);
    expect(typeof params.inputs.firedAt).toBe("number");
  });

  it("literal template values pass through verbatim", async () => {
    const { env, workflow } = fixture({
      map: {
        "vendor-b": JSON.stringify({
          title: "constant title",
          detail: "$.msg",
        }),
      },
    });
    const res = await handleRequest(
      signalsRequest("vendor-b", { msg: "the detail" }),
      env,
    );
    expect(res.status).toBe(202);
    const params = workflow.calls[0]!.params as {
      inputs: { signals: Array<{ title: string; detail: string }> };
    };
    expect(params.inputs.signals[0]!.title).toBe("constant title");
    expect(params.inputs.signals[0]!.detail).toBe("the detail");
  });

  it("default mapping (no signals.map) maps common fields", async () => {
    const { env, workflow } = fixture();
    const payload = {
      message: "Disk almost full",
      description: "node-7 at 95%",
      link: "https://vendor-a.example/x",
    };
    const res = await handleRequest(signalsRequest("vendor-a", payload), env);
    expect(res.status).toBe(202);
    const sig = (
      workflow.calls[0]!.params as {
        inputs: { signals: Array<{ title: string; detail: string; url?: string }> };
      }
    ).inputs.signals[0]!;
    expect(sig.title).toBe("Disk almost full");
    expect(sig.detail).toBe("node-7 at 95%");
    expect(sig.url).toBe("https://vendor-a.example/x");
  });

  it("default mapping falls back to JSON excerpt for detail when no known field", async () => {
    const { env, workflow } = fixture();
    const payload = { title: "Only a title", weird_field: "no detail key" };
    const res = await handleRequest(signalsRequest("vendor-a", payload), env);
    expect(res.status).toBe(202);
    const sig = (
      workflow.calls[0]!.params as {
        inputs: { signals: Array<{ title: string; detail: string }> };
      }
    ).inputs.signals[0]!;
    expect(sig.title).toBe("Only a title");
    expect(sig.detail).toContain("weird_field");
  });

  it("oversized fields are clamped, not rejected", async () => {
    const { env, workflow } = fixture({
      map: { "vendor-a": JSON.stringify({ title: "$.t", detail: "$.d" }) },
    });
    const longTitle = "T".repeat(MAX_SIGNAL_TITLE_CHARS + 500);
    const longDetail = "D".repeat(MAX_SIGNAL_DETAIL_CHARS + 5000);
    const res = await handleRequest(
      signalsRequest("vendor-a", { t: longTitle, d: longDetail }),
      env,
    );
    expect(res.status).toBe(202);
    const sig = (
      workflow.calls[0]!.params as {
        inputs: { signals: Array<{ title: string; detail: string }> };
      }
    ).inputs.signals[0]!;
    expect(sig.title.length).toBe(MAX_SIGNAL_TITLE_CHARS);
    expect(sig.detail.length).toBe(MAX_SIGNAL_DETAIL_CHARS);
  });

  it("unmappable payload (custom template, no path hits) → 422", async () => {
    const { env, workflow } = fixture({
      map: {
        "vendor-a": JSON.stringify({ title: "$.nope", detail: "$.also_nope" }),
      },
    });
    const res = await handleRequest(
      signalsRequest("vendor-a", { something: "else" }),
      env,
    );
    expect(res.status).toBe(422);
    expect(workflow.calls).toHaveLength(0);
  });
});

describe("POST /v1/webhooks/signals/:source — dedup", () => {
  it("duplicate delivery id → one Workflow.create", async () => {
    const { env, workflow, idempotencyKv } = fixture({ withKv: true });
    expect(idempotencyKv).toBeDefined();
    const payload = { title: "flap", body: "same alert twice" };

    const res1 = await handleRequest(
      signalsRequest("vendor-a", payload, { deliveryId: "delivery-1" }),
      env,
    );
    expect(res1.status).toBe(202);
    const res2 = await handleRequest(
      signalsRequest("vendor-a", payload, { deliveryId: "delivery-1" }),
      env,
    );
    expect(res2.status).toBe(202);

    expect(workflow.calls).toHaveLength(1);
    const id1 = ((await (
      await handleRequest(
        signalsRequest("vendor-a", payload, { deliveryId: "delivery-1" }),
        env,
      )
    ).json()) as { executionId: string }).executionId;
    expect(id1).toBe("signals:vendor-a:delivery-1");
  });

  it("distinct alerts (no delivery header) → two Workflow.creates", async () => {
    const { env, workflow } = fixture({ withKv: true });
    await handleRequest(
      signalsRequest("vendor-a", { title: "alert one", body: "a" }),
      env,
    );
    await handleRequest(
      signalsRequest("vendor-a", { title: "alert two", body: "b" }),
      env,
    );
    expect(workflow.calls).toHaveLength(2);
    expect(workflow.calls[0]!.id).not.toBe(workflow.calls[1]!.id);
  });

  it("same body, no delivery header → deduped via SHA-256", async () => {
    const { env, workflow } = fixture({ withKv: true });
    const payload = { title: "identical", body: "byte-for-byte" };
    await handleRequest(signalsRequest("vendor-a", payload), env);
    await handleRequest(signalsRequest("vendor-a", payload), env);
    expect(workflow.calls).toHaveLength(1);
  });
});
