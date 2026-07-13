// FlareDispatch Dispatcher — log-token capability token tests.

import { describe, expect, it } from "vitest";
import {
  buildLogsUrl,
  EXECUTION_ID_RE,
  isValidExecutionId,
  resolveLogLinkSecret,
  signLogToken,
  verifyLogToken,
} from "./log-token";
import type { Env } from "./env";

const EXEC = "offload-test:owner_repo:abc123def456";

describe("log-token", () => {
  it("signs and verifies a token bound to the execution id", async () => {
    const token = await signLogToken("secret-a", EXEC);
    expect(token).toHaveLength(22);
    expect(await verifyLogToken("secret-a", EXEC, token)).toBe(true);
  });

  it("rejects a token for a different execution id", async () => {
    const token = await signLogToken("secret-a", EXEC);
    expect(await verifyLogToken("secret-a", "other:id:x", token)).toBe(false);
  });

  it("rejects a token minted under a different secret", async () => {
    const token = await signLogToken("secret-a", EXEC);
    expect(await verifyLogToken("secret-b", EXEC, token)).toBe(false);
  });

  it("rejects missing / malformed tokens", async () => {
    expect(await verifyLogToken("secret-a", EXEC, null)).toBe(false);
    expect(await verifyLogToken("secret-a", EXEC, "")).toBe(false);
    expect(await verifyLogToken("secret-a", EXEC, "short")).toBe(false);
  });

  it("is domain-separated — the same input keying material differs by label", async () => {
    // A raw HMAC of the id under the same secret must not equal the token (the
    // token derives a separate key via HKDF). We assert non-equality with a
    // crude raw-HMAC to catch an accidental "just HMAC the id" regression.
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode("secret-a"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const raw = await crypto.subtle.sign("HMAC", key, enc.encode(EXEC) as BufferSource);
    const rawB64 = btoa(String.fromCharCode(...new Uint8Array(raw)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
      .slice(0, 22);
    expect(await signLogToken("secret-a", EXEC)).not.toBe(rawB64);
  });

  it("validates execution-id shape", () => {
    expect(isValidExecutionId(EXEC)).toBe(true);
    expect(isValidExecutionId("01HABCDEF0123456789KLMNOPQ")).toBe(true);
    expect(EXECUTION_ID_RE.test("a/b")).toBe(false); // no path segments
    expect(EXECUTION_ID_RE.test("a b")).toBe(false); // no spaces
    expect(EXECUTION_ID_RE.test("ab")).toBe(false); // too short
    expect(EXECUTION_ID_RE.test("a)b")).toBe(false); // no markdown-breaking
  });

  it("resolves key material: LOG_LINK_SECRET, then HMAC_SECRET, else undefined", () => {
    expect(
      resolveLogLinkSecret({ LOG_LINK_SECRET: "dedicated", HMAC_SECRET: "h" } as Env),
    ).toBe("dedicated");
    expect(resolveLogLinkSecret({ HMAC_SECRET: "h" } as Env)).toBe("h");
    expect(resolveLogLinkSecret({ HMAC_SECRET: "" } as unknown as Env)).toBe(
      undefined,
    );
  });

  it("builds tokened viewer URLs, encoding the id and fragment", () => {
    expect(buildLogsUrl("https://x.dev", EXEC, "TOK")).toBe(
      `https://x.dev/logs/${encodeURIComponent(EXEC)}?t=TOK`,
    );
    expect(buildLogsUrl("https://x.dev/", EXEC, "TOK", "exec-2.ndjson")).toBe(
      `https://x.dev/logs/${encodeURIComponent(EXEC)}?t=TOK#exec-2.ndjson`,
    );
  });
});
