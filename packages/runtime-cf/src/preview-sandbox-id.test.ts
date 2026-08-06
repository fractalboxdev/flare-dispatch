// Unit coverage for `previewSafeSandboxId` — the normaliser that keeps
// container preview-URL DNS labels valid (see preview-sandbox-id.ts header).

import { describe, expect, it } from "vitest";
import { previewSafeSandboxId } from "./preview-sandbox-id";

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

describe("previewSafeSandboxId", () => {
  it("lowercases uppercase org names (the numu cdp-acceptance regression)", () => {
    // The exact id shape that made `expose-app` throw `ExposePortFailed`.
    const out = previewSafeSandboxId("cdp-acceptance:Numu-AI_numu-monorepo:6758041bc1ee");
    expect(out).toMatch(DNS_LABEL);
    expect(out).not.toMatch(/[A-Z]/);
    // The sha stays readable so a container id can still be traced to a commit;
    // uniqueness itself is the digest's job (see the fan-out case below).
    expect(out).toContain("6758041bc1ee");
  });

  // The defect this normaliser used to have: truncation kept the TAIL, and the
  // ONLY thing distinguishing one run's execution id from its siblings' is the
  // `<run>` PREFIX — every run in a push's fan-out carries the same repo + sha.
  // Every run therefore routed to one container, and `workspace()`'s opening
  // `rm -rf <dir>` let a sibling's checkout delete a live run's tree mid-exec.
  it("keeps the fan-out of one commit on distinct containers", () => {
    const sha = "5b4f655bc6a6";
    const ids = ["offload-test", "oxlint", "check", "pr-review", "worker-deploy"].map((run) =>
      previewSafeSandboxId(`${run}_fractalboxdev_flare-dispatch_${sha}`),
    );

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(DNS_LABEL);
      expect(id.length).toBeLessThanOrEqual(40);
    }
  });

  // The id is re-derived from the execution id in EVERY Worker invocation of a
  // run — each durable step is its own invocation, and they must all reach the
  // same Durable Object. A digest that varied per call would hand a resumed
  // step a fresh, empty container.
  it("is deterministic across calls", () => {
    const executionId = "offload-test_fractalboxdev_flare-dispatch_5b4f655bc6a6";
    expect(previewSafeSandboxId(executionId)).toBe(previewSafeSandboxId(executionId));
  });

  it("distinguishes ids that differ only past the truncation point", () => {
    // Same run, same owner/repo, different commit — and long enough that the
    // readable head is identical for both.
    const a = previewSafeSandboxId("playwright-e2e_someverylongorgname_the-monorepo_aaaaaaaaaaaa");
    const b = previewSafeSandboxId("playwright-e2e_someverylongorgname_the-monorepo_bbbbbbbbbbbb");
    expect(a).not.toBe(b);
  });

  it("replaces `:` and `_` separators with `-`", () => {
    expect(previewSafeSandboxId("run:owner_repo:abc123")).toBe("run-owner-repo-abc123");
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
