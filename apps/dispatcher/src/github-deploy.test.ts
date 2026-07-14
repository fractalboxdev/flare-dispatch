// GitHub deploy-metadata helpers — pure formatting tests (no network).

import { describe, expect, it } from "vitest";
import { commitLabel, shortRef } from "./github-deploy";

describe("shortRef", () => {
  it("strips refs/heads and refs/tags prefixes", () => {
    expect(shortRef("refs/heads/main")).toBe("main");
    expect(shortRef("refs/tags/v1.2.3")).toBe("v1.2.3");
  });
  it("passes a bare name through", () => {
    expect(shortRef("alpha")).toBe("alpha");
  });
});

describe("commitLabel", () => {
  it("formats `<sha7> · <subject>`", () => {
    expect(commitLabel("abc1234def567", "fix the thing")).toBe("abc1234 · fix the thing");
  });
  it("uses only the first line of the message", () => {
    expect(commitLabel("abc1234def567", "subject\n\nbody text")).toBe("abc1234 · subject");
  });
  it("truncates a long subject", () => {
    const label = commitLabel("abc1234def567", "x".repeat(100));
    expect(label.length).toBeLessThan(75);
    expect(label.endsWith("…")).toBe(true);
  });
  it("falls back to the short sha when the subject is empty", () => {
    expect(commitLabel("abc1234def567", "")).toBe("abc1234");
  });
});
