// Unit coverage for the pure helpers exported from `sandbox-cf.ts`. The
// `makeSandboxCloudflareLive` Layer itself binds the `@cloudflare/sandbox`
// `Sandbox` Durable Object, which Miniflare can't host without a container
// runtime — that path is exercised by `wrangler dev` acceptance and stays
// out of the unit suite (see the PR4-RISK header in `sandbox-cf.ts`).

import { describe, expect, it } from "vitest";
import {
  acceptsInstallationToken,
  CLONE_TOKEN_ENV,
  cloneCommand,
  installationLookupSlug,
  shellQuote,
} from "./sandbox-clone-url";

describe("cloneCommand", () => {
  // The clone is the container's only authenticated reach at GitHub — the
  // credential scrub runs the moment the checkout lands. Any flag that defers
  // object transfer (`--filter`, `--depth`, `--single-branch`) leaves git with
  // something to fetch later and no way to pay for it: `pr-review`'s three-dot
  // `git diff base...head` reads merge-base blobs that belong to neither the
  // default-branch tree the clone lands on nor the head `git checkout` moves to,
  // and the promisor fetch died on `could not read Username for github.com`.
  it("transfers every object up front — no filter, depth, or branch narrowing", () => {
    const cmd = cloneCommand("https://github.com/owner/repo.git", "/workspace/repo");
    expect(cmd).toBe(`git clone --quiet 'https://github.com/owner/repo.git' '/workspace/repo'`);
    for (const flag of ["--filter", "--depth", "--single-branch", "--bare", "--sparse"]) {
      expect(cmd).not.toContain(flag);
    }
  });

  it("shell-quotes both operands, so a repo name cannot escape the command", () => {
    // `repo` is an unconstrained `Schema.String` in every run but `runs/check.ts`,
    // and `targetDir` is derived from it.
    const cmd = cloneCommand("https://github.com/o/n.git", "/workspace/ha'kiri");
    expect(cmd).toContain(`'/workspace/ha'\\''kiri'`);
  });

  // A URL carrying its own credential leaks by three routes at once — the
  // command string (redacted today only by an internal of the pinned
  // `@cloudflare/sandbox`, which ADR-0011 says is not a guarantee to lean on),
  // git's stderr, and `.git/config`. Reading the token from the environment
  // closes all three at the source instead of filtering each.
  it("authenticates through the environment, never through the URL", () => {
    const cmd = cloneCommand("https://github.com/owner/repo.git", "/workspace/repo", true);
    // The clone URL stays credential-free…
    expect(cmd).toContain(`clone --quiet 'https://github.com/owner/repo.git'`);
    expect(cmd).not.toContain("x-access-token:");
    // …and the command names the variable rather than carrying its value.
    expect(cmd).toContain(`$${CLONE_TOKEN_ENV}`);
    expect(cmd).toContain("username=x-access-token");
  });

  it("resets any inherited credential helper before installing its own", () => {
    // A helper the container's git configuration prepended would answer first.
    const cmd = cloneCommand("https://github.com/owner/repo.git", "/workspace/repo", true);
    expect(cmd.indexOf("-c credential.helper= ")).toBeLessThan(
      cmd.indexOf("-c 'credential.helper=!f()"),
    );
  });

  it("leaves the command bare when there is no credential to offer", () => {
    // Public repo / unconfigured deploy: no helper, nothing to reset.
    expect(cloneCommand("https://github.com/owner/repo.git", "/workspace/repo")).not.toContain(
      "credential.helper",
    );
  });
});

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
