import { describe, expect, it } from "vitest";
import { isRetryableGatewayError } from "./model.js";

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
