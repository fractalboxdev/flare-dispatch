// FlareDispatch Dispatcher — GitHub metadata for the deploy console dropdowns.
//
// The deploy page's Ref and Commit dropdowns need real data — branch names and
// recent commits for the (private) target repo. This resolves them through the
// installed GitHub App (installation token), reusing the `github-app` package's
// token helpers. Everything is BEST-EFFORT: any failure (App not configured,
// repo not installed, API blip) returns null/empty so the page still renders
// with config/defaults rather than erroring — the deploy path itself degrades
// to "resolve HEAD at POST" or an actionable 400.
//
// `shortRef` and `commitLabel` are pure and unit-tested (github-deploy.test.ts).

import {
  getInstallationToken,
  resolveRepoInstallationId,
} from "@fractalboxdev/flare-dispatch-github-app";
import type { Env } from "./env";

const API_BASE = "https://api.github.com";

const ghHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "flare-dispatch",
});

/** Strip a `refs/heads/` or `refs/tags/` prefix to the bare name GitHub's
 *  `?sha=` / branch APIs expect. A bare name passes through unchanged. */
export const shortRef = (ref: string): string =>
  ref.replace(/^refs\/(heads|tags)\//, "");

/** A short, single-line label for a commit option (`<sha7> <subject>`). */
export const commitLabel = (sha: string, message: string): string => {
  const subject = message.split("\n")[0]!.trim();
  const trimmed = subject.length > 60 ? `${subject.slice(0, 57)}…` : subject;
  return trimmed.length > 0 ? `${sha.slice(0, 7)} · ${trimmed}` : sha.slice(0, 7);
};

/** One commit for the SHA dropdown. */
export interface Commit {
  readonly sha: string;
  readonly label: string;
}

/** Mint an installation token for a repo, or null when the App can't serve it. */
const installationToken = async (env: Env, repo: string): Promise<string | null> => {
  const appId = env.GITHUB_APP_ID;
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY;
  if (appId === undefined || privateKeyPem === undefined) return null;
  try {
    const installationId = await resolveRepoInstallationId({ appId, privateKeyPem, repo });
    return await getInstallationToken({ appId, privateKeyPem, installationId });
  } catch {
    return null;
  }
};

/** The repo's branch names (bare), newest-listed-first per GitHub, or null. */
export const listBranches = async (
  env: Env,
  repo: string,
  limit = 100,
): Promise<readonly string[] | null> => {
  const token = await installationToken(env, repo);
  if (token === null) return null;
  try {
    const res = await fetch(
      `${API_BASE}/repos/${repo}/branches?per_page=${limit}`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as ReadonlyArray<{ name?: unknown }>;
    return body
      .map((b) => (typeof b.name === "string" ? b.name : ""))
      .filter((n) => n.length > 0);
  } catch {
    return null;
  }
};

/** Recent commits on `ref` (newest first) as dropdown options, or null. */
export const listRecentCommits = async (
  env: Env,
  repo: string,
  ref: string,
  limit = 20,
): Promise<readonly Commit[] | null> => {
  const token = await installationToken(env, repo);
  if (token === null) return null;
  try {
    const res = await fetch(
      `${API_BASE}/repos/${repo}/commits?sha=${encodeURIComponent(shortRef(ref))}&per_page=${limit}`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as ReadonlyArray<{
      sha?: unknown;
      commit?: { message?: unknown };
    }>;
    return body
      .filter((c): c is { sha: string; commit?: { message?: unknown } } => typeof c.sha === "string")
      .map((c) => ({
        sha: c.sha,
        label: commitLabel(c.sha, typeof c.commit?.message === "string" ? c.commit.message : ""),
      }));
  } catch {
    return null;
  }
};

/** Resolve the HEAD SHA of `ref` (the newest commit), or null on failure. */
export const resolveRefHead = async (
  env: Env,
  repo: string,
  ref: string,
): Promise<string | null> => {
  const commits = await listRecentCommits(env, repo, ref, 1);
  return commits !== null && commits.length > 0 ? commits[0]!.sha : null;
};
