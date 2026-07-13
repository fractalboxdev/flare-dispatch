// Deploy-console identity normalization — pure tests (no network).

import { describe, expect, it } from "vitest";
import { normalizeIdentity } from "./deploy-access";

describe("normalizeIdentity", () => {
  it("reads email + idp.type and flattens group identifiers", () => {
    const id = normalizeIdentity({
      email: "dev@example.com",
      idp: { type: "github", id: "abc" },
      groups: [
        { id: "81954718", name: "fractalboxdev/devs", email: "" },
        { name: "friends" },
      ],
    });
    expect(id.email).toBe("dev@example.com");
    expect(id.idp).toBe("github");
    expect(id.groups).toContain("fractalboxdev/devs");
    expect(id.groups).toContain("friends");
    expect(id.groups).toContain("81954718");
  });

  it("accepts a bare-string idp", () => {
    expect(normalizeIdentity({ email: "a@b.com", idp: "onetimepin" }).idp).toBe(
      "onetimepin",
    );
  });

  it("degrades missing fields to empty, never throws", () => {
    const id = normalizeIdentity({});
    expect(id).toEqual({ email: "", idp: "", groups: [] });
  });

  it("ignores empty/non-string group leaves", () => {
    const id = normalizeIdentity({
      groups: [{ name: "", id: undefined, email: "team@x" }],
    });
    expect(id.groups).toEqual(["team@x"]);
  });
});
