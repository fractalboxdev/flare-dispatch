// @fractalboxdev/flare-dispatch-gitlab-app — merge-request diff fetch + review-note post/update.
//
// The operations the `mr-review` recipe needs, mirroring github-app's
// `pull-requests.ts` / `reviews.ts`:
//
//   * `fetchMergeRequestDiff` — GET the MR's per-file diffs and assemble them
//     into ONE standard `git`-style unified diff string, so the review engine
//     (which parses `diff --git` / `+++ b/…` headers) reads a GitLab MR exactly
//     as it reads a GitHub PR. Paginates the `/diffs` endpoint (per_page=100,
//     following the `x-next-page` header).
//   * `postMergeRequestNote` — POST a top-level note (the visible review comment),
//     returning its id so the caller can later update it in place.
//   * `updateMergeRequestNote` — PUT a new body onto an existing note.
//
// Authenticated with a project access token via the `PRIVATE-TOKEN` header (see
// http.ts). Provider-neutral plain `async`; the Effect Layer
// (`makeGitlabScmLive` in @fractalboxdev/flare-dispatch-runtime-cf) wraps these onto `Scm`.
//
// GitLab diffs API: `GET /projects/:id/merge_requests/:iid/diffs` →
//   [{ old_path, new_path, new_file, renamed_file, deleted_file, diff }]
// where `diff` is the hunk body (`@@ … @@` + `+`/`-`/context lines) WITHOUT the
// `---`/`+++` file headers — those are synthesized here from the path + flags.

import { assertOk, encodeProjectId, glHeaders, resolveClient } from "./http";

/** One file's diff entry from the GitLab MR `/diffs` endpoint. */
export type GitlabMrDiffFile = {
  readonly old_path: string;
  readonly new_path: string;
  readonly new_file: boolean;
  readonly renamed_file: boolean;
  readonly deleted_file: boolean;
  /** The hunk body — `@@ … @@` + content lines, no `---`/`+++` headers. */
  readonly diff: string;
};

/** The `diff --git` / `---` / `+++` header lines for one file, shared by
 *  {@link fileSection} and {@link truncateFileToFit} (which needs the
 *  header's byte cost on its own, before the body is truncated to fit). */
const fileHeader = (f: GitlabMrDiffFile): string => {
  const minus = f.new_file ? "/dev/null" : `a/${f.old_path}`;
  const plus = f.deleted_file ? "/dev/null" : `b/${f.new_path}`;
  const header = [
    `diff --git a/${f.old_path} b/${f.new_path}`,
    `--- ${minus}`,
    `+++ ${plus}`,
  ];
  return `${header.join("\n")}\n`;
};

/**
 * One file's unified-diff section:
 *
 *   diff --git a/<old_path> b/<new_path>
 *   --- <a/<old_path> | /dev/null (new file)>
 *   +++ <b/<new_path> | /dev/null (deleted file)>
 *   <hunk body verbatim>
 *
 * A renamed file keeps distinct a/old + b/new headers (the review only needs the
 * paths + hunks; git's `rename from/to` metadata is not reconstructed). A file
 * whose `diff` body is empty (a pure rename/mode change) still emits its headers
 * so the change is visible to the reviewer. Shared by {@link assembleUnifiedDiff}
 * and the size accounting {@link fetchMergeRequestDiff} does per file, so both
 * agree byte-for-byte on what one file "costs".
 */
const fileSection = (f: GitlabMrDiffFile): string => {
  // Keep the hunk body verbatim; ensure the section ends with a newline so
  // the next `diff --git` starts on its own line.
  const body = f.diff.endsWith("\n") ? f.diff : `${f.diff}\n`;
  return `${fileHeader(f)}${body}`;
};

/** Byte length of a string (UTF-8), not its UTF-16 `.length` — what the 1 MiB
 *  diff-size cap actually bounds. */
const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/**
 * Truncate a file's diff BODY so its assembled section fits within
 * `maxBytes` — cuts at the last full line boundary at/under the budget
 * (never mid-line, never mid multi-byte UTF-8 character), so the result
 * stays a well-formed (if incomplete) unified-diff section. Returns `f`
 * unchanged when it already fits. Falls back to an empty body when even the
 * header alone doesn't fit (astronomically unlikely — a header is a few
 * dozen bytes).
 */
