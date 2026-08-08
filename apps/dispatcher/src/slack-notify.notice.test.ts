// The notice — the un-originated half of slack-notify.ts, and the one a cron
// run can reach.
//
// Two properties are load-bearing here, and neither is checkable from the
// verdict tests:
//
//   1. THE PAYLOAD CANNOT NAME A DESTINATION. The receiver's whole abuse
//      surface is a signed body that could say `C…`, so "there is no channel
//      field" has to be an assertion, not a habit.
//   2. THE SIGNATURE AGREES WITH A RECEIVER IN ANOTHER REPO. fractalbot
//      deploys separately and shares no package with this one. `the receiver's
//      own verification` below carries its `deriveNotifyKey`,
//      `verifyNotifySignature` and `parseNotice` VERBATIM, so a change on
//      either side that breaks agreement fails here — instead of in production,
//      as a 401 with nothing to say why. fractalbot's PR #27 carries the mirror
//      of this test, pointing the other way.

import { describe, expect, it } from "vitest";
import { deriveSecret } from "./capability-token";
import { verify } from "./hmac";
import {
  deliverSlackNotice,
  emitSlackNotice,
  readSlackNoticeUrl,
  readSlackNotifyUrl,
  renderSlackNotice,
  SLACK_NOTICE_URL_KEY,
  SLACK_NOTIFY_HKDF_INFO,
  type SlackNoticeEmission,
  validateSlackNotice,
} from "./slack-notify";
import { makeFakeKv } from "./test-helpers";

const SECRET = "slack-notify-test-secret-32-byte";
const NOW = 1_754_640_000_000;

const emission = (over: Partial<SlackNoticeEmission> = {}): SlackNoticeEmission => ({
  useCase: "org-spec-audit",
  deliveryId: "org-spec-audit:2026-08-08",
  text: "Spec audit — 3 open questions",
  run: "org-spec-audit",
  executionId: "01JZ9F3ATBQ2W7X8Y0KDPM4RVH",
  ...over,
});

/** Capture what a delivery actually puts on the wire. */
const capture = () => {
  const seen: { url: string; body: Uint8Array; signature: string }[] = [];
  const respond = { status: 200 };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      body: new Uint8Array(init.body as ArrayBuffer),
      signature: new Headers(init.headers).get("X-FlareDispatch-Signature") ?? "",
    });
    return new Response("{}", { status: respond.status });
  }) as unknown as typeof fetch;
  return { seen, respond, fetchImpl };
};

describe("renderSlackNotice", () => {
  it("names a use case and has nowhere to name a destination", () => {
    const payload = renderSlackNotice(emission(), NOW);

    expect(payload.useCase).toBe("org-spec-audit");
    expect(payload.version).toBe(1);
    // A `channel` key added here later fails this line — which is the point.
    // The receiver refuses to read one, but the field never existing is what
    // keeps a leaked signing key from being worth a workspace.
    expect(Object.keys(payload).sort()).toEqual(
      ["deliveryId", "executionId", "run", "sentAt", "text", "useCase", "version"].sort(),
    );
  });

  it("takes the clock as an argument, so `sentAt` is stamped at signing time", () => {
    expect(renderSlackNotice(emission(), NOW).sentAt).toBe(NOW);
    expect(renderSlackNotice(emission(), NOW + 5).sentAt).toBe(NOW + 5);
  });

  it("carries links as typed entries, and omits the field when there are none", () => {
    expect(renderSlackNotice(emission(), NOW).links).toBeUndefined();
    expect(renderSlackNotice(emission({ links: [] }), NOW).links).toBeUndefined();
    expect(
      renderSlackNotice(
        emission({ links: [{ url: "https://gh.test/pr/9", label: "the questions PR" }] }),
        NOW,
      ).links,
    ).toEqual([{ url: "https://gh.test/pr/9", label: "the questions PR" }]);
  });

  it("passes hostile text through untouched — escaping is the receiver's job", () => {
    // Escaping here would be escaping in the one place that cannot know what is
    // safe: `text` is model-authored. The receiver escapes `&<>` wholesale,
    // which needs the raw characters to still be there when it arrives.
    const text = "<!channel> see <https://evil.test|here>";
    expect(renderSlackNotice(emission({ text }), NOW).text).toBe(text);
  });
});

