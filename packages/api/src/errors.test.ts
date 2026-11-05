import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ApiErrors, apiError, CODES, errorBody, Forbidden, statusOf } from "./errors.ts";

describe("error model", () => {
  it("FD-IFC-009: every code has one status, and each status is a row of the table", () => {
    const all = Object.values(CODES).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(statusOf("link_revoked")).toBe(403);
    expect(statusOf("rate_limited")).toBe(429);
    expect(statusOf("storage_bound")).toBe(507);
  });

  it("FD-IFC-009: the wire form is { error, message, request_id } and decodes back to the class", () => {
    const wire = ApiErrors[3];
    const encoded = Schema.encodeSync(wire)(
      new Forbidden({ error: "forbidden", message: "no", request_id: "r1" }),
    );
    expect(encoded).toEqual({ error: "forbidden", message: "no", request_id: "r1" });
    const decoded = Schema.decodeUnknownSync(wire)(encoded);
    expect(decoded).toBeInstanceOf(Forbidden);
    expect(decoded._tag).toBe("Forbidden");
  });

  it("FD-IFC-009: the body carries the request id and keeps retry_after out", () => {
    const body = errorBody(apiError("rate_limited", "slow down", { retry_after: 30 }), "r2");
    expect(body).toEqual({ error: "rate_limited", message: "slow down", request_id: "r2" });
  });
});