const truncateFileToFit = (f: GitlabMrDiffFile, maxBytes: number): GitlabMrDiffFile => {
  const headerBytes = byteLength(fileHeader(f));
  // Reserve 1 byte for the trailing newline `fileSection` appends whenever
  // its body doesn't already end with one — a hard-cut body (below) never
  // will, so budget for that byte up front rather than overshooting the cap
  // by exactly one byte.
  const budget = maxBytes - headerBytes - 1;
  if (budget <= 0) return { ...f, diff: "" };
  const bodyBytes = new TextEncoder().encode(f.diff);
  if (bodyBytes.length <= budget) return f;
  let cut = budget;
  while (cut > 0 && bodyBytes[cut - 1] !== 0x0a) cut--;
  // No newline anywhere within the budget (one pathologically long line —
  // e.g. a minified file) — fall back to a hard byte cut rather than
  // truncating all the way down to nothing. A hard cut can split a
  // multi-byte UTF-8 character; `TextDecoder`'s default (non-fatal) mode
  // replaces a partial trailing sequence with U+FFFD rather than throwing.
  if (cut === 0) cut = budget;
  let body = new TextDecoder().decode(bodyBytes.slice(0, cut));
  // That replacement (U+FFFD is 3 bytes) can push a hard cut a byte or two
  // OVER the budget — trim code units until the re-encoded body fits.
  while (body.length > 0 && new TextEncoder().encode(body).length > budget) body = body.slice(0, -1);
  return { ...f, diff: body };
};

/**
 * Assemble GitLab's per-file diff entries into ONE standard unified-diff
 * string. PURE — no I/O — so it unit-tests directly. See {@link fileSection}
 * for one file's shape.
 */
export const assembleUnifiedDiff = (
  files: ReadonlyArray<GitlabMrDiffFile>,
): string => files.map(fileSection).join("");

/** Max pages the diff pagination will follow — bounds a pathological MR. */
const MAX_DIFF_PAGES = 50;

/** Max assembled-diff size before {@link fetchMergeRequestDiff} stops early
 *  and marks the result `truncated` — a review covering only a prefix of an
 *  enormous MR beats one that never finishes fetching (or blows the model's
 *  context) trying to carry the whole thing. */
const MAX_DIFF_BYTES = 1024 * 1024; // 1 MiB

