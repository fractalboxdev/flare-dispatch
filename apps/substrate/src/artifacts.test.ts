// Here rather than beside the code because `pnpm test` never runs the Workers
// pool. The workers suite drives the real SDK call.
import { describe, expect, it } from "vitest";
import { artifactsPrefix } from "./artifacts";

describe("the artifacts mount prefix", () => {
  it("is absolute, which is the rule validatePrefix enforces", () => {
    expect(artifactsPrefix("abc123").startsWith("/")).toBe(true);
  });

  it("scopes to the container id, so two executions cannot read each other", () => {
    expect(artifactsPrefix("abc123")).toBe("/artifacts/abc123/");
    expect(artifactsPrefix("def456")).not.toBe(artifactsPrefix("abc123"));
  });

  it("ends in a slash, so keys land under the prefix and not beside it", () => {
    expect(artifactsPrefix("abc123").endsWith("/")).toBe(true);
  });
});
