import { describe, expect, it } from "vitest";
import type { NativeReadBinding } from "@fractalboxdev/flare-dispatch-core";
import { nativeReadMessage } from "@fractalboxdev/flare-dispatch-core";
import { makeCapabilityToken } from "./capability-token";
import { signNativeResultToken, verifyNativeResultToken } from "./native-result-token";

const now = 1_700_000_000;
const binding: NativeReadBinding = {
  version: 1, repo: "owner/project", head: "a".repeat(40), base: "b".repeat(40),
  nonce: "native-test-00001", target: "x86_64-pc-windows-msvc",
  command_sha256: "c".repeat(64), executor_ref: "d".repeat(40), expires_at: now + 60,
};

describe("native result reader capability", () => {
  it("authenticates the complete identity through a Bearer header", async () => {
    const header = await signNativeResultToken("fixture-key", binding);
    expect(header).toMatch(/^Bearer [A-Za-z0-9_-]{22}$/);
    expect(await verifyNativeResultToken("fixture-key", binding, header, now)).toBe(true);
    for (const changed of [
      { repo: "owner/other" }, { head: "e".repeat(40) }, { base: "e".repeat(40) },
      { nonce: "native-other" }, { target: "aarch64-pc-windows-msvc" },
      { command_sha256: "e".repeat(64) }, { executor_ref: "e".repeat(40) },
      { expires_at: now + 61 },
    ]) {
      expect(await verifyNativeResultToken("fixture-key", { ...binding, ...changed }, header, now)).toBe(false);
    }
    expect(await verifyNativeResultToken("different-key", binding, header, now)).toBe(false);
  });

  it("refuses expiry, malformed identity, missing or non-header credentials", async () => {
    const header = await signNativeResultToken("fixture-key", binding);
    expect(await verifyNativeResultToken("fixture-key", binding, header, binding.expires_at)).toBe(false);
    expect(await verifyNativeResultToken("fixture-key", binding, header, Number.NaN)).toBe(false);
    expect(await verifyNativeResultToken("fixture-key", { ...binding, expires_at: Infinity }, header, now)).toBe(false);
    expect(await verifyNativeResultToken("fixture-key", { ...binding, head: "moving-ref" }, header, now)).toBe(false);
    for (const malformed of [null, undefined, "", header.slice(7), `${header} trailing`, header.toLowerCase()]) {
      expect(await verifyNativeResultToken("fixture-key", binding, malformed, now)).toBe(false);
    }
  });

  it("separates native readers from existing capability domains", async () => {
    const header = await signNativeResultToken("fixture-key", binding);
    const other = await makeCapabilityToken("flare-dispatch/log-link/v1").sign("fixture-key", JSON.stringify(binding));
    expect(header).not.toBe(`Bearer ${other}`);
  });

  it("refuses an unconfigured reader signing secret", async () => {
    const forged = await makeCapabilityToken("flare-dispatch/native-result-reader/v1")
      .sign("", nativeReadMessage(binding));
    expect(await verifyNativeResultToken("", binding, `Bearer ${forged}`, now)).toBe(false);
    await expect(signNativeResultToken("", binding)).rejects.toMatchObject({
      _tag: "NativeReceiptRefused",
    });
  });
});
