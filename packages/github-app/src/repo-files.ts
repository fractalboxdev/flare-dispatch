// @fractalboxdev/flare-dispatch-github-app — read one text file out of a repo.
//
// `readRepoTextFile` reads a single path:
//   GET /repos/{owner}/{repo}/contents/{path}?ref={ref}   Accept: …github.raw
//
// The raw media type returns the file's bytes directly, so there is no base64
// round-trip and no 1 MB inline-content ceiling to trip over.
//
// Deliberately ONE narrow read, not a filesystem. The maintenance loop's
// suppression ledger (`maintenance/declined.jsonl`) lives in git in a
// private repo, and cloning a repo to read one line on every cron tick is
// absurd. Anything wider — trees, directories, writes — has a home already
// (`commitFilesAndOpenPr` writes; a run that needs a working tree clones).
//
// **Absent is a value, not an error.** A 404 returns `{ found: false }`, which
// is what a ledger that does not exist yet looks like — a caller must be able to
// tell that apart from "GitHub said 500", because the two demand opposite
// behavior (proceed vs. warn). Every other non-2xx still throws
// `GithubApiError`.
//
// Authenticated with an installation access token (installation-token.ts) —
// never an App JWT, never a PAT; the ledger repo is private. Provider-neutral
// plain `async`; the Effect Layer (`makeGithubLive`) wraps it.

import { GithubApiError } from "./errors";
import { assertOk, API_BASE_DEFAULT, ghHeaders, resolveClient, splitRepo } from "./http";

export type ReadRepoTextFileOptions = {
  /** The installation access token authenticating the call. */
  readonly token: string;
  /** `"owner/repo"`. */
  readonly repo: string;
  /** Repo-relative path (e.g. `maintenance/declined.jsonl`). */
  readonly path: string;
  /** Branch, tag, or sha. Defaults to the repo's default branch. */
  readonly ref?: string;
  /** API base override (tests / GHE). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Refuse a body larger than this — defaults to {@link MAX_BYTES_DEFAULT}. */
  readonly maxBytes?: number;
};

/**
 * The largest body this read will accept.
 *
 * The raw media type serves files up to 100 MB, and a Worker isolate has 128 MB
 * total — so one oversized file read into a string, then split into lines and a
 * Map by `parseDeclinedLedger`, is three copies of an OOM. Nothing this reader
 * targets is prose measured in megabytes, so the cap is generous and the
 * failure is a `GithubApiError`, which `checkSuppression` degrades on loudly
 * rather than silently truncating.
 */
const MAX_BYTES_DEFAULT = 4 * 1024 * 1024;

/** A file's contents, or the clean "there is no such file" answer. */
export type ReadRepoTextFileResult =
  | { readonly found: true; readonly content: string }
  | { readonly found: false };

/** Build the `contents` request URL — pure, for unit testing. */
export const repoContentsUrl = (opts: {
  readonly repo: string;
  readonly path: string;
  readonly ref?: string;
  readonly apiBase?: string;
}): string => {
  const { owner, name } = splitRepo(opts.repo);
  const base = opts.apiBase ?? API_BASE_DEFAULT;
  // Encode each segment, not the whole path — the slashes are structural.
  //
  // `encodeURIComponent` leaves `.` untouched, so a `..` segment survives
  // encoding intact and the URL parser then resolves it away at fetch time:
  // `path: "../../../user/repos"` turns `…/repos/{o}/{n}/contents/…` into
  // `https://api.github.com/repos/user/repos`, pointing an installation token
  // at an endpoint the caller never named. Dot segments are therefore rejected
  // rather than encoded — this read is one file in one repo, and no legitimate
  // repo-relative path needs them.
  const segments = opts.path.split("/").filter((s) => s.length > 0);
  const escaping = segments.find((s) => s === "." || s === "..");
  if (escaping !== undefined) {
    throw new GithubApiError(`path "${opts.path}" escapes the repo (segment "${escaping}")`, 0, "");
  }
  const path = segments.map(encodeURIComponent).join("/");
  const query = opts.ref !== undefined ? `?ref=${encodeURIComponent(opts.ref)}` : "";
  return `${base}/repos/${owner}/${name}/contents/${path}${query}`;
};

/**
 * Read one text file. `{ found: false }` when the path does not exist at `ref`
 * — and when it exists but is not a file (a directory answers the raw media
 * type with a JSON listing, which is not a text file the caller asked for).
 *
 * @throws {GithubApiError} on any non-2xx other than 404.
 */
export const readRepoTextFile = async (
  opts: ReadRepoTextFileOptions,
): Promise<ReadRepoTextFileResult> => {
  const { doFetch } = resolveClient(opts);
  const res = await doFetch(repoContentsUrl(opts), {
    method: "GET",
    headers: { ...ghHeaders(opts.token), Accept: "application/vnd.github.raw" },
  });
  if (res.status === 404) return { found: false };
  await assertOk(res, `contents read failed for ${opts.repo}:${opts.path}`);
  // A directory (or a submodule/symlink) still answers 200, as JSON. Not a text
  // file → the same answer as absent, rather than a second error taxonomy.
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    return { found: false };
  }
  // Check the declared size BEFORE `res.text()` allocates it. A chunked
  // response carries no `Content-Length` and so slips past this — GitHub sends
  // one for raw contents, so the realistic case is covered, and the line cap in
  // `parseDeclinedLedger` bounds what a caller builds out of the text either way.
  const maxBytes = opts.maxBytes ?? MAX_BYTES_DEFAULT;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new GithubApiError(
      `contents read for ${opts.repo}:${opts.path} is ${declared} bytes, over the ${maxBytes} cap`,
      0,
      "",
    );
  }
  return { found: true, content: await res.text() };
};