export type FetchMergeRequestDiffOptions = {
  /** The project access token authenticating the call. */
  readonly token: string;
  /** Numeric project id or `"group/project"` path. */
  readonly projectId: string | number;
  /** The merge-request `iid` (project-scoped id, NOT the global `id`). */
  readonly iid: number;
  /** API base override (tests / self-hosted GitLab). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/** What {@link fetchMergeRequestDiff} resolves to. */
export type FetchMergeRequestDiffResult = {
  /** The assembled unified diff — the files that fit under {@link MAX_DIFF_BYTES}. */
  readonly diff: string;
  /** `true` when the diff was cut short by the 1 MiB cap (or the page cap) —
   *  the result covers only a PREFIX of the merge request's real diff. */
  readonly truncated: boolean;
  /** How many `/diffs` pages were actually fetched. */
  readonly pages: number;
};

/**
 * Fetch a merge request's full diff as ONE unified-diff string. Paginates the
 * `/diffs` endpoint (per_page=100) following the `x-next-page` response header
 * until it is empty, a size cap is hit, or {@link MAX_DIFF_PAGES} is reached.
 *
 * Stops accepting further files (and marks `truncated`) once the assembled
 * diff would exceed {@link MAX_DIFF_BYTES} — EXCEPT the very first file is
 * always kept, TRUNCATED WITHIN ITSELF to fit the cap if it alone would
 * exceed it (see {@link truncateFileToFit}), rather than dropped whole (a
 * diff that dropped everything, including the first file, would read as
 * "nothing to review" instead of "too big to review in full", AND a single
 * oversized file could defeat the cap entirely by riding through untouched).
 * An MR with zero diff entries resolves to an empty string
 * (`truncated: false`), never a throw.
 *
 * @throws {GitlabApiError} when the API returns non-2xx.
 */
export const fetchMergeRequestDiff = async (
  opts: FetchMergeRequestDiffOptions,
): Promise<FetchMergeRequestDiffResult> => {
  const { apiBase, doFetch } = resolveClient(opts);
  const project = encodeProjectId(opts.projectId);
  const files: GitlabMrDiffFile[] = [];

  // Defence in depth: `iid` is a caller-supplied value; encode it into the path
  // so a non-numeric value can never inject extra path segments (the webhook
  // route also validates it is a positive integer BEFORE reaching here).
  const iid = encodeURIComponent(String(opts.iid));

  let page = 1;
  let pagesFetched = 0;
  let totalBytes = 0;
  let truncated = false;
  let morePagesRemain = false;

  pageLoop: for (let i = 0; i < MAX_DIFF_PAGES; i++) {
    const res = await doFetch(
      `${apiBase}/projects/${project}/merge_requests/${iid}/diffs?per_page=100&page=${page}`,
      { method: "GET", headers: glHeaders(opts.token) },
    );
    await assertOk(res, "merge-request diffs fetch failed");
    const batch = (await res.json()) as GitlabMrDiffFile[];
    pagesFetched++;

    for (const f of batch) {
      const sectionBytes = byteLength(fileSection(f));
      if (files.length === 0) {
        // The very first file is always kept — but truncated WITHIN itself
        // to fit the cap when it alone would exceed it, so one huge file can
        // no longer ride through untouched and defeat the cap entirely.
        if (sectionBytes > MAX_DIFF_BYTES) {
          const truncatedFile = truncateFileToFit(f, MAX_DIFF_BYTES);
          files.push(truncatedFile);
          totalBytes += byteLength(fileSection(truncatedFile));
          truncated = true;
          break pageLoop;
        }
        files.push(f);
        totalBytes += sectionBytes;
        continue;
      }
      if (totalBytes + sectionBytes > MAX_DIFF_BYTES) {
        truncated = true;
        break pageLoop;
      }
      files.push(f);
      totalBytes += sectionBytes;
    }

    // GitLab paginates with `x-next-page` — empty (or absent) means done.
    const next = res.headers.get("x-next-page");
    if (next === null || next.trim() === "") {
      morePagesRemain = false;
      break;
    }
    const parsed = Number.parseInt(next, 10);
    if (!Number.isInteger(parsed) || parsed <= page) {
      morePagesRemain = false;
      break;
    }
    page = parsed;
    morePagesRemain = true;
  }
  // Hitting the page cap while GitLab still reports a next page is ALSO
  // truncation — a pathological MR with more than MAX_DIFF_PAGES pages of
  // diffs stopped early too, not just the byte cap.
  if (morePagesRemain) truncated = true;

  return { diff: assembleUnifiedDiff(files), truncated, pages: pagesFetched };
};

export type PostMergeRequestNoteOptions = {
  /** The project access token authenticating the call. */
  readonly token: string;
  /** Numeric project id or `"group/project"` path. */
  readonly projectId: string | number;
  /** The merge-request `iid`. */
  readonly iid: number;
  /** Markdown body of the note. */
  readonly body: string;
  /** API base override (tests / self-hosted GitLab). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/** Read a GitLab note-response body's `id` field into a string, tolerating a
 *  missing/unparseable body rather than throwing (the POST/PUT already
 *  succeeded per `assertOk` — a caller that cannot read the id back just gets
 *  `null` and falls back to its own degrade path). Only a non-blank string or
 *  a finite number counts as a usable id — a blank string, a boolean, an
 *  object/array, `NaN`/`Infinity`, `null`, or a missing field all resolve to
 *  `null` rather than a nonsense stringified value (`""`, `"[object Object]"`,
 *  …), matching the contract's `string | null`. */
const readNoteId = async (res: Response): Promise<string | null> => {
  try {
    const json = (await res.json()) as { id?: unknown };
    const id = json.id;
    if (typeof id === "string") {
      const trimmed = id.trim();
      return trimmed !== "" ? trimmed : null;
    }
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
    return null;
  } catch {
    return null;
  }
};

/**
 * Post a top-level note on a merge request (the visible review comment).
 * Returns the created note's id (as a string) — `null` if the response body
 * carried none — so the caller can `updateMergeRequestNote` it later.
 *
 * @throws {GitlabApiError} when the API returns non-2xx.
 */
export const postMergeRequestNote = async (
  opts: PostMergeRequestNoteOptions,
): Promise<string | null> => {
  const { apiBase, doFetch } = resolveClient(opts);
  const project = encodeProjectId(opts.projectId);
  const iid = encodeURIComponent(String(opts.iid));
  const res = await doFetch(
    `${apiBase}/projects/${project}/merge_requests/${iid}/notes`,
    {
      method: "POST",
      headers: glHeaders(opts.token, { json: true }),
      body: JSON.stringify({ body: opts.body }),
    },
  );
  await assertOk(res, "merge-request note create failed");
  return readNoteId(res);
};

export type UpdateMergeRequestNoteOptions = {
  /** The project access token authenticating the call. */
  readonly token: string;
  /** Numeric project id or `"group/project"` path. */
  readonly projectId: string | number;
  /** The merge-request `iid`. */
  readonly iid: number;
  /** The note id to update (from `postMergeRequestNote`'s return value). */
  readonly noteId: string | number;
  /** Markdown body to replace the note's current body with. */
  readonly body: string;
  /** API base override (tests / self-hosted GitLab). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/**
 * Replace an existing top-level note's body in place
 * (`PUT /projects/:id/merge_requests/:iid/notes/:note_id`). A note that no
 * longer exists (deleted by a human, say) surfaces as a 404 — the caller's
 * `GitlabApiError.status` check (via `makeGitlabScmLive`'s `scmReasonFor`)
 * turns that into `ScmError(reason: "not-found")`.
 *
 * @throws {GitlabApiError} when the API returns non-2xx.
 */
export const updateMergeRequestNote = async (
  opts: UpdateMergeRequestNoteOptions,
): Promise<void> => {
  const { apiBase, doFetch } = resolveClient(opts);
  const project = encodeProjectId(opts.projectId);
  const iid = encodeURIComponent(String(opts.iid));
  const noteId = encodeURIComponent(String(opts.noteId));
  const res = await doFetch(
    `${apiBase}/projects/${project}/merge_requests/${iid}/notes/${noteId}`,
    {
      method: "PUT",
      headers: glHeaders(opts.token, { json: true }),
      body: JSON.stringify({ body: opts.body }),
    },
  );
  await assertOk(res, "merge-request note update failed");
};
