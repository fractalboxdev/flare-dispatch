import { describe, expect, it } from "vitest";
import { isRetryableGatewayError, toolCallToAction } from "./model.js";

describe("isRetryableGatewayError", () => {
  it("retries the Cloudflare AI Gateway 429 rate-limit", () => {
    // The exact shape generateText throws on a gateway 429.
    const e = new Error(
      'HTTP 429: {"error":{"type":"rate_limit_error","message":"Type 2b rate limited. Please try again"}}',
    );
    expect(isRetryableGatewayError(e)).toBe(true);
  });

  it("retries 5xx and request timeouts", () => {
    expect(isRetryableGatewayError(new Error("HTTP 503: upstream down"))).toBe(true);
    expect(
      isRetryableGatewayError(new Error("chat/completions request timed out after 120s")),
    ).toBe(true);
  });

  it("does NOT retry real client errors (4xx other than 429, decode failures)", () => {
    expect(isRetryableGatewayError(new Error("HTTP 400: bad request"))).toBe(false);
    expect(isRetryableGatewayError(new Error("HTTP 401: unauthorized"))).toBe(false);
    expect(isRetryableGatewayError(new Error("failed to decode response"))).toBe(false);
  });

  it("does not false-positive on an unrelated number containing 429", () => {
    expect(isRetryableGatewayError(new Error("processed 14290 tokens"))).toBe(false);
  });
});

describe("toolCallToAction", () => {
  it("maps every live tool to its action", () => {
    expect(toolCallToAction({ name: "click", params: { target: "Home" } })).toEqual({
      type: "click",
      target: "Home",
    });
    expect(
      toolCallToAction({
        name: "click",
        params: { target: "Home", rationale: "the nav link" },
      }),
    ).toEqual({ type: "click", target: "Home", rationale: "the nav link" });
    expect(
      toolCallToAction({ name: "type", params: { target: "#q", text: "hello" } }),
    ).toEqual({ type: "type", target: "#q", text: "hello" });
    expect(
      toolCallToAction({ name: "nav", params: { url: "https://example.test/" } }),
    ).toEqual({ type: "nav", url: "https://example.test/" });
    expect(toolCallToAction({ name: "key", params: { key: "Enter" } })).toEqual({
      type: "key",
      key: "Enter",
    });
    expect(toolCallToAction({ name: "wait", params: { ms: 500 } })).toEqual({
      type: "wait",
      ms: 500,
    });
    expect(
      toolCallToAction({
        name: "done",
        params: { narrative: "walked the flow", status: "passed" },
      }),
    ).toEqual({ type: "done", narrative: "walked the flow", status: "passed" });
  });

  it("degrades the removed `screenshot` tool to a no-op, never a failed chapter", () => {
    // Consumer story prose still says "capture a screenshot", and a cached
    // prompt can still name the tool. Before the shim, orElse mapped it to
    // done/failed and sank the whole chapter.
    const action = toolCallToAction({ name: "screenshot", params: {} });
    expect(action).toEqual({ type: "wait", ms: 0 });
    expect(action).not.toHaveProperty("status", "failed");
  });

  it("still fails loudly on a genuinely unknown tool", () => {
    expect(toolCallToAction({ name: "teleport", params: {} })).toEqual({
      type: "done",
      narrative: "model called unknown tool teleport",
      status: "failed",
    });
  });
});