describe("validateSlackNotice", () => {
  const payload = (over: Partial<SlackNoticeEmission> = {}) =>
    renderSlackNotice(emission(over), NOW);

  it("accepts what a run actually sends", () => {
    expect(validateSlackNotice(payload())).toBeUndefined();
    expect(
      validateSlackNotice(payload({ links: [{ url: "https://gh.test/pr/9", label: "PR" }] })),
    ).toBeUndefined();
  });

  it("refuses a use case shaped like a channel id", () => {
    expect(validateSlackNotice(payload({ useCase: "C0SECRET000" }))).toContain("useCase");
  });

  it("refuses a delivery id outside the receiver's charset", () => {
    expect(validateSlackNotice(payload({ deliveryId: "day 2026/08/08" }))).toContain("deliveryId");
  });

  it("refuses an empty or over-long body rather than truncating it", () => {
    expect(validateSlackNotice(payload({ text: "   " }))).toContain("empty");
    expect(validateSlackNotice(payload({ text: "x".repeat(12_001) }))).toContain("12000");
  });

  it("refuses a link that could break out of the span the receiver renders", () => {
    expect(
      validateSlackNotice(payload({ links: [{ url: "http://gh.test", label: "PR" }] })),
    ).toContain("https://");
    expect(
      validateSlackNotice(payload({ links: [{ url: "https://gh.test|x>y", label: "PR" }] })),
    ).toContain("must not contain");
    expect(
      validateSlackNotice(payload({ links: [{ url: "https://gh.test", label: "" }] })),
    ).toContain("label");
    expect(
      validateSlackNotice(
        payload({
          links: Array.from({ length: 5 }, () => ({ url: "https://gh.test", label: "PR" })),
        }),
      ),
    ).toContain("cap is 4");
  });
});

describe("deliverSlackNotice", () => {
  it("signs the exact bytes it POSTs, under the same domain-separated key", async () => {
    const { seen, fetchImpl } = capture();
    const payload = renderSlackNotice(emission(), NOW);

    const result = await deliverSlackNotice({
      url: "https://bot.test/flare-dispatch/notify",
      secret: SECRET,
      payload,
      fetchImpl,
    });

    expect(result).toEqual({ outcome: "posted", status: 200 });
    expect(seen[0]!.url).toBe("https://bot.test/flare-dispatch/notify");
    expect(JSON.parse(new TextDecoder().decode(seen[0]!.body))).toEqual(payload);

    const derived = await deriveSecret(SECRET, SLACK_NOTIFY_HKDF_INFO);
    expect(await verify(derived, seen[0]!.signature, seen[0]!.body)).toBe(true);
    // Same label as the verdict callback — one shared secret to keep in sync
    // with the receiver, and still useless as a dispatch signature.
    expect(await verify(SECRET, seen[0]!.signature, seen[0]!.body)).toBe(false);
  });

  it("reads 409 as delivered-already, not as a failure", async () => {
    // The receiver claims the delivery id before it posts, so 409 means the
    // message is in the room. A retried Workflow step re-sends identical bytes
    // and must not look broken for behaving correctly.
    const { respond, fetchImpl } = capture();
    respond.status = 409;

    expect(
      await deliverSlackNotice({
        url: "https://bot.test/flare-dispatch/notify",
        secret: SECRET,
        payload: renderSlackNotice(emission(), NOW),
        fetchImpl,
      }),
    ).toEqual({ outcome: "duplicate" });
  });

  it("reports a refusal or a transport failure rather than throwing", async () => {
    const { respond, fetchImpl } = capture();
    respond.status = 403;
    expect(
      await deliverSlackNotice({
        url: "https://bot.test/flare-dispatch/notify",
        secret: SECRET,
        payload: renderSlackNotice(emission(), NOW),
        fetchImpl,
      }),
    ).toEqual({ outcome: "failed", reason: "notice ingress answered 403" });

    const dead = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    expect(
      await deliverSlackNotice({
        url: "https://bot.test/flare-dispatch/notify",
        secret: SECRET,
        payload: renderSlackNotice(emission(), NOW),
        fetchImpl: dead,
      }),
    ).toEqual({ outcome: "failed", reason: "connection reset" });
  });

  it("refuses a malformed payload without spending a request on it", async () => {
    const { seen, fetchImpl } = capture();

    const result = await deliverSlackNotice({
      url: "https://bot.test/flare-dispatch/notify",
      secret: SECRET,
      payload: renderSlackNotice(emission({ text: "" }), NOW),
      fetchImpl,
    });

    expect(result.outcome).toBe("failed");
    expect(seen).toHaveLength(0);
  });
});

