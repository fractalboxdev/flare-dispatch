// @fractalboxdev/flare-dispatch-github-app — the issue surface: one read, four writes.
//
//   GET    /repos/{o}/{r}/issues                    — list, carrying labels
//   POST   /repos/{o}/{r}/issues/{n}/labels         — add labels
//   DELETE /repos/{o}/{r}/issues/{n}/labels/{name}  — remove one label
//   POST   /repos/{o}/{r}/issues/{n}/comments       — comment
//   POST   /repos/{o}/{r}/issues/{n}/assignees      — assign
//   PATCH  /repos/{o}/{r}/issues/{n}                — close AS A DUPLICATE, only
//
// Why these and not a general issue API: `process/content/maintenance-loop.md`
// §5 says **labels are the state machine**, and a classifier whose verdict
// cannot be recorded is spend with no artifact. This is exactly the set §5's
// issue machine names and nothing else — no create, no reopen, no edit, no
// milestone. A capability nobody needs is a capability waiting to be mis-wired.
//
// --- `closeIssueAsDuplicate` is not `closeIssue` ------------------------------
//
// Closing is the one irreversible-ish write here, and §5 authorizes it for
// exactly one verdict: a duplicate, linked to its original. So the function is
// named for that verdict and **requires `duplicateOf`**. There is no way to
// spell "close this issue" without also naming the issue it duplicates, which
// makes "close on a non-duplicate verdict" unrepresentable rather than merely
// forbidden — the reviewer checks a signature instead of auditing call sites.
// The `state_reason: "duplicate"` GitHub records is the same claim, in a form
// GitHub's own UI reads.
//
// --- The list endpoint returns pull requests too -----------------------------
//
// `GET /issues` is the "issues and PRs" endpoint — every PR is an issue in
// GitHub's data model, and a PR comes back carrying a `pull_request` key. A
// triage pass that skipped that filter would classify pull requests as bugs and
// label them. They are filtered out here, once, rather than at each caller.
//
// --- Author provenance travels with the issue --------------------------------
//
// `author_association` is read and returned because §5 requires it: a repro
// captured from a first-time external reporter and one from a repo member are
// different facts, and "whoever wires the dispatch must be able to tell a repo
// member from a first-time external reporter". Dropping it here would make that
// distinction unavailable to every consumer downstream.
//
// Provider-neutral plain `async`, no Effect — the Layer (`makeGithubLive`) wraps
// these, the same split every other module in this package keeps.

import { assertOk, API_BASE_DEFAULT, ghHeaders, resolveClient, splitRepo } from "./http";

/** How GitHub describes the author's standing in the repo. */
export type AuthorAssociation =
  | "OWNER"
  | "MEMBER"
  | "COLLABORATOR"
  | "CONTRIBUTOR"
  | "FIRST_TIME_CONTRIBUTOR"
  | "FIRST_TIMER"
  | "MANNEQUIN"
  | "NONE";

/** One issue, in the shape the triage desk reads. */
export type IssueListItem = {
  readonly number: number;
  readonly title: string;
  /** Body text. `""` when the reporter left it empty. UNTRUSTED prose. */
  readonly body: string;
  readonly state: "open" | "closed";
  /** Label names, lowercased by GitHub's own casing — used as exact strings. */
  readonly labels: readonly string[];
  readonly author: string;
  /** The author's standing in this repo (§5 — provenance travels with the repro). */
  readonly authorAssociation: AuthorAssociation;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
  readonly commentCount: number;
};

const ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
]);

/** GitHub's issue JSON — only the fields consumed. */
type RawIssue = {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly state?: unknown;
  readonly labels?: unknown;
  readonly user?: { readonly login?: unknown };
  readonly author_association?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
  readonly html_url?: unknown;
  readonly comments?: unknown;
  /** Present iff this "issue" is really a pull request. */
  readonly pull_request?: unknown;
};

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** Label entries are objects (`{name}`) on the REST list; tolerate bare strings. */
const labelNames = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .map((l) =>
          typeof l === "string" ? l : str((l as { name?: unknown } | null)?.name ?? undefined),
        )
        .filter((n) => n.length > 0)
    : [];

