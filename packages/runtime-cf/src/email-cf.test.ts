// Tests for the live Cloudflare `email` capability Layer.

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Email } from "@fractalboxdev/flare-dispatch-core";
import { makeEmailCloudflareLive, type SendEmailBinding } from "./email-cf";

type Sent = {
  from: string | { name: string; email: string };
  to: string | string[];
  subject: string;
};

/** A fake `send_email` binding that records calls and can fail per-recipient. */
const makeFakeBinding = (
  failFor: readonly string[] = [],
): { binding: SendEmailBinding; sent: Sent[] } => {
  const sent: Sent[] = [];
  let n = 0;
  const binding: SendEmailBinding = {
    send: (builder) => {
      const to = builder.to;
      if (typeof to === "string" && failFor.includes(to)) {
        return Promise.reject(new Error(`unverified destination: ${to}`));
      }
      sent.push({ from: builder.from, to, subject: builder.subject });
      n += 1;
      return Promise.resolve({ messageId: `msg-${n}` });
    },
  };
  return { binding, sent };
};

const run = <A>(eff: Effect.Effect<A, never, Email>, layer: Layer.Layer<Email>) =>
  Effect.runPromise(eff.pipe(Effect.provide(layer)));

const req = (to: readonly string[]) => ({
  to,
  subject: "subject",
  html: "<p>hi</p>",
  text: "hi",
});

describe("makeEmailCloudflareLive", () => {
  it("sends one message per recipient and accepts all", async () => {
    const { binding, sent } = makeFakeBinding();
    const layer = makeEmailCloudflareLive({
      sendEmail: binding,
      fromAddress: "fd@zone.test",
      fromName: "FlareDispatch",
    });

    const result = await run(
      Effect.flatMap(Email, (s) => s.send(req(["a@x.test", "b@y.test"]))),
      layer,
    );

    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.to)).toEqual(["a@x.test", "b@y.test"]);
    expect(sent[0]!.from).toEqual({
      name: "FlareDispatch",
      email: "fd@zone.test",
    });
    expect(result.accepted).toEqual(["a@x.test", "b@y.test"]);
    expect(result.rejected).toEqual([]);
    expect(result.skipped).toBe(false);
    expect(result.messageId).toBe("msg-1");
  });

  it("rejects only the failing recipient, accepts the rest", async () => {
    const { binding, sent } = makeFakeBinding(["bad@x.test"]);
    const layer = makeEmailCloudflareLive({
      sendEmail: binding,
      fromAddress: "fd@zone.test",
    });

    const result = await run(
      Effect.flatMap(Email, (s) => s.send(req(["ok@x.test", "bad@x.test"]))),
      layer,
    );

    expect(result.accepted).toEqual(["ok@x.test"]);
    expect(result.rejected.map((r) => r.address)).toEqual(["bad@x.test"]);
    expect(sent).toHaveLength(1);
  });

  it("filters recipients not on the allowlist before sending", async () => {
    const { binding, sent } = makeFakeBinding();
    const layer = makeEmailCloudflareLive({
      sendEmail: binding,
      fromAddress: "fd@zone.test",
      allowedRecipients: ["allowed@x.test"],
    });

    const result = await run(
      Effect.flatMap(Email, (s) => s.send(req(["allowed@x.test", "blocked@x.test"]))),
      layer,
    );

    expect(sent.map((s) => s.to)).toEqual(["allowed@x.test"]);
    expect(result.accepted).toEqual(["allowed@x.test"]);
    expect(result.rejected.map((r) => r.address)).toEqual(["blocked@x.test"]);
  });

  it("no-ops (skipped) when unconfigured", async () => {
    const layer = makeEmailCloudflareLive(undefined);
    const result = await run(
      Effect.flatMap(Email, (s) => s.send(req(["a@x.test"]))),
      layer,
    );
    expect(result.skipped).toBe(true);
    expect(result.accepted).toEqual([]);
  });
});
