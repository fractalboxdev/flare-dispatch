// Pure helpers for the `Sandbox` Layer's clone-URL handling. Kept out of
// `sandbox-cf.ts` so unit tests can exercise them without pulling in the
// `@cloudflare/sandbox` runtime import (which only resolves under
// `vitest-pool-workers` / a live Workers env).

/** Build a clone URL from an `owner/name` slug. */
export const repoUrl = (repo: string): string =>
  repo.startsWith("http") ? repo : `https://github.com/${repo}.git`;

/**
 * Whether a GitHub App installation token can authenticate this URL at all —
 * i.e. whether {@link authenticateCloneUrl} would rewrite it.
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
 * The clone is the container's ONLY authenticated reach at GitHub. The
 * installation token is rewritten back out of `.git/config` the moment the
 * checkout lands (ADR-0006, see `scrubCloneCredential`), so a repository that
 * still needs the network to answer a question about its own history has no way
 * to ask: git falls back to the promisor remote, finds no credential, and dies
 * on `could not read Username for 'https://github.com'` → `unable to read
 * <oid>`.
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
export const cloneCommand = (url: string, targetDir: string): string =>
  `git clone --quiet ${shellQuote(url)} ${shellQuote(targetDir)}`;

/**
 * Embed a GitHub App installation token into an HTTPS GitHub clone URL using
 * the documented `x-access-token` basic-auth shape:
 *
 *   https://x-access-token:<token>@github.com/<owner>/<name>.git
 *
 * Only HTTPS `github.com` URLs are rewritten — a custom http(s) URL the caller
 * passed directly (mirror, GHE host, etc.) is returned unchanged so the auth
 * shape never silently overrides an operator-supplied URL. SSH URLs are also
 * left alone: they authenticate via key, not via an App token.
 */
export const authenticateCloneUrl = (url: string, token: string): string =>
  acceptsInstallationToken(url)
    ? url.replace("https://github.com/", `https://x-access-token:${token}@github.com/`)
    : url;
