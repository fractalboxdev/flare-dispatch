// @fractalboxdev/flare-dispatch-runtime-cf — the credential a private-repo clone rides on.
//
// A GitHub App reaches a private repo only through an *installation* access
// token, and minting one needs an installation id. Webhook- and Action-mode
// dispatches carry that id on the payload (`github.installation_id`); a cron
// tick carries no payload at all, so Schedule mode had none — and `gitClone`'s
// "authenticate only when an installation id is present" guard therefore sent
// every scheduled clone out UNAUTHENTICATED. Against a private repo that 404s,
// and git reports it as a bare `Failed to clone repository`, which names
// neither the credential nor the missing installation. Result: every scheduled
// run (`spec-drift-pr`, `ci-triage-pr`, `finops-audit`) was silently capped at
// the public repos in the estate, and the cap looked like a git error.
//
// The installation id is not something a cron tick has to carry. The App itself
// is the source of truth for which installation covers a repo
// (`GET /repos/{owner}/{repo}/installation`, App-JWT authenticated), so the
// clone resolves its own — per CLONE TARGET, not once per execution: an estate
// sweep clones repos the dispatch payload never named, and an installation
// covers one account, so "the payload's installation" is the wrong answer for
// every repo but the payload's own.
//
// Failure is loud by construction. When no installation covers a repo, this
// raises an error that SAYS so; it never falls back to an unauthenticated
// clone. The silent fallback is precisely what made the original bug read as a
// git problem for as long as it did.
//
// Kept out of `sandbox-cf.ts` so unit tests can exercise it without pulling in
// the `@cloudflare/sandbox` runtime import (which only resolves under
// `vitest-pool-workers` / a live Workers env) — the same reason
// `sandbox-clone-url.ts` is its own module.
//
// Spec: specs/04-gha-integration.md § Schedule mode,
//       apps/substrate/specs/adr/0006-credential-boundary.md.

import {
  getInstallationToken,
  GithubApiError,
  resolveRepoInstallationId,
} from "@fractalboxdev/flare-dispatch-github-app";

/**
 * GitHub App credentials for authenticating a clone, plus whatever installation
 * context the dispatch already knew.
 *
 * Structurally a superset of `ChecksGithubConfig`, but deliberately its own
 * type: `Checks` needs an installation *pinned* (it writes one check-run, to
 * one repo, on the dispatch that named it), while a clone needs credentials
 * that work for *whichever* repo a run reaches for.
 */
export type SandboxGithubAuth = {
  /** `GITHUB_APP_ID` — the numeric App id. */
  readonly appId: string;
  /** `GITHUB_APP_PRIVATE_KEY` — the App's PKCS#8 PEM private key. */
  readonly privateKeyPem: string;
  /**
   * The dispatch payload's `github.installation_id`, when the run was triggered
   * by a GitHub event. Authoritative for {@link payloadRepo} and nothing else —
   * an installation covers one account, so any other clone target resolves its
   * own. Always absent on the Schedule path.
   */
  readonly installationId?: number;
  /** The `owner/name` that {@link installationId} belongs to. */
  readonly payloadRepo?: string;
};

/**
 * HTTP seam for the two GitHub calls. Tests pass `apiBase` / `fetchImpl`;
 * production passes neither and gets `https://api.github.com` + global `fetch`.
 */
export type CloneAuthClient = {
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
};

/**
 * Compare two `owner/name` slugs. GitHub preserves the case an owner typed but
 * routes case-insensitively, so a payload's `Fractalboxdev/hakiri` and a run
 * input's `fractalboxdev/hakiri` are the same repo and must not take different
 * credential paths.
 */
const isSameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The installation covering `repo`.
 *
 * The payload's id is used only when the clone target IS the payload repo — the
 * webhook already resolved that one, so the dispatch path keeps its exact
 * previous behavior and pays no extra round trip. Everything else resolves from
 * the App JWT, memoized by `resolveRepoInstallationId`'s process-memory
 * repo→installation cache: an estate sweep pays one lookup per repo per Worker
 * isolate, not one per clone.
 */
const installationIdFor = async (
  auth: SandboxGithubAuth,
  repo: string,
  client: CloneAuthClient,
): Promise<number> => {
  if (
    auth.installationId !== undefined &&
    auth.installationId > 0 &&
    auth.payloadRepo !== undefined &&
    isSameRepo(auth.payloadRepo, repo)
  ) {
    return auth.installationId;
  }

  try {
    return await resolveRepoInstallationId({
      appId: auth.appId,
      privateKeyPem: auth.privateKeyPem,
      repo,
      ...client,
    });
  } catch (cause) {
    // 404 is the specific, actionable case: the App exists and the JWT is
    // valid, there is simply no installation on this repo. Say that, rather
    // than let a git 404 three steps later imply the repo does not exist.
    if (cause instanceof GithubApiError && cause.status === 404) {
      throw new Error(
        `no GitHub App installation for ${repo} — install the GitHub App on this repository (a private repo cannot be cloned without one)`,
      );
    }
    throw new Error(
      `GitHub App installation lookup failed for ${repo}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
};

/**
 * Mint the short-lived installation token that authenticates a clone of `repo`.
 *
 * Throws — never returns `undefined` — when no installation covers the repo, so
 * the caller cannot accidentally degrade to an unauthenticated clone.
 */
export const resolveCloneToken = async (
  auth: SandboxGithubAuth,
  repo: string,
  client: CloneAuthClient = {},
): Promise<string> =>
  getInstallationToken({
    appId: auth.appId,
    privateKeyPem: auth.privateKeyPem,
    installationId: await installationIdFor(auth, repo, client),
    ...client,
  });
