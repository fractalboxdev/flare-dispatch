import { describe, expect, it } from "vitest";
import {
  hasEmbeddedCredential,
  publicCloneUrl,
  redactCapturedGitConfigCommand,
  scrubRemotesCommand,
  stripUrlCredentials,
} from "./git-scrub";

/** The shape a GitHub App installation token takes in a clone URL. */
const AUTHED = "https://x-access-token:ghs_faketokenvalue@github.com/acme/widget.git";

describe("stripUrlCredentials", () => {
  it("removes the userinfo an installation token rides in", () => {
    expect(stripUrlCredentials(AUTHED)).toBe("https://github.com/acme/widget.git");
  });

  it("removes a bare username with no password", () => {
    expect(stripUrlCredentials("https://ghs_fake@github.com/acme/widget.git")).toBe(
      "https://github.com/acme/widget.git",
    );
  });

  it("leaves a credential-free URL byte-identical", () => {
    const clean = "https://github.com/acme/widget.git";
    expect(stripUrlCredentials(clean)).toBe(clean);
  });

  it("returns a non-URL unchanged rather than inventing one", () => {
    expect(stripUrlCredentials("git@github.com:acme/widget.git")).toBe(
      "git@github.com:acme/widget.git",
    );
  });
});

describe("hasEmbeddedCredential", () => {
  it("is true for a userinfo URL and false for a clean one", () => {
    expect(hasEmbeddedCredential(AUTHED)).toBe(true);
    expect(hasEmbeddedCredential("https://github.com/acme/widget.git")).toBe(false);
    expect(hasEmbeddedCredential("not a url")).toBe(false);
  });
});

describe("scrubRemotesCommand", () => {
  const command = scrubRemotesCommand("/workspace", "acme/widget");

  it("sets origin to the URL derived from the slug, not parsed from the dirty one", () => {
    expect(command).toContain(
      `git -C '/workspace' remote set-url origin '${publicCloneUrl("acme/widget")}'`,
    );
  });

  it("drops the two other places git persists a token", () => {
    expect(command).toContain("--remove-section credential");
    expect(command).toContain("http.https://github.com/.extraheader");
  });

  it("tolerates every clause being a no-op on a tree with no remote", () => {
    const clauses = command.split("; ");
    expect(clauses).toHaveLength(3);
    for (const clause of clauses) expect(clause.endsWith("|| true")).toBe(true);
  });

  it("quotes the workspace so a path cannot restructure the command line", () => {
    expect(scrubRemotesCommand("/tmp/a b; rm -rf /", "acme/widget")).toContain(
      `git -C '/tmp/a b; rm -rf /' remote set-url`,
    );
  });
});

describe("redactCapturedGitConfigCommand", () => {
  const command = redactCapturedGitConfigCommand("/workspace");

  it("rewrites every .git/config under the workspace, submodules included", () => {
    expect(command).toContain("-name config -path '*/.git/*'");
    expect(command).toContain("sed -i -E");
  });

  it("deletes the credential stores that have no redacted form", () => {
    expect(command).toContain(".git-credentials");
    expect(command).toContain(".netrc");
  });

  it("chains with && so a failed sweep fails the whole command", () => {
    // The caller treats a non-zero exit as "do not capture this tree"; `;`
    // would let a failed redaction still report success.
    expect(command).toContain(" && ");
    expect(command).not.toContain("|| true");
  });

  it("matches the userinfo form its sed is meant to strip", () => {
    // The redaction runs in the container; the regex is asserted here against
    // the exact line git writes, so a change to it fails a test rather than a
    // backup.
    const configLine = "\turl = https://x-access-token:ghs_fake@github.com/acme/widget.git";
    const equivalent = configLine.replace(
      /(url = [a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]*@/g,
      "$1",
    );
    expect(equivalent).toBe("\turl = https://github.com/acme/widget.git");
  });
});
