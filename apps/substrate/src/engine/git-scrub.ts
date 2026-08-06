// Scrubbing GitHub installation tokens out of the container's filesystem
// (specs/adr/0006-credential-boundary.md).
//
// An authenticated clone URL is a credential written to disk. `git clone
// https://x-access-token:<token>@github.com/owner/name.git` succeeds and then
// persists the whole URL — token included — in `.git/config` as
// `remote.origin.url`, where it outlives the clone, survives into every
// checkpoint backup, and is readable by anything the workload runs. That is
// precisely the "no long-lived credential reachable from inside a container,
// on the filesystem" case ADR-0006 closes, and an installation token is good
// for an hour of write access to every repo the App is installed on.
//
// Two chokepoints, because one is not enough:
//
// 1. **Post-clone**, in the same `ensure()` that cloned: the remote is rewritten
//    to its credential-free form before any workload command runs. The clean
//    URL is computed here from the recipe's slug rather than parsed out of the
//    dirty one — the substrate already knows what the remote should be, and
//    deriving it is not a string operation that can go subtly wrong.
// 2. **At capture**, before a backup is taken: a redaction pass over every
//    `.git/config` under the workspace, plus the ambient credential files git
//    reads (`.git-credentials`, `.netrc`). This is the backstop for a token a
//    *workload* wrote — a `git remote add`, a `git config credential.helper
//    store`, a submodule with its own remote — which the post-clone scrub never
//    saw.
//
// Both are shell one-liners rather than SDK calls: the state lives inside the
// container, and `git` is the only thing that can rewrite it in place. Pure —
// every function returns a command string, so the commands are asserted in
// tests instead of being trusted in production. Unit tested in git-scrub.test.ts.
import { shellQuote } from "./policy";

/**
 * The credential-free HTTPS clone URL for a slug — what a remote should read
 * after the scrub, and what `cleanRebuild` clones with today (the substrate's
 * own clone is unauthenticated; the scrub exists so it stays credential-free
 * when private-repo cloning lands).
 */
export function publicCloneUrl(slug: string): string {
  return `https://github.com/${slug}.git`;
}

/**
 * Strip userinfo from an HTTP(S) URL, leaving everything else intact.
 *
 * Used to check what a remote currently holds and to redact a URL before it is
 * logged. Not the mechanism the scrub relies on — the scrub *sets* a known-good
 * URL rather than editing a dirty one — but a token that reaches a log or an
 * error message has still leaked, so this is what any such path goes through.
 * A string that does not parse is returned unchanged: it is not a URL, and
 * silently emitting something else would hide the input.
 */
export function stripUrlCredentials(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username === "" && parsed.password === "") return url;
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

/** True when a URL carries a username or password — i.e. an embedded credential. */
export function hasEmbeddedCredential(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return false;
  }
}

/**
 * Rewrite the workspace's `origin` to its credential-free URL and drop the
 * config git would otherwise re-authenticate from.
 *
 * `remote set-url` rather than `config --unset`: a remote with no URL breaks
 * every later `git fetch` in the workload's own commands, and a scrub that
 * breaks the tree gets reverted by whoever hits it. The `extraheader` unset
 * covers the other documented way a token is persisted (`git -c
 * http.<url>.extraheader=...`, the shape GitHub Actions' checkout uses), and
 * `credential` section removal covers a helper the clone configured.
 *
 * Every clause tolerates absence — `|| true` — because this runs on a tree that
 * may have been restored from a backup rather than freshly cloned, and a
 * missing remote must not fail the ensure that is trying to make it safe.
 */
export function scrubRemotesCommand(workspaceDir: string, slug: string): string {
  const dir = shellQuote(workspaceDir);
  const url = shellQuote(publicCloneUrl(slug));
  return [
    `git -C ${dir} remote set-url origin ${url} || true`,
    `git -C ${dir} config --local --remove-section credential || true`,
    `git -C ${dir} config --local --unset-all http.https://github.com/.extraheader || true`,
  ].join("; ");
}

/**
 * Redact credentials from everything under the workspace that a backup would
 * capture, run immediately before the snapshot.
 *
 * The `sed` rewrites `url = https://user:pass@host/...` to `url =
 * https://host/...` in every `.git/config` — including submodules', which the
 * post-clone scrub never touched. The pattern deliberately matches the userinfo
 * form only; a bare URL is left alone rather than rewritten to something
 * equivalent, so a diff of this pass is exactly the set of credentials it found.
 *
 * `.git-credentials` and `.netrc` are removed outright: unlike a remote URL
 * there is no credential-free version of them to keep, and a workload that
 * wrote one wrote a plaintext password store.
 *
 * The caller treats a non-zero exit as "do not take this backup" — a snapshot
 * is a cache, and rebuilding is cheap next to persisting a token to R2.
 */
export function redactCapturedGitConfigCommand(workspaceDir: string): string {
  const dir = shellQuote(workspaceDir);
  return [
    `find ${dir} -type f -name config -path '*/.git/*'` +
      ` -exec sed -i -E 's#(url = [a-zA-Z][a-zA-Z0-9+.-]*://)[^/@[:space:]]*@#\\1#g' {} +`,
    `find ${dir} -type f \\( -name '.git-credentials' -o -name '.netrc' \\) -delete`,
  ].join(" && ");
}