describe("the receiver's own verification", () => {
  // Copied verbatim from fractalbot `src/flare-notify.ts`. Spelled out rather
  // than imported — the two repos share no package, and writing it twice is
  // precisely what makes a divergence on either side a red test.
  const enc = new TextEncoder();
  const hex = (bytes: ArrayBuffer) =>
    Array.from(new Uint8Array(bytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  const deriveNotifyKey = async (ikm: string): Promise<string> => {
    const base = await crypto.subtle.importKey("raw", enc.encode(ikm), "HKDF", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        // The label as the RECEIVER spells it, not as our constant does.
        info: enc.encode("flare-dispatch/slack-notify/v1"),
      },
      base,
      256,
    );
    return hex(bits);
  };

  const hexToBytes = (value: string): Uint8Array | null => {
    if (value.length === 0 || value.length % 2 !== 0) return null;
    const out = new Uint8Array(value.length / 2);
    for (let i = 0; i < out.length; i++) {
      const byte = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(byte)) return null;
      out[i] = byte;
    }
    return out;
  };

  const verifyNotifySignature = async (
    key: string,
    header: string | null | undefined,
    body: Uint8Array,
  ): Promise<boolean> => {
    if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
    const presented = hexToBytes(header.slice("sha256=".length));
    if (presented === null || presented.length !== 32) return false;
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      // The derived key as a HEX STRING, UTF-8 encoded — 64 ASCII bytes, not
      // the 32 they encode. A receiver importing the raw bytes would reject
      // every honest request, and nothing but this assertion would say so.
      enc.encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify("HMAC", cryptoKey, presented as BufferSource, body as BufferSource);
  };

  /** The receiver's `parseNotice` bounds, reduced to a boolean. */
  const parses = (b: Record<string, unknown>): boolean => {
    const USE_CASE = /^[a-z0-9][a-z0-9-]{0,63}$/;
    const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    const RUN_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
    if (b.version !== 1) return false;
    if (typeof b.useCase !== "string" || !USE_CASE.test(b.useCase)) return false;
    if (typeof b.deliveryId !== "string" || !DELIVERY_ID.test(b.deliveryId)) return false;
    if (typeof b.sentAt !== "number" || !Number.isFinite(b.sentAt)) return false;
    if (typeof b.text !== "string" || b.text.trim().length === 0) return false;
    if (b.text.length > 12_000) return false;
    if (b.run !== undefined && (typeof b.run !== "string" || !RUN_NAME.test(b.run))) return false;
    if (
      b.executionId !== undefined &&
      (typeof b.executionId !== "string" || !DELIVERY_ID.test(b.executionId))
    ) {
      return false;
    }
    if (b.links !== undefined) {
      if (!Array.isArray(b.links) || b.links.length > 4) return false;
      for (const raw of b.links) {
        const { url, label } = raw as { url?: unknown; label?: unknown };
        if (typeof url !== "string" || typeof label !== "string") return false;
        if (url.length === 0 || url.length > 512) return false;
        if (label.length === 0 || label.length > 80) return false;
        if (!url.startsWith("https://")) return false;
        // oxlint-disable-next-line no-control-regex -- verbatim from the receiver
        if (/[<>|\s]|[\u0000-\u001f]/.test(url)) return false;
      }
    }
    return true;
  };

  it("accepts the header and the body this dispatcher actually emits", async () => {
    const { seen, fetchImpl } = capture();
    await deliverSlackNotice({
      url: "https://bot.test/flare-dispatch/notify",
      secret: SECRET,
      payload: renderSlackNotice(
        emission({ links: [{ url: "https://gh.test/pr/9", label: "the questions PR" }] }),
        NOW,
      ),
      fetchImpl,
    });

    const sent = seen[0]!;
    expect(
      await verifyNotifySignature(await deriveNotifyKey(SECRET), sent.signature, sent.body),
    ).toBe(true);
    expect(parses(JSON.parse(new TextDecoder().decode(sent.body)))).toBe(true);
  });

  it("rejects those bytes under any other secret, or after any edit", async () => {
    const { seen, fetchImpl } = capture();
    await deliverSlackNotice({
      url: "https://bot.test/flare-dispatch/notify",
      secret: SECRET,
      payload: renderSlackNotice(emission(), NOW),
      fetchImpl,
    });
    const sent = seen[0]!;

    expect(
      await verifyNotifySignature(
        await deriveNotifyKey("another-secret"),
        sent.signature,
        sent.body,
      ),
    ).toBe(false);
    // The MAC covers the raw bytes: re-pointing the use case invalidates it
    // even though the result is still valid JSON of a valid shape.
    const tampered = enc.encode(
      JSON.stringify(renderSlackNotice(emission({ useCase: "release-notes" }), NOW)),
    );
    expect(
      await verifyNotifySignature(await deriveNotifyKey(SECRET), sent.signature, tampered),
    ).toBe(false);
  });

  it("derives byte for byte the key this repo's `deriveSecret` produces", async () => {
    const theirs = await deriveNotifyKey(SECRET);
    const ours = await deriveSecret(SECRET, SLACK_NOTIFY_HKDF_INFO);
    expect(theirs).toMatch(/^[0-9a-f]{64}$/);
    expect(theirs).toBe(ours);
    // Domain separation: the derived key is not the secret, so a notice
    // signature is not a dispatch signature.
    expect(theirs).not.toBe(SECRET);
  });
});

