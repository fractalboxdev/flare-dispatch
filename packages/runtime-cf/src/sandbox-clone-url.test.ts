// Unit coverage for the pure helpers exported from `sandbox-cf.ts`. The
// `makeSandboxCloudflareLive` Layer itself binds the `@cloudflare/sandbox`
// `Sandbox` Durable Object, which Miniflare can't host without a container
// runtime — that path is exercised by `wrangler dev` acceptance and stays
// out of the unit suite (see the PR4-RISK header in `sandbox-cf.ts`).

import { describe, expect, it } from "vitest";
import {
  acceptsInstallationToken,
  authenticateCloneUrl,
  installationLookupSlug,
  shellQuote,
} from "./sandbox-clone-url";

describe("acceptsInstallationToken", () => {
  it("is true exactly for the HTTPS github.com URLs the token shape fits", () => {
    expect(acceptsInstallationToken("https://github.com/owner/repo.git")).toBe(true);
  });

  it("is false for URLs an App token could never authenticate", () => {
    // The clone path asks this BEFORE resolving an installation, so a URL the
    // token cannot help must never block the clone on a lookup about it.
    expect(acceptsInstallationToken("https://gitlab.example.com/group/repo.git")).toBe(false);
    expect(acceptsInstallationToken("git@github.com:owner/repo.git")).toBe(false);
    expect(acceptsInstallationToken("https://github.enterprise.example/owner/repo.git")).toBe(
      false,
    );
  });
});

describe("authenticateCloneUrl", () => {
  it("embeds the token in a github.com HTTPS URL using x-access-token basic auth", () => {
    const url = "https://github.com/owner/repo.git";
    const out = authenticateCloneUrl(url, "ghs_abc123");
    expect(out).toBe("https://x-access-token:ghs_abc123@github.com/owner/repo.git");
  });

  it("preserves the path + .git suffix exactly", () => {
    const url = "https://github.com/org-with-dashes/repo.name.git";
    const out = authenticateCloneUrl(url, "ghs_xyz");
    expect(out).toBe("https://x-access-token:ghs_xyz@github.com/org-with-dashes/repo.name.git");
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

describe("installationLookupSlug", () => {
  it("recovers the owner/name a `GET /repos/{owner}/{repo}/installation` needs", () => {
    // The regression this guards: `repoUrl` passes a URL-shaped `repo` straight
    // through, and looking the URL up verbatim requests
    // `/repos/https://github.com/owner/repo.git/installation` → 404 → a clone
    // that fails on a repo which does have an installation.
    expect(installationLookupSlug("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(installationLookupSlug("https://github.com/owner/repo")).toBe("owner/repo");
    expect(installationLookupSlug("https://github.com/owner/repo/")).toBe("owner/repo");
    expect(installationLookupSlug("https://github.com/org-with-dashes/repo.name.git")).toBe(
      "org-with-dashes/repo.name",
    );
  });

  it("is undefined for any URL an App installation cannot be resolved for", () => {
    // Caller skips the lookup rather than guessing at a slug.
    expect(installationLookupSlug("https://gitlab.example.com/group/repo.git")).toBeUndefined();
    expect(installationLookupSlug("git@github.com:owner/repo.git")).toBeUndefined();
    expect(installationLookupSlug("https://api.github.com/repos/owner/repo")).toBeUndefined();
    // Not a two-segment repo path.
    expect(installationLookupSlug("https://github.com/owner")).toBeUndefined();
    expect(installationLookupSlug("https://github.com/owner/repo/tree/main")).toBeUndefined();
    expect(installationLookupSlug("https://github.com/")).toBeUndefined();
  });
});

describe("shellQuote", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shellQuote("/workspace/repo")).toBe("'/workspace/repo'");
  });

  it("escapes an embedded single quote so it cannot end the quoted word", () => {
    // `repo` is an unconstrained `Schema.String` in every run but check.ts, and
    // the scrub interpolates values derived from it into a shell command.
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(shellQuote("x'; rm -rf /; :'")).toBe(`'x'\\''; rm -rf /; :'\\'''`);
  });
});
