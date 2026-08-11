// Pure helpers for the `Sandbox` Layer's clone-URL handling. Kept out of
// `sandbox-cf.ts` so unit tests can exercise them without pulling in the
// `@cloudflare/sandbox` runtime import (which only resolves under
// `vitest-pool-workers` / a live Workers env).

/** Build a clone URL from an `owner/name` slug. */
export const repoUrl = (repo: string): string =>
  repo.startsWith("http") ? repo : `https://github.com/${repo}.git`;

/**
 * Whether a GitHub App installation token can authenticate this URL at all —
 * i.e. whether the clone should carry one.
 *
 * The clone path asks this BEFORE resolving an installation, so a URL an App
 * token could never help (an operator-supplied mirror or GHE host, an SSH
 * remote that authenticates by key) is never blocked on a GitHub App
 * installation lookup that has nothing to say about it.
 */
export const acceptsInstallationToken = (url: string): boolean =>
  url.startsWith("https://github.com/");

const GITHUB_HTTPS_PREFIX = "https://github.com/";

/**
 * The `owner/name` an installation lookup needs, for a clone target that may
 * arrive as either form.
 *
 * `repoUrl` passes a `repo` that already looks like a URL straight through, so
 * a run may name its target as `https://github.com/owner/name.git` rather than
 * the `owner/name` slug — every run input but `runs/check.ts` declares `repo`
 * as an unconstrained `Schema.String`. `GET /repos/{owner}/{repo}/installation`
 * takes the SLUG: handed a URL it requests
 * `/repos/https://github.com/owner/name.git/installation`, 404s, and the clone
 * fails with "no GitHub App installation for https://…" — a repo that has one.
 *
 * So the lookup key is derived from the canonical clone URL, never from the raw
 * input. `undefined` means "no App installation can be resolved for this URL"
 * — a non-github.com host, an SSH remote, or a github.com URL that is not a
 * two-segment repo path — and the caller skips the lookup rather than guessing.
 */
export const installationLookupSlug = (url: string): string | undefined => {
  if (!acceptsInstallationToken(url)) return undefined;
  const path = url
    .slice(GITHUB_HTTPS_PREFIX.length)
    .split(/[?#]/, 1)[0]
    ?.replace(/\.git$/, "")
    .replace(/\/+$/, "");
  if (path === undefined) return undefined;
  const segments = path.split("/");
  if (segments.length !== 2) return undefined;
  const [owner, name] = segments;
  if (owner === undefined || name === undefined || owner === "" || name === "") return undefined;
  return `${owner}/${name}`;
};

/**
 * Quote a value for interpolation into a single-quoted shell word.
 *
 * The clone path builds `git -C <dir> …` command strings around values derived
 * from a run's `repo` input, which is an unconstrained `Schema.String` in every
 * run but `runs/check.ts`. Without quoting, a `repo` containing `'` ends the
 * quoted word and the rest of the value is parsed as shell — enough to make the
 * credential scrub silently no-op on a tree that still holds a token.
 *
 * The `'\''` dance is the only way to get a literal single quote inside single
 * quotes. Same construction as the substrate's `shellQuote`
 * (`apps/substrate/src/engine/policy.ts`), duplicated rather than imported
 * because a package must not depend on an app.
 */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Wall-clock budget for the clone, in seconds. Matches the value the SDK's
 * `gitCheckout` applied to the clone it used to own, so replacing it does not
 * quietly change how long a big repo is allowed to take.
 */
export const CLONE_TIMEOUT_SEC = 600;

/**
 * How the workspace clones — deliberately COMPLETE: no `--filter`, no
 * `--depth`, no `--single-branch`.
 *
 * The clone is the container's ONLY authenticated reach at GitHub: the
 * credential lives on that one `exec` and nothing after it holds one (ADR-0006,
 * see {@link CREDENTIAL_HELPER_ARGS}). So a repository that still needs the
 * network to answer a question about its own history has no way to ask — git
 * falls back to the promisor remote, finds no credential, and dies on `could not
 * read Username for 'https://github.com'` → `unable to read <oid>`.
 *
 * `pr-review` is where that bit. Its three-dot `git diff <base>...<head>` reads
 * the MERGE-BASE blobs, which belong to neither of the two trees a clone
 * materialises — the default-branch tip it lands on, and the head `git checkout`
 * moves to. Under a blob-filtered clone those blobs are absent, so the step
 * spent five minutes on two credential prompts and then failed. Intermittently,
 * which is why it read as flakiness: it only bit when a merge-base blob differed
 * from both trees on disk, i.e. when the PR sat behind its base by a commit that
 * touched the same file.
 *
 * Completeness is therefore a property of this primitive, not of any one recipe.
 * Anything cheaper needs a credential that outlives the clone, and that trade is
 * already decided the other way.
 */
export const cloneCommand = (url: string, targetDir: string, authenticated = false): string => {
  const auth = authenticated ? `${CREDENTIAL_HELPER_ARGS} ` : "";
  return `git ${auth}clone --quiet ${shellQuote(url)} ${shellQuote(targetDir)}`;
};

/**
 * The environment variable the clone's credential helper reads the installation
 * token out of. Set on the clone `exec` and nothing else.
 */
export const CLONE_TOKEN_ENV = "FLARE_DISPATCH_CLONE_TOKEN";

/**
 * `git -c` arguments that answer GitHub's auth challenge from
 * {@link CLONE_TOKEN_ENV}, using the documented `x-access-token` basic-auth
 * identity.
 *
 * The token is deliberately NOT embedded in the clone URL
 * (`https://x-access-token:<token>@github.com/…`), which is the obvious way to
 * do this and the way this layer used to. A URL carrying its own credential
 * leaks by three routes at once, and each one needs its own guard:
 *
 *   * the COMMAND STRING, which the SDK hands to its logger — redacted today by
 *     `redactCommand` inside `@cloudflare/sandbox`, i.e. by an internal of a
 *     pinned dependency. ADR-0011 is about exactly that: an SDK pin is a
 *     security surface, and a guarantee held up by one is a guarantee that can
 *     be revoked by a version bump nobody reads as a security change.
 *   * git's own STDERR, which quotes the remote it failed on — the reason
 *     `redactCloneFailure` exists.
 *   * `.git/config`, where `git clone` persists the whole URL — the reason
 *     `scrubCloneCredential` exists.
 *
 * Reading the token from the environment closes all three at the source rather
 * than filtering each: the command carries only the variable's NAME, git only
 * ever sees the credential-free URL (so nothing it prints can contain a token),
 * and no credential is written to `.git/config` in the first place. Both guards
 * stay, now as backstops against a token that arrives by some route this
 * reasoning did not anticipate, rather than as the only thing between an
 * installation token and the workload.
 *
 * The leading empty `credential.helper` resets any inherited helper list, so the
 * container's git configuration cannot prepend one that answers first.
 */
const CREDENTIAL_HELPER = `!f() { echo username=x-access-token; echo "password=$${CLONE_TOKEN_ENV}"; }; f`;

const CREDENTIAL_HELPER_ARGS = `-c credential.helper= -c ${shellQuote(
  `credential.helper=${CREDENTIAL_HELPER}`,
)}`;