describe("emitSlackNotice", () => {
  const envWith = (kvEntries: Record<string, string>, over: Record<string, unknown> = {}) => {
    const kv = makeFakeKv();
    for (const [k, v] of Object.entries(kvEntries)) kv.store.set(k, v);
    return { CONFIG_KV: kv.binding, HMAC_SECRET: SECRET, ...over } as never;
  };

  it("resolves its own CONFIG_KV key, never the verdict callback's", async () => {
    const { seen, fetchImpl } = capture();
    const env = envWith({
      [SLACK_NOTICE_URL_KEY]: "https://bot.test/flare-dispatch/notify",
      "slack-origin.notify-url": "https://bot.test/verdict",
    });

    expect(await emitSlackNotice(env, emission(), { now: () => NOW, fetchImpl })).toEqual({
      outcome: "posted",
      status: 200,
    });
    expect(seen[0]!.url).toBe("https://bot.test/flare-dispatch/notify");
    expect(await readSlackNoticeUrl(env)).toBe("https://bot.test/flare-dispatch/notify");
    expect(await readSlackNotifyUrl(env)).toBe("https://bot.test/verdict");
  });

  it("stays silent on a deploy that has only the verdict URL", async () => {
    // Different endpoint, different payload. Inheriting the verdict URL would
    // announce onto a route that cannot read a notice — and would tie the
    // announcement path's blast radius to the in-thread one an operator may
    // have very different feelings about.
    const { seen, fetchImpl } = capture();
    const env = envWith({ "slack-origin.notify-url": "https://bot.test/verdict" });

    expect(await emitSlackNotice(env, emission(), { now: () => NOW, fetchImpl })).toMatchObject({
      outcome: "skipped",
    });
    expect(seen).toHaveLength(0);
  });

  it("skips — never sends unsigned — when the deploy has no key", async () => {
    const { seen, fetchImpl } = capture();
    const env = envWith(
      { [SLACK_NOTICE_URL_KEY]: "https://bot.test/flare-dispatch/notify" },
      { HMAC_SECRET: "" },
    );

    expect(await emitSlackNotice(env, emission(), { now: () => NOW, fetchImpl })).toMatchObject({
      outcome: "skipped",
      reason: expect.stringContaining("signing key"),
    });
    expect(seen).toHaveLength(0);
  });

  it("stamps `sentAt` at signing time, inside the bytes it signs", async () => {
    const { seen, fetchImpl } = capture();
    const env = envWith({ [SLACK_NOTICE_URL_KEY]: "https://bot.test/flare-dispatch/notify" });

    await emitSlackNotice(env, emission(), { now: () => NOW + 1234, fetchImpl });

    const sent = seen[0]!;
    expect(JSON.parse(new TextDecoder().decode(sent.body)).sentAt).toBe(NOW + 1234);
    expect(
      await verify(await deriveSecret(SECRET, SLACK_NOTIFY_HKDF_INFO), sent.signature, sent.body),
    ).toBe(true);
  });
});