const normalizeIssue = (raw: RawIssue): IssueListItem | undefined => {
  // A pull request wearing an issue's clothes — see the header.
  if (raw.pull_request !== undefined && raw.pull_request !== null) return undefined;
  if (typeof raw.number !== "number") return undefined;
  const association = str(raw.author_association, "NONE");
  return {
    number: raw.number,
    title: str(raw.title),
    body: str(raw.body),
    state: raw.state === "closed" ? "closed" : "open",
    labels: labelNames(raw.labels),
    author: str(raw.user?.login, "unknown"),
    authorAssociation: (ASSOCIATIONS.has(association) ? association : "NONE") as AuthorAssociation,
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
    url: str(raw.html_url),
    commentCount: typeof raw.comments === "number" ? raw.comments : 0,
  };
};

/** Shared by every call here. */
type IssueCallBase = {
  /** The installation access token authenticating the call. */
  readonly token: string;
  /** `"owner/repo"`. */
  readonly repo: string;
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
};

export type ListIssuesOptions = IssueCallBase & {
  /** Defaults to `open` — the state the triage desk reads. */
  readonly state?: "open" | "closed" | "all";
  /** Restrict to issues carrying every one of these labels. */
  readonly labels?: readonly string[];
  /** Only issues updated at/after this epoch-ms. */
  readonly updatedSince?: number;
  /** Page ceiling — bounds a sweep over a large backlog. Default 5 (500 issues). */
  readonly maxPages?: number;
};

const PER_PAGE = 100;
const MAX_PAGES_DEFAULT = 5;

/**
 * List issues, newest-updated first, with pull requests filtered out.
 *
 * Paginates to `maxPages` and stops early on a short page. The ceiling is a
 * bound on a scheduled sweep, not a correctness property: a backlog past it is
 * simply not read this tick, which is visible rather than silent because the
 * caller knows what it asked for.
 */
export const listIssues = async (opts: ListIssuesOptions): Promise<IssueListItem[]> => {
  const { apiBase, doFetch } = resolveClient(opts);
  const { owner, name } = splitRepo(opts.repo);
  const maxPages = opts.maxPages ?? MAX_PAGES_DEFAULT;
  const out: IssueListItem[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`${apiBase ?? API_BASE_DEFAULT}/repos/${owner}/${name}/issues`);
    url.searchParams.set("state", opts.state ?? "open");
    url.searchParams.set("sort", "updated");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));
    if (opts.labels !== undefined && opts.labels.length > 0) {
      url.searchParams.set("labels", opts.labels.join(","));
    }
    if (opts.updatedSince !== undefined) {
      url.searchParams.set("since", new Date(opts.updatedSince).toISOString());
    }

    const res = await doFetch(url.toString(), { method: "GET", headers: ghHeaders(opts.token) });
    await assertOk(res, `issue list failed for ${opts.repo}`);
    const body = (await res.json()) as RawIssue[];
    if (!Array.isArray(body)) break;
    for (const raw of body) {
      const issue = normalizeIssue(raw);
      if (issue !== undefined) out.push(issue);
    }
    if (body.length < PER_PAGE) break;
  }
  return out;
};

/** The number identifying one issue, on every write below. */
type IssueTarget = IssueCallBase & { readonly issue: number };

const issueUrl = (opts: IssueTarget, suffix = ""): string => {
  const { apiBase } = resolveClient(opts);
  const { owner, name } = splitRepo(opts.repo);
  return `${apiBase}/repos/${owner}/${name}/issues/${opts.issue}${suffix}`;
};

export type AddIssueLabelsOptions = IssueTarget & { readonly labels: readonly string[] };

/** Add labels, leaving any already present untouched (GitHub unions them). */
export const addIssueLabels = async (opts: AddIssueLabelsOptions): Promise<void> => {
  if (opts.labels.length === 0) return;
  const { doFetch } = resolveClient(opts);
  const res = await doFetch(issueUrl(opts, "/labels"), {
    method: "POST",
    headers: ghHeaders(opts.token, { json: true }),
    body: JSON.stringify({ labels: opts.labels }),
  });
  await assertOk(res, `label add failed for ${opts.repo}#${opts.issue}`);
};

