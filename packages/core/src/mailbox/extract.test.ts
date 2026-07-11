// Unit tests for the pure OTP-code + magic-link extractor.
//
// Fixtures are trimmed-but-realistic Auth0 / Clerk / Stytch style plain-text
// bodies — the exact chrome (copyright year, "expires in N minutes", footer
// links, logo image) that the naive `\b\d{4,8}\b` mis-fired on.

import { describe, expect, it } from "vitest";
import { extractCode, extractLink, extractOtp } from "./extract";

describe("extractCode", () => {
  it("pulls a 6-digit OTP out of the subject line", () => {
    const msg = {
      subject: "482915 is your verification code",
      text: "Enter the code above to finish signing in. It expires in 10 minutes.",
    };
    expect(extractCode(msg)).toBe("482915");
  });

  it("pulls an OTP from the body when keyword-anchored", () => {
    const msg = {
      subject: "Verify your email",
      text:
        "Hi,\n\nYour one-time passcode is 730164.\n\n" +
        "If you didn't request this, you can ignore this email.\n",
    };
    expect(extractCode(msg)).toBe("730164");
  });

  it("ignores the copyright year and the expiry-minutes number (the false-positive case)", () => {
    // The body name-drops 2026 (footer) and 15 (expiry) AND a 3-digit order id;
    // the only real code is 559213. The naive matcher returned 2026.
    const msg = {
      subject: "Your login code",
      text:
        "Use code 559213 to sign in.\n" +
        "This code expires in 15 minutes.\n\n" +
        "Need help? Reference ticket 482.\n" +
        "© 2026 Acme, Inc. All rights reserved.\n",
    };
    const code = extractCode(msg);
    expect(code).toBe("559213");
    expect(code).not.toBe("2026");
    expect(code).not.toBe("15");
  });

  it("does not pluck a code out of the middle of a phone number", () => {
    const msg = {
      subject: "Security alert",
      text:
        "We noticed a new sign-in. Your verification code is 204815.\n" +
        "Questions? Call us at +1 (415) 555-019283.\n",
    };
    expect(extractCode(msg)).toBe("204815");
  });

  it("honours an exact codeWidth", () => {
    const msg = {
      subject: "Confirm it's you",
      text: "Your security code is 90213847. Do not share it.",
    };
    expect(extractCode(msg, { codeWidth: 8 })).toBe("90213847");
  });

  it("supports an alphanumeric codePattern override (subject then text)", () => {
    const msg = {
      subject: "Your activation code",
      text: "Confirm with code WXYZ-4821 to activate your workspace.",
    };
    expect(
      extractCode(msg, { codePattern: /code\s+([A-Z]{4}-\d{4})/ }),
    ).toBe("WXYZ-4821");
  });

  it("returns undefined when no code qualifies", () => {
    const msg = {
      subject: "Welcome to Acme",
      text: "Thanks for joining! Visit your dashboard to get started.\n© 2026 Acme.",
    };
    expect(extractCode(msg)).toBeUndefined();
  });
});

describe("extractLink", () => {
  it("picks the verification link over an unsubscribe link and a logo image", () => {
    const text =
      "Click to confirm your email:\n\n" +
      "https://auth.acme.com/u/verify?ticket=AbC123XyZ&state=hQ9\n\n" +
      "[logo] https://cdn.acme.com/assets/logo.png\n" +
      "Don't want these? https://email.acme.com/unsubscribe?u=42&id=99\n";
    expect(extractLink(text)).toBe(
      "https://auth.acme.com/u/verify?ticket=AbC123XyZ&state=hQ9",
    );
  });

  it("prefers a URL on the requested linkHost (incl. subdomains)", () => {
    const text =
      "Magic link: https://links.tracker.io/click?to=https%3A%2F%2Fx\n" +
      "Real link: https://login.myapp.com/magic?token=eyJabc.def.ghi\n";
    expect(extractLink(text, { linkHost: "myapp.com" })).toBe(
      "https://login.myapp.com/magic?token=eyJabc.def.ghi",
    );
  });

  it("falls back to the longest-token URL when none reads like a verify link", () => {
    const text =
      "Visit https://acme.com\n" +
      "Or open https://acme.com/r/9f8a7b6c5d4e3f2a1b0c?ref=email-12345\n";
    expect(extractLink(text)).toBe(
      "https://acme.com/r/9f8a7b6c5d4e3f2a1b0c?ref=email-12345",
    );
  });

  it("returns undefined when linkHost is asked for but nothing matches", () => {
    const text = "Open https://other.example.com/verify?t=1 to continue.";
    expect(extractLink(text, { linkHost: "myapp.com" })).toBeUndefined();
  });

  it("returns undefined when there is no usable link", () => {
    const text = "Your code is 123456. No links here, just unsubscribe footers.";
    expect(extractLink(text)).toBeUndefined();
  });
});

describe("extractOtp", () => {
  it("returns the code for a numeric OTP email (no link)", () => {
    const msg = {
      subject: "Your Clerk verification code",
      text:
        "482915 is your verification code.\n\n" +
        "This code expires in 10 minutes. © 2026 Clerk.\n",
    };
    expect(extractOtp(msg)).toEqual({ code: "482915" });
  });

  it("returns the link for a magic-link email (no code), picking the real link", () => {
    const msg = {
      subject: "Sign in to Acme",
      text:
        "Click below to sign in:\n\n" +
        "https://acme.us.auth0.com/passwordless/verify?ticket=Q1w2E3r4&tenant=acme\n\n" +
        "Acme logo: https://cdn.acme.com/logo.svg\n" +
        "Unsubscribe: https://mailer.acme.com/o/unsub?id=7\n" +
        "© 2026 Acme, Inc.\n",
    };
    expect(extractOtp(msg, { linkHost: "auth0.com" })).toEqual({
      link: "https://acme.us.auth0.com/passwordless/verify?ticket=Q1w2E3r4&tenant=acme",
    });
  });

  it("returns both code and link when an email carries both", () => {
    const msg = {
      subject: "Your security code",
      text:
        "Your one-time code is 661204.\n" +
        "Prefer a link? Open https://login.myapp.com/magic?token=eyJ.aGk.x to sign in.\n" +
        "This expires in 15 minutes. © 2026 MyApp.\n",
    };
    expect(extractOtp(msg, { linkHost: "myapp.com" })).toEqual({
      code: "661204",
      link: "https://login.myapp.com/magic?token=eyJ.aGk.x",
    });
  });

  it("returns {} when neither a code nor a link is present", () => {
    const msg = {
      subject: "Welcome aboard",
      text: "Thanks for signing up. We're excited to have you! © 2026 Acme.",
    };
    expect(extractOtp(msg)).toEqual({});
  });
});
