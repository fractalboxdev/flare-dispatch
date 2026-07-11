// FlareDispatch Dispatcher — expiring mailbox-token capability token tests.

import { describe, expect, it } from "vitest";
import {
  buildMailboxUrl,
  resolveMailboxLinkSecret,
  signMailboxToken,
  verifyMailboxToken,
} from "./mailbox-token";
import type { Env } from "./env";

const LOCAL = "otp-acme-7f3a";
// A fixed "now" and a window an hour out, so the clock checks are deterministic.
const NOW = 1_700_000_000;
const EXP = NOW + 3600;

describe("mailbox-token", () => {
  it("signs and verifies a token bound to local-part + expiry", async () => {
    const tok = await signMailboxToken("secret-a", LOCAL, EXP);
    expect(tok).toHaveLength(22);
    expect(await verifyMailboxToken("secret-a", LOCAL, EXP, tok, NOW)).toBe(
      true,
    );
  });

  it("rejects an expired token even when the MAC matches", async () => {
    const tok = await signMailboxToken("secret-a", LOCAL, EXP);
    // The MAC is over (LOCAL, EXP) and is correct — but the clock is past EXP.
    expect(await verifyMailboxToken("secret-a", LOCAL, EXP, tok, EXP + 1)).toBe(
      false,
    );
    // Exactly at the deadline is still valid (nowS > expEpochS is the cutoff).
    expect(await verifyMailboxToken("secret-a", LOCAL, EXP, tok, EXP)).toBe(
      true,
    );
  });

  it("rejects a non-finite expiry before touching the MAC", async () => {
    const tok = await signMailboxToken("secret-a", LOCAL, EXP);
    expect(
      await verifyMailboxToken("secret-a", LOCAL, Number.NaN, tok, NOW),
    ).toBe(false);
    expect(
      await verifyMailboxToken("secret-a", LOCAL, Number.POSITIVE_INFINITY, tok, NOW),
    ).toBe(false);
  });

  it("rejects a token for a different local-part", async () => {
    const tok = await signMailboxToken("secret-a", LOCAL, EXP);
    expect(
      await verifyMailboxToken("secret-a", "otp-other-0000", EXP, tok, NOW),
    ).toBe(false);
  });

  it("rejects a token verified against a different expiry (expiry is signed)", async () => {
    const tok = await signMailboxToken("secret-a", LOCAL, EXP);
    // Pushing the deadline out without re-signing must fail — the MAC covers exp.
    expect(
      await verifyMailboxToken("secret-a", LOCAL, EXP + 1, tok, NOW),
    ).toBe(false);
  });

  it("rejects a token minted under a different secret", async () => {
    const tok = await signMailboxToken("secret-a", LOCAL, EXP);
    expect(await verifyMailboxToken("secret-b", LOCAL, EXP, tok, NOW)).toBe(
      false,
    );
  });

  it("rejects tampered / missing / malformed tokens", async () => {
    const tok = await signMailboxToken("secret-a", LOCAL, EXP);
    const tampered = `${tok.slice(0, -1)}${tok.endsWith("A") ? "B" : "A"}`;
    expect(await verifyMailboxToken("secret-a", LOCAL, EXP, tampered, NOW)).toBe(
      false,
    );
    expect(await verifyMailboxToken("secret-a", LOCAL, EXP, null, NOW)).toBe(
      false,
    );
    expect(await verifyMailboxToken("secret-a", LOCAL, EXP, undefined, NOW)).toBe(
      false,
    );
    expect(await verifyMailboxToken("secret-a", LOCAL, EXP, "", NOW)).toBe(false);
    expect(await verifyMailboxToken("secret-a", LOCAL, EXP, "short", NOW)).toBe(
      false,
    );
  });

  it("is domain-separated from the log-link key (distinct HKDF label)", async () => {
    // Same secret + a colliding message shape must not produce the same token as
    // a raw HMAC, proving the HKDF key derivation (label-separated) is in play.
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode("secret-a"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const raw = await crypto.subtle.sign(
      "HMAC",
      key,
      enc.encode(`${LOCAL}|${EXP}`) as BufferSource,
    );
    const rawB64 = btoa(String.fromCharCode(...new Uint8Array(raw)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
      .slice(0, 22);
    expect(await signMailboxToken("secret-a", LOCAL, EXP)).not.toBe(rawB64);
  });

  it("resolves key material: MAILBOX_LINK_SECRET, then HMAC_SECRET, else undefined", () => {
    expect(
      resolveMailboxLinkSecret({
        MAILBOX_LINK_SECRET: "dedicated",
        HMAC_SECRET: "h",
      } as Env),
    ).toBe("dedicated");
    expect(resolveMailboxLinkSecret({ HMAC_SECRET: "h" } as Env)).toBe("h");
    // Empty strings count as unset → fall through.
    expect(
      resolveMailboxLinkSecret({
        MAILBOX_LINK_SECRET: "",
        HMAC_SECRET: "h",
      } as unknown as Env),
    ).toBe("h");
    expect(
      resolveMailboxLinkSecret({ HMAC_SECRET: "" } as unknown as Env),
    ).toBe(undefined);
  });

  it("builds tokened mailbox URLs, encoding the local-part and carrying exp", () => {
    expect(buildMailboxUrl("https://x.dev", LOCAL, EXP, "TOK")).toBe(
      `https://x.dev/v1/mailbox/${encodeURIComponent(LOCAL)}?exp=${EXP}&t=TOK`,
    );
    // Trailing slash on the origin is stripped.
    expect(buildMailboxUrl("https://x.dev/", LOCAL, EXP, "TOK")).toBe(
      `https://x.dev/v1/mailbox/${encodeURIComponent(LOCAL)}?exp=${EXP}&t=TOK`,
    );
  });
});
