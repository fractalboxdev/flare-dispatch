// GitHub team-membership helpers — pure tests (no network).

import { describe, expect, it } from "vitest";
import { splitTeam } from "./github-teams";

describe("splitTeam", () => {
  it("splits an org/team entry", () => {
    expect(splitTeam("fractalboxdev/devs")).toEqual({
      org: "fractalboxdev",
      slug: "devs",
    });
  });

  it("rejects entries that aren't org/team", () => {
    expect(splitTeam("devs")).toBeNull();
    expect(splitTeam("/devs")).toBeNull();
    expect(splitTeam("org/")).toBeNull();
    expect(splitTeam("")).toBeNull();
  });
});
