import { describe, expect, it } from "vitest";
import { gitlabScmConfig } from "./gitlab-scm-config";

describe("gitlabScmConfig", () => {
  it("both absent → empty config (degraded scm layer, default base URL)", () => {
    expect(gitlabScmConfig({})).toEqual({});
  });

  it("a real token and base URL pass through", () => {
    expect(
      gitlabScmConfig({ GITLAB_TOKEN: "tok", GITLAB_BASE_URL: "https://gitlab.example.com/api/v4" }),
    ).toEqual({ token: "tok", baseUrl: "https://gitlab.example.com/api/v4" });
  });

  it("a blank/whitespace-only token is treated as absent", () => {
    expect(gitlabScmConfig({ GITLAB_TOKEN: "   " })).toEqual({});
    expect(gitlabScmConfig({ GITLAB_TOKEN: "" })).toEqual({});
  });

  it("a blank/whitespace-only base URL is treated as absent", () => {
    expect(gitlabScmConfig({ GITLAB_TOKEN: "tok", GITLAB_BASE_URL: "   " })).toEqual({ token: "tok" });
  });

  it("token present, base URL absent → only token in the config", () => {
    expect(gitlabScmConfig({ GITLAB_TOKEN: "tok" })).toEqual({ token: "tok" });
  });

  it("trims leading/trailing whitespace off a real token and base URL", () => {
    expect(
      gitlabScmConfig({ GITLAB_TOKEN: "  tok  ", GITLAB_BASE_URL: "  https://gitlab.example.com/api/v4  " }),
    ).toEqual({ token: "tok", baseUrl: "https://gitlab.example.com/api/v4" });
  });
});
