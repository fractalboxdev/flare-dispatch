// Unit tests for `toInstanceId` — the CF Workflows instance-id sanitizer.

import { describe, expect, it } from "vitest";
import { toInstanceId } from "./instance-id";

/** Cloudflare Workflows instance id contract: `[A-Za-z0-9_-]`, max 64 chars. */
const isValidInstanceId = (id: string): boolean =>
  id.length > 0 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id);

describe("toInstanceId", () => {
  it("passes a short, already-valid key through unchanged", () => {
    expect(toInstanceId("pr-review_owner_repo_abcdef")).toBe(
      "pr-review_owner_repo_abcdef",
    );
  });

  it("replaces `:` and `/` (the webhook idempotency-key separators)", () => {
    const id = toInstanceId("pr-review:owner/repo:42:abcdef0123");
    expect(id).toBe("pr-review_owner_repo_42_abcdef0123");
    expect(isValidInstanceId(id)).toBe(true);
  });

  it("produces a valid id for the real webhook key shape (owner/repo:pr:40-sha)", () => {
    const raw = `pr-review:owner/repo:2144:${"a".repeat(40)}`;
    const id = toInstanceId(raw);
    expect(isValidInstanceId(id)).toBe(true);
    expect(id).not.toContain(":");
    expect(id).not.toContain("/");
  });

  it("caps over-long keys at 64 chars with a deterministic suffix", () => {
    const raw = `pr-review:some-org/some-very-long-repo-name:998877:${"f".repeat(40)}`;
    expect(raw.replace(/[^A-Za-z0-9_-]/g, "_").length).toBeGreaterThan(64);
    const id = toInstanceId(raw);
    expect(id.length).toBe(64);
    expect(isValidInstanceId(id)).toBe(true);
  });

  it("is deterministic — same key maps to the same id (dedup contract)", () => {
    const raw = `pr-review:owner/repo:7:${"c".repeat(40)}`;
    expect(toInstanceId(raw)).toBe(toInstanceId(raw));
  });

  it("keeps distinct over-long keys distinct when only the tail differs", () => {
    // Same repo + pr, different head sha — the differing bytes are beyond the
    // 64-char truncation, so only the hashed suffix separates them. (Repo name
    // chosen long enough that the sanitized key exceeds 64 chars.)
    const base = "pr-review:some-org/some-very-long-repo-name:5:";
    const a = toInstanceId(`${base}${"a".repeat(40)}`);
    const b = toInstanceId(`${base}${"b".repeat(40)}`);
    expect(a).not.toBe(b);
    expect(isValidInstanceId(a)).toBe(true);
    expect(isValidInstanceId(b)).toBe(true);
  });
});
