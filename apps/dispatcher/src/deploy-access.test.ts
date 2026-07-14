// Deploy-console identity normalization — pure tests (no network).

import { describe, expect, it } from "vitest";
import { githubLoginFromIdentity, normalizeIdentity } from "./deploy-access";

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
    expect(normalizeIdentity({})).toEqual({
      email: "",
      idp: "",
      login: "",
      groups: [],
    });
  });

  it("ignores empty/non-string group leaves", () => {
    const id = normalizeIdentity({
      groups: [{ name: "", id: undefined, email: "team@x" }],
    });
    expect(id.groups).toEqual(["team@x"]);
  });

  it("carries the extracted GitHub login", () => {
    expect(normalizeIdentity({ login: "octocat" }).login).toBe("octocat");
  });
});

describe("githubLoginFromIdentity", () => {
  it("prefers an explicit login field", () => {
    expect(githubLoginFromIdentity({ login: "octocat", name: "The Octocat" })).toBe(
      "octocat",
    );
  });

  it("falls back through nickname / preferred_username", () => {
    expect(githubLoginFromIdentity({ nickname: "octo-cat" })).toBe("octo-cat");
    expect(githubLoginFromIdentity({ preferred_username: "octo9" })).toBe("octo9");
  });

  it("reads nested oidc_fields / custom", () => {
    expect(githubLoginFromIdentity({ oidc_fields: { login: "nested1" } })).toBe("nested1");
    expect(githubLoginFromIdentity({ custom: { login: "nested2" } })).toBe("nested2");
  });

  it("accepts `name` only when it looks like a GitHub login", () => {
    expect(githubLoginFromIdentity({ name: "octocat" })).toBe("octocat");
    // A display name is NOT a login — spaces are invalid in GitHub usernames.
    expect(githubLoginFromIdentity({ name: "The Octocat" })).toBe("");
  });

  it("returns empty when nothing usable is present", () => {
    expect(githubLoginFromIdentity({ email: "a@b.com" })).toBe("");
  });
});
