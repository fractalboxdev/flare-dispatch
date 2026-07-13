// Unit coverage for `previewSafeSandboxId` — the normaliser that keeps
// container preview-URL DNS labels valid (see preview-sandbox-id.ts header).

import { describe, expect, it } from "vitest";
import { previewSafeSandboxId } from "./preview-sandbox-id";

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

describe("previewSafeSandboxId", () => {
  it("lowercases uppercase org names (the numu cdp-acceptance regression)", () => {
    // The exact id shape that made `expose-app` throw `ExposePortFailed`.
    const out = previewSafeSandboxId(
      "cdp-acceptance:Numu-AI_numu-monorepo:6758041bc1ee",
    );
    expect(out).toMatch(DNS_LABEL);
    expect(out).not.toMatch(/[A-Z]/);
    // The unique sha suffix survives so executions stay distinct.
    expect(out.endsWith("6758041bc1ee")).toBe(true);
  });

  it("replaces `:` and `_` separators with `-`", () => {
    expect(previewSafeSandboxId("run:owner_repo:abc123")).toBe(
      "run-owner-repo-abc123",
    );
  });

  it("keeps the preview-URL label within the 63-char DNS limit", () => {
    // Worst case: 5-digit port + id + 16-char token + 2 hyphens ≤ 63.
    const id = previewSafeSandboxId(
      "cdp-acceptance:SomeVeryLongOrgName_an-even-longer-monorepo-name:6758041bc1ee",
    );
    expect(id.length).toBeLessThanOrEqual(40);
    const label = `65535-${id}-0123456789abcdef`;
    expect(label.length).toBeLessThanOrEqual(63);
  });

  it("never starts or ends with a hyphen after truncation", () => {
    const id = previewSafeSandboxId(`${"x".repeat(60)}-:_:`);
    expect(id.startsWith("-")).toBe(false);
    expect(id.endsWith("-")).toBe(false);
  });

  it("is idempotent on already-clean ids", () => {
    const clean = "cdp-acceptance-owner-repo-6758041bc1ee";
    expect(previewSafeSandboxId(clean)).toBe(clean);
  });

  it("falls back to a stable handle for all-separator input", () => {
    expect(previewSafeSandboxId(":::___")).toBe("sandbox");
  });
});
