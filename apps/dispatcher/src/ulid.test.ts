// ULID generator unit tests — shape, sortability, uniqueness.

import { describe, expect, it } from "vitest";
import { ulid } from "./ulid";

describe("ulid", () => {
  it("produces a 26-char Crockford-base32 string", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is lexically sortable by seed time", () => {
    const earlier = ulid(1_000_000_000_000);
    const later = ulid(2_000_000_000_000);
    expect(earlier < later).toBe(true);
  });

  it("is unique across many calls at the same instant", () => {
    const t = 1_700_000_000_000;
    const ids = new Set(Array.from({ length: 1000 }, () => ulid(t)));
    expect(ids.size).toBe(1000);
  });
});
