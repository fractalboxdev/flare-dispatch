// Unit tests for the `email-otp-login` run — the full provision → start →
// waitForOtp → verify loop, driven OFFLINE against the in-memory CF test
// runtime. The disposable inbox is the `MailboxFake`; the verification email is
// injected into the inline runner's event queue (standing in for the real
// `email()` handler's `sendEvent`); the auth API's `curl` calls are canned on
// the sandbox fake. No CF, no network, no live Email Routing — exactly the
// offline gate the design's §10.4 calls for.

import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import {
  enqueueInlineEvent,
  type InlineEventQueue,
  makeCFRuntimeTest,
} from "@fractalbox/flare-dispatch-core/testing";
import { emailOtpLogin, fillTemplate } from "./email-otp-login";

/** A fully-decoded run input with the schema defaults, overridable per test. */
const mkInput = (over: Partial<Parameters<typeof emailOtpLogin.run>[0]> = {}) => ({
  baseURL: "https://app.example.com",
  startPath: "/api/auth/otp/start",
  startBody: `{"email":"{{email}}"}`,
  verifyPath: "/api/auth/otp/verify",
  verifyBody: `{"email":"{{email}}","code":"{{code}}"}`,
  provider: "generic" as const,
  expectStatus: 200,
  waitSeconds: 120,
  ...over,
});

/** Seed the inbox event the `email()` handler would otherwise `sendEvent`. */
const inboxEvent = (over: Partial<Record<string, unknown>> = {}): InlineEventQueue => {
  const q: InlineEventQueue = new Map();
  enqueueInlineEvent(q, "mailbox-message", {
    id: "msg-1",
    localPart: "demo-0123456789abcdef0123456789abcd",
    recipient: "demo-0123456789abcdef0123456789abcd@inbox.test",
    sender: "no-reply@auth.example.com",
    subject: "Your verification code",
    text: "Your one-time code is 482913. It expires in 10 minutes.\n© 2026 Example.",
    receivedAt: 1_700_000_000_000,
    ...over,
  });
  return q;
};

describe("email-otp-login run", () => {
  it.effect("provisions a user and logs in via an OTP code", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "otp/start": { exitCode: 0, stdout: "200" },
        "otp/verify": { exitCode: 0, stdout: "200" },
      },
      eventQueue: inboxEvent(),
    });

    return Effect.gen(function* () {
      const out = yield* emailOtpLogin.run(mkInput());

      expect(out.loggedIn).toBe(true);
      expect(out.mode).toBe("code");
      expect(out.status).toBe(200);
      // A fresh address was provisioned (the MailboxFake mints demo-…@inbox.test).
      expect(out.provisionedAddress).toMatch(/^demo-[a-z0-9]+@inbox\.test$/);
      expect(handles.mailbox.allocated).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("logs in via a magic link when the email has no code", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: {
        "otp/start": { exitCode: 0, stdout: "200" },
        "magic?token": { exitCode: 0, stdout: "200" },
      },
      eventQueue: inboxEvent({
        subject: "Sign in to Example",
        text: "Click https://app.example.com/auth/magic?token=abcdefxyz to sign in.",
      }),
    });

    return Effect.gen(function* () {
      const out = yield* emailOtpLogin.run(
        mkInput({ linkHost: "app.example.com" }),
      );
      expect(out.loggedIn).toBe(true);
      expect(out.mode).toBe("link");
    }).pipe(Effect.provide(layer));
  });

  it.effect("is a logged no-op when baseURL is unset", () => {
    const { layer, handles } = makeCFRuntimeTest();
    return Effect.gen(function* () {
      const out = yield* emailOtpLogin.run(mkInput({ baseURL: "" }));
      expect(out.mode).toBe("skipped");
      expect(out.loggedIn).toBe(false);
      expect(out.provisionedAddress).toBe("");
      // No inbox is provisioned on the skip path.
      expect(handles.mailbox.allocated).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails red when the verify call rejects the code", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: {
        "otp/start": { exitCode: 0, stdout: "200" },
        "otp/verify": { exitCode: 0, stdout: "401" },
      },
      eventQueue: inboxEvent(),
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(emailOtpLogin.run(mkInput()));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("times out (red) when no verification email arrives", () => {
    // Empty event queue → the inline waitForEvent fails ApprovalTimedOut at once.
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: { "otp/start": { exitCode: 0, stdout: "200" } },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(emailOtpLogin.run(mkInput()));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

describe("fillTemplate", () => {
  it("substitutes email + code placeholders", () => {
    expect(
      fillTemplate(`{"email":"{{email}}","code":"{{code}}"}`, {
        email: "a@b.c",
        code: "123456",
      }),
    ).toBe(`{"email":"a@b.c","code":"123456"}`);
  });
  it("leaves unknown placeholders empty", () => {
    expect(fillTemplate("{{email}}/{{nope}}", { email: "x" })).toBe("x/");
  });
});
