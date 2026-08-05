// Deploy-console identity normalization — pure tests (no network).

import { describe, expect, it } from "vitest";
import {
  githubLoginFromIdentity,
  githubTeamsFromIdentity,
  normalizeIdentity,
} from "./deploy-access";

/**
 * A real Cloudflare Access get-identity payload for a GitHub-IdP session
 * (trimmed). The shape that matters: `groups` is ABSENT, and team membership
 * lives in sibling `orgs`/`teams` arrays joined on the org id.
 */
const GITHUB_IDENTITY = {
  name: "debuggingfuture (Vincent)",
  email: "dev@example.com",
  idp: { id: "f462ff4f", type: "github" },
  orgs: [
    { id: 6076175, name: "code4hk" },
    { id: 81954718, name: "fractalboxdev" },
  ],
  teams: [
    { name: "Timetable4HK", org_id: 6076175 },
    { name: "friends", org_id: 81954718 },
    { name: "devs", org_id: 81954718 },
  ],
};

describe("normalizeIdentity", () => {
  it("reads email + idp.type and flattens group identifiers", () => {
    const id = normalizeIdentity({
      email: "dev@example.com",
      idp: { type: "github", id: "abc" },
      groups: [{ id: "81954718", name: "fractalboxdev/devs", email: "" }, { name: "friends" }],
    });
    expect(id.email).toBe("dev@example.com");
    expect(id.idp).toBe("github");
    expect(id.groups).toContain("fractalboxdev/devs");
    expect(id.groups).toContain("friends");
    expect(id.groups).toContain("81954718");
  });

  it("accepts a bare-string idp", () => {
    expect(normalizeIdentity({ email: "a@b.com", idp: "onetimepin" }).idp).toBe("onetimepin");
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

  it("folds the GitHub orgs/teams join into groups", () => {
    const id = normalizeIdentity(GITHUB_IDENTITY);
    expect(id.idp).toBe("github");
    expect(id.groups).toContain("fractalboxdev/devs");
    // A display name is not a login — nothing in this payload carries one.
    expect(id.login).toBe("");
  });
});

describe("githubTeamsFromIdentity", () => {
  it("joins teams to their org and emits sorted org/team slugs", () => {
    expect(githubTeamsFromIdentity(GITHUB_IDENTITY)).toEqual([
      "code4hk/timetable4hk",
      "fractalboxdev/devs",
      "fractalboxdev/friends",
    ]);
  });

  it("slugifies display names the way GitHub does", () => {
    expect(
      githubTeamsFromIdentity({
        orgs: [{ id: 1, name: "Acme Corp" }],
        teams: [{ name: "Site Reliability!", org_id: 1 }],
      }),
    ).toEqual(["acme-corp/site-reliability"]);
  });

  it("prefers an explicit slug over the display name", () => {
    expect(
      githubTeamsFromIdentity({
        orgs: [{ id: 1, name: "acme" }],
        teams: [{ name: "Site Reliability", slug: "sre", org_id: 1 }],
      }),
    ).toEqual(["acme/sre"]);
  });

  it("drops teams whose org isn't in orgs[] rather than guessing", () => {
    expect(
      githubTeamsFromIdentity({
        orgs: [{ id: 1, name: "acme" }],
        teams: [{ name: "ghost", org_id: 999 }],
      }),
    ).toEqual([]);
  });

  it("returns empty for an identity with no orgs/teams (e.g. an OTP session)", () => {
    expect(githubTeamsFromIdentity({ email: "a@b.com", idp: "onetimepin" })).toEqual([]);
  });

  it("survives a mistyped payload rather than throwing", () => {
    const malformed = { orgs: "nope", teams: 3 } as unknown as Parameters<
      typeof githubTeamsFromIdentity
    >[0];
    expect(githubTeamsFromIdentity(malformed)).toEqual([]);
  });
});

describe("githubLoginFromIdentity", () => {
  it("prefers an explicit login field", () => {
    expect(githubLoginFromIdentity({ login: "octocat", name: "The Octocat" })).toBe("octocat");
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
