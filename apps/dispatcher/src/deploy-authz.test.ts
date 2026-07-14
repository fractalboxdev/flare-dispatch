// Deploy-console authorization — pure policy unit tests.
//
// `allowedEnvs` is the security-critical core: it decides who may deploy which
// environment from the verified Cloudflare Access identity. These cases pin the
// two axes (GitHub team, email allowlist), the `requireGithubLogin` OTP guard,
// and the fail-closed parsing of the CONFIG_KV policy value.

import { describe, expect, it } from "vitest";
import {
  allowedEnvs,
  envRequiresApproval,
  isGithubLogin,
  parseEnvAuthzPolicy,
  type DeployIdentity,
  type EnvAuthzPolicy,
} from "./deploy-authz";

const gh = (over: Partial<DeployIdentity> = {}): DeployIdentity => ({
  email: "dev@example.com",
  idp: "github",
  login: "devuser",
  groups: ["fractalboxdev/devs"],
  ...over,
});

const otp = (over: Partial<DeployIdentity> = {}): DeployIdentity => ({
  email: "dev@example.com",
  idp: "onetimepin",
  login: "",
  groups: [],
  ...over,
});

const POLICY: EnvAuthzPolicy = {
  staging: { githubTeams: ["fractalboxdev/devs"] },
  production: { githubTeams: ["fractalboxdev/devs"], requireGithubLogin: true },
};

describe("allowedEnvs", () => {
  it("grants a GitHub devs member both environments", () => {
    expect(allowedEnvs(gh(), POLICY)).toEqual(["production", "staging"]);
  });

  it("matches a bare team slug against an `org/team` policy entry", () => {
    expect(allowedEnvs(gh({ groups: ["devs"] }), POLICY)).toEqual([
      "production",
      "staging",
    ]);
  });

  it("matches case-insensitively", () => {
    expect(allowedEnvs(gh({ groups: ["FractalBoxDev/Devs"] }), POLICY)).toContain(
      "staging",
    );
  });

  it("denies a GitHub identity not in the team", () => {
    expect(allowedEnvs(gh({ groups: ["fractalboxdev/friends"] }), POLICY)).toEqual([]);
  });

  it("denies an OTP identity every env when the rule needs a team", () => {
    // OTP carries no groups → no team match anywhere.
    expect(allowedEnvs(otp(), POLICY)).toEqual([]);
  });

  it("refuses production to an OTP session even when otherwise granted", () => {
    // An email-allowlisted OTP user gets staging but NOT production
    // (requireGithubLogin) — the core "OTP can't reach prod" guard.
    const policy: EnvAuthzPolicy = {
      staging: { emails: ["dev@example.com"] },
      production: { emails: ["dev@example.com"], requireGithubLogin: true },
    };
    expect(allowedEnvs(otp(), policy)).toEqual(["staging"]);
    expect(allowedEnvs(gh(), policy)).toEqual(["production", "staging"]);
  });

  it("honours anyAuthenticated but still gates requireGithubLogin", () => {
    const policy: EnvAuthzPolicy = {
      sandbox: { anyAuthenticated: true },
      production: { anyAuthenticated: true, requireGithubLogin: true },
    };
    expect(allowedEnvs(otp(), policy)).toEqual(["sandbox"]);
    expect(allowedEnvs(gh({ groups: [] }), policy)).toEqual(["production", "sandbox"]);
  });

  it("denies a rule with requireGithubLogin but no grant (fail-closed)", () => {
    expect(allowedEnvs(gh(), { prod: { requireGithubLogin: true } })).toEqual([]);
  });
});

describe("isGithubLogin", () => {
  it("recognises the github idp and rejects onetimepin", () => {
    expect(isGithubLogin(gh())).toBe(true);
    expect(isGithubLogin(otp())).toBe(false);
  });
});

describe("envRequiresApproval", () => {
  it("is true for a requireGithubLogin env, false otherwise", () => {
    expect(envRequiresApproval("production", POLICY)).toBe(true);
    expect(envRequiresApproval("staging", POLICY)).toBe(false);
    expect(envRequiresApproval("missing", POLICY)).toBe(false);
  });
});

describe("parseEnvAuthzPolicy", () => {
  it("parses a well-formed policy", () => {
    const raw = JSON.stringify(POLICY);
    expect(parseEnvAuthzPolicy(raw)).toEqual(POLICY);
  });

  it("fails closed on null / non-JSON / non-object", () => {
    expect(parseEnvAuthzPolicy(null)).toEqual({});
    expect(parseEnvAuthzPolicy("not json")).toEqual({});
    expect(parseEnvAuthzPolicy("[1,2,3]")).toEqual({});
  });

  it("drops mistyped keys within a rule rather than throwing", () => {
    const raw = JSON.stringify({
      staging: { githubTeams: "not-an-array", emails: ["a@b.com"], junk: 1 },
    });
    expect(parseEnvAuthzPolicy(raw)).toEqual({ staging: { emails: ["a@b.com"] } });
  });
});
