// The verdict callback — the in-thread half of the finalize boundary.
//
// The load-bearing property is the signature: the receiver must be able to
// verify a callback with the same primitive it already uses to sign
// dispatches, and a callback signature must be useless as a dispatch
// signature. Both are asserted here against the real `verify`.
//
// The other half of this module — the un-originated notice a cron run reaches,
// and its cross-repo signature parity — is in slack-notify.notice.test.ts.

import { describe, expect, it } from "vitest";
import { deriveSecret } from "./capability-token";
import { verify } from "./hmac";
import {
  deliverSlackVerdict,
  readSlackNotifyUrl,
  renderSlackVerdict,
  resolveSlackNotifySecret,
  SLACK_NOTIFY_HKDF_INFO,
} from "./slack-notify";
import type { SlackOrigin } from "./slack-origin";
import { makeFakeKv } from "./test-helpers";

const SECRET = "slack-notify-test-secret-32-byte";

const ORIGIN: SlackOrigin = {
  kind: "slack",
  team_id: "T0BHHNG3FNJ",
  channel: "C0BHXAMJLA1",
  thread_ts: "1712345678.123456",
};

const base = {
  executionId: "spec-drift-pr:fractalbox_pinned-repo:0123456789ab",
  run: "spec-drift-pr",
  repo: "fractalbox/pinned-repo",
  sha: "0123456789abcdef0123456789abcdef01234567",
  origin: ORIGIN,
};

describe("renderSlackVerdict", () => {
  it("carries the thread back verbatim so the receiver knows where to post", () => {
    const payload = renderSlackVerdict({ ...base, status: "success" });

    expect(payload.origin).toEqual(ORIGIN);
    expect(payload.version).toBe(1);
  });

  it("renders a postable one-liner for each terminal status", () => {
    expect(renderSlackVerdict({ ...base, status: "success" }).text).toBe(
      "✓ `spec-drift-pr` succeeded on `fractalbox/pinned-repo`@`0123456`",
    );
    expect(renderSlackVerdict({ ...base, status: "failure" }).text).toContain("✗");
    expect(
      renderSlackVerdict({ ...base, status: "skipped", skipReason: "diff too large" }).text,
    ).toContain("diff too large");
  });

  it("links the readable log viewer, not the operator-only dashboard", () => {
    const payload = renderSlackVerdict({
      ...base,
      status: "failure",
      logsUrl: "https://dispatcher.test/logs/abc?t=xyz",
      detailsUrl: "https://dash.cloudflare.com/acct/workers/workflows/runs/abc",
    });

    expect(payload.text).toContain("https://dispatcher.test/logs/abc?t=xyz");
    expect(payload.text).not.toContain("dash.cloudflare.com");
    // Still carried as a field — an operator reading the JSON wants it.
    expect(payload.detailsUrl).toContain("dash.cloudflare.com");
  });

  it("carries the failure summary only on the failure branch", () => {
    expect(
      renderSlackVerdict({ ...base, status: "failure", failureSummary: "3 of 5 specs failed" })
        .failureSummary,
    ).toBe("3 of 5 specs failed");
    expect(
      renderSlackVerdict({ ...base, status: "success", failureSummary: "stale" }).failureSummary,
    ).toBeUndefined();
  });
});

describe("deliverSlackVerdict", () => {
  it("signs the exact bytes it POSTs, under the domain-separated key", async () => {
    let seen: { url: string; body: Uint8Array; signature: string } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seen = {
        url,
        body: new Uint8Array(init.body as ArrayBuffer),
        signature: headers.get("X-FlareDispatch-Signature") ?? "",
      };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const payload = renderSlackVerdict({ ...base, status: "success" });
    const result = await deliverSlackVerdict({
      url: "https://ingress.test/flare-dispatch/verdict",
      secret: SECRET,
      payload,
      fetchImpl,
    });

    expect(result).toEqual({ delivered: true, status: 200 });
    if (seen === undefined) throw new Error("callback was never issued");
    expect(seen.url).toBe("https://ingress.test/flare-dispatch/verdict");
    expect(JSON.parse(new TextDecoder().decode(seen.body))).toEqual(payload);

    // The receiver verifies with the SAME primitive, over the same raw bytes,
    // under the key it derives from its copy of the shared secret.
    const derived = await deriveSecret(SECRET, SLACK_NOTIFY_HKDF_INFO);
    expect(await verify(derived, seen.signature, seen.body)).toBe(true);
  });

  it("does not sign with the raw dispatch secret — the labels keep them apart", async () => {
    let seen: { body: Uint8Array; signature: string } | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = {
        body: new Uint8Array(init.body as ArrayBuffer),
        signature: new Headers(init.headers).get("X-FlareDispatch-Signature") ?? "",
      };
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;

    await deliverSlackVerdict({
      url: "https://ingress.test/verdict",
      secret: SECRET,
      payload: renderSlackVerdict({ ...base, status: "failure" }),
      fetchImpl,
    });

    if (seen === undefined) throw new Error("callback was never issued");
    expect(await verify(SECRET, seen.signature, seen.body)).toBe(false);
  });

  it("reports a non-2xx rather than throwing into the finalize path", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const result = await deliverSlackVerdict({
      url: "https://ingress.test/verdict",
      secret: SECRET,
      payload: renderSlackVerdict({ ...base, status: "success" }),
      fetchImpl,
    });

    expect(result).toEqual({ delivered: false, reason: "callback answered 500" });
  });

  it("reports a transport failure rather than throwing into the finalize path", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;

    const result = await deliverSlackVerdict({
      url: "https://ingress.test/verdict",
      secret: SECRET,
      payload: renderSlackVerdict({ ...base, status: "success" }),
      fetchImpl,
    });

    expect(result).toEqual({ delivered: false, reason: "connection reset" });
  });
});

describe("callback configuration", () => {
  it("prefers CONFIG_KV over the var so a redeploy is not needed to re-point", async () => {
    const kv = makeFakeKv();
    kv.store.set("slack-origin.notify-url", "https://kv.test/verdict");
    const env = {
      CONFIG_KV: kv.binding,
      SLACK_NOTIFY_URL: "https://var.test/verdict",
    } as never;

    expect(await readSlackNotifyUrl(env)).toBe("https://kv.test/verdict");
  });

  it("falls back to the var, then to nothing at all", async () => {
    expect(await readSlackNotifyUrl({ SLACK_NOTIFY_URL: "https://var.test/v" } as never)).toBe(
      "https://var.test/v",
    );
    expect(await readSlackNotifyUrl({} as never)).toBeUndefined();
  });

  it("derives the signing key from HMAC_SECRET when no dedicated one is set", () => {
    expect(resolveSlackNotifySecret({ HMAC_SECRET: SECRET } as never)).toBe(SECRET);
    expect(
      resolveSlackNotifySecret({ HMAC_SECRET: SECRET, SLACK_NOTIFY_SECRET: "dedicated" } as never),
    ).toBe("dedicated");
    expect(resolveSlackNotifySecret({} as never)).toBeUndefined();
  });
});
