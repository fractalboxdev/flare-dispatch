// Unit tests for the release-PR approval resolver (pure).

import { describe, expect, it } from "vitest";
import {
  APPROVE_LABEL,
  REJECT_LABEL,
  resolveReleaseApproval,
} from "./release-approval";

const MARKER =
  "<!-- flare-dispatch:release-approval wf=release-notes-2026-W26 tag=v0.1.0 -->";

/** A bot-authored release PR payload with the marker in the body. */
const prPayload = (over: Record<string, unknown> = {}) => ({
  action: "closed",
  sender: { login: "maintainer" },
  pull_request: {
    body: `Release v0.1.0\n\n${MARKER}`,
    merged: true,
    user: { type: "Bot" },
  },
  ...over,
});

describe("resolveReleaseApproval", () => {
  it("merged PR → approve, carrying wfId/tag/decider", () => {
    const r = resolveReleaseApproval("pull_request", prPayload());
    expect(r).toEqual({
      wfId: "release-notes-2026-W26",
      tag: "v0.1.0",
      decision: "approve",
      decider: "maintainer",
    });
  });

  it("closed-unmerged PR → reject", () => {
    const r = resolveReleaseApproval(
      "pull_request",
      prPayload({ pull_request: { body: MARKER, merged: false, user: { type: "Bot" } } }),
    );
    expect(r?.decision).toBe("reject");
  });

  it("release:approve label → approve", () => {
    const r = resolveReleaseApproval(
      "pull_request",
      prPayload({ action: "labeled", label: { name: APPROVE_LABEL } }),
    );
    expect(r?.decision).toBe("approve");
  });

  it("release:reject label → reject", () => {
    const r = resolveReleaseApproval(
      "pull_request",
      prPayload({ action: "labeled", label: { name: REJECT_LABEL } }),
    );
    expect(r?.decision).toBe("reject");
  });

  it("an unrelated label is ignored", () => {
    const r = resolveReleaseApproval(
      "pull_request",
      prPayload({ action: "labeled", label: { name: "bug" } }),
    );
    expect(r).toBeUndefined();
  });

  it("ignores a PR not authored by the App (defense in depth)", () => {
    const r = resolveReleaseApproval(
      "pull_request",
      prPayload({ pull_request: { body: MARKER, merged: true, user: { type: "User" } } }),
    );
    expect(r).toBeUndefined();
  });

  it("ignores a bot PR without the marker", () => {
    const r = resolveReleaseApproval(
      "pull_request",
      prPayload({ pull_request: { body: "just a PR", merged: true, user: { type: "Bot" } } }),
    );
    expect(r).toBeUndefined();
  });

  it("ignores non-pull_request events", () => {
    expect(resolveReleaseApproval("push", prPayload())).toBeUndefined();
    expect(resolveReleaseApproval(null, prPayload())).toBeUndefined();
  });

  it("falls back to 'unknown' decider when sender is absent", () => {
    const r = resolveReleaseApproval(
      "pull_request",
      prPayload({ sender: undefined }),
    );
    expect(r?.decider).toBe("unknown");
  });
});
