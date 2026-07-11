// Unit coverage for the pure helpers exported from `sandbox-cf.ts`. The
// `makeSandboxCloudflareLive` Layer itself binds the `@cloudflare/sandbox`
// `Sandbox` Durable Object, which Miniflare can't host without a container
// runtime — that path is exercised by `wrangler dev` acceptance and stays
// out of the unit suite (see the PR4-RISK header in `sandbox-cf.ts`).

import { describe, expect, it } from "vitest";
import { authenticateCloneUrl } from "./sandbox-clone-url";

describe("authenticateCloneUrl", () => {
  it("embeds the token in a github.com HTTPS URL using x-access-token basic auth", () => {
    const url = "https://github.com/owner/repo.git";
    const out = authenticateCloneUrl(url, "ghs_abc123");
    expect(out).toBe(
      "https://x-access-token:ghs_abc123@github.com/owner/repo.git",
    );
  });

  it("preserves the path + .git suffix exactly", () => {
    const url = "https://github.com/org-with-dashes/repo.name.git";
    const out = authenticateCloneUrl(url, "ghs_xyz");
    expect(out).toBe(
      "https://x-access-token:ghs_xyz@github.com/org-with-dashes/repo.name.git",
    );
  });

  it("leaves a non-github.com URL alone — never rewrites operator-supplied custom URLs", () => {
    const url = "https://gitlab.example.com/group/repo.git";
    expect(authenticateCloneUrl(url, "ghs_should_not_appear")).toBe(url);
  });

  it("leaves a github.com URL alone when it's not HTTPS", () => {
    // The auth shape is HTTPS-only — SSH / git+ssh URLs use key auth, not
    // App tokens, so we must not silently rewrite them.
    const url = "git@github.com:owner/repo.git";
    expect(authenticateCloneUrl(url, "ghs_irrelevant")).toBe(url);
  });

  it("does not rewrite a github.com URL with a different subdomain (api.github.com etc.)", () => {
    const url = "https://api.github.com/repos/owner/repo";
    expect(authenticateCloneUrl(url, "ghs_irrelevant")).toBe(url);
  });
});