export type RemoveIssueLabelOptions = IssueTarget & { readonly label: string };

/**
 * Remove one label. A label that is not on the issue answers 404, which is the
 * requested end state rather than a failure — the state machine moves a label
 * off whether or not it was on, and treating "already absent" as an error would
 * make every transition order-dependent.
 */
export const removeIssueLabel = async (opts: RemoveIssueLabelOptions): Promise<void> => {
  const { doFetch } = resolveClient(opts);
  const res = await doFetch(issueUrl(opts, `/labels/${encodeURIComponent(opts.label)}`), {
    method: "DELETE",
    headers: ghHeaders(opts.token),
  });
  if (res.status === 404) return;
  await assertOk(res, `label remove failed for ${opts.repo}#${opts.issue}`);
};

export type CreateIssueCommentOptions = IssueTarget & { readonly body: string };

/** Post one comment. The body is the caller's; this module renders nothing. */
export const createIssueComment = async (opts: CreateIssueCommentOptions): Promise<void> => {
  const { doFetch } = resolveClient(opts);
  const res = await doFetch(issueUrl(opts, "/comments"), {
    method: "POST",
    headers: ghHeaders(opts.token, { json: true }),
    body: JSON.stringify({ body: opts.body }),
  });
  await assertOk(res, `comment failed for ${opts.repo}#${opts.issue}`);
};

export type CloseIssueAsDuplicateOptions = IssueTarget & {
  /**
   * The issue number this one duplicates. **Required** — see the header: this
   * is what makes closing-on-another-verdict unrepresentable rather than
   * merely disallowed.
   */
  readonly duplicateOf: number;
};

/**
 * Close an issue as a duplicate of `duplicateOf`.
 *
 * The only close in this package, and the only one the triage desk has. GitHub
 * records `state_reason: "duplicate"`, so the *reason* survives in the timeline
 * where a reader (and a later audit) will find it, not only in whatever comment
 * the caller left.
 *
 * --- `duplicateOf` is required, and is NOT sent to GitHub ---------------------
 *
 * Requiring it in the signature is what makes "close on a non-duplicate verdict"
 * unrepresentable at the call site — that is its whole job, and it does it
 * whether or not it reaches the wire. What GitHub currently records is the
 * reason without the target; the *link* to the original reaches the issue as the
 * `#N` cross-reference in the comment the caller posts immediately before this.
 *
 * GitHub does have a parameter for the canonical target — `duplicate_issue_id`,
 * "the ID of the issue to mark as the canonical duplicate when state_reason is
 * duplicate". **It takes the issue's `id`, not its `number`.** `duplicateOf` is
 * a NUMBER (that is what the issue list carries, what the classifier names, and
 * what `knownNumbers` validates against), and the two are unrelated: ids are
 * global and in the hundreds of millions, so passing a number here would mark
 * some arbitrary unrelated issue — very likely in a different repository — as
 * the canonical original.
 *
 * So wiring it up is not a one-line change: `IssueListItem`/`IssueRef` must
 * carry `id` alongside `number`, the normalizer must read it, and the fake must
 * agree. Deliberately left for a follow-up rather than half-done here, because
 * the half-done version is silently wrong in production and green in every test.
 */
export const closeIssueAsDuplicate = async (opts: CloseIssueAsDuplicateOptions): Promise<void> => {
  const { doFetch } = resolveClient(opts);
  const res = await doFetch(issueUrl(opts), {
    method: "PATCH",
    headers: ghHeaders(opts.token, { json: true }),
    body: JSON.stringify({ state: "closed", state_reason: "duplicate" }),
  });
  await assertOk(
    res,
    `close-as-duplicate failed for ${opts.repo}#${opts.issue} (duplicate of #${opts.duplicateOf})`,
  );
};
