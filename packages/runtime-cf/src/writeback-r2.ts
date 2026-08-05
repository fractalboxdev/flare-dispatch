// @fractalboxdev/flare-dispatch-runtime-cf — the Worker-side writeback executor.
//
// After a run completes SUCCESSFULLY and declares `writeback`, the Dispatcher
// Worker (NOT the container) turns the container's changed-files artifact into
// a commit + PR via the GitHub App's Git Data API. The container only ever
// wrote a manifest + file blobs to R2 (under `artifacts/<exec>/writeback/…`,
// via the directory-artifact upload); it never held a git or gh credential.
//
// This module is the glue:
//
//   1. read `artifacts/<exec>/writeback/manifest.json` from R2 — absent/empty
//      ⇒ a clean no-op skip (most runs produce no diff);
//   2. validate it against the run's `WritebackSpec` (pure, in core:
//      `validateManifest` — traversal, allowlist, size cap, `.github/workflows/**`
//      gate) — sizing each entry from the R2 object metadata;
//   3. read each non-deleted blob's content from R2;
//   4. mint the installation token (injected `mintToken`) and commit via
//      `commitFilesAndOpenPr` — blob→tree→commit→ref→PR, idempotent on the head
//      branch.
//
// Plain `async` with injected deps (bucket, `mintToken`, `fetchImpl`) so it is
// unit-tested with a fake R2 + MSW, the same shape as the rest of the package's
// GitHub plumbing. The Effect side (reading App config, surfacing the typed
// `GitHubApiError`) is the dispatcher's concern.
//
// Spec: specs/02-runs.md § Writeback.

import {
  commitFilesAndOpenPr,
  getInstallationToken,
  resolveRepoInstallationId,
} from "@fractalboxdev/flare-dispatch-github-app";
import {
  decodeManifest,
  describeRejection,
  resolveHeadBranch,
  validateManifest,
  type WritebackManifest,
  type WritebackSpec,
  WRITEBACK_FILES_DIR,
  WRITEBACK_MANIFEST_FILE,
} from "@fractalboxdev/flare-dispatch-core";

/** The R2 prefix the directory artifact named `writeback` expands under. */
const writebackPrefix = (executionId: string, artifactName: string): string =>
  `artifacts/${executionId}/${artifactName}/`;

/** The outcome of a writeback attempt — reported on the run's check-run. */
export type WritebackOutcome =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reasons: readonly string[] }
  | {
      readonly kind: "committed";
      readonly created: boolean;
      readonly number?: number;
      readonly url?: string;
      readonly commitSha?: string;
      readonly files: number;
      readonly deletions: number;
    };

export type RunWritebackOptions = {
  /** The R2 bucket binding (`env.RUNS_STORAGE`). */
  readonly bucket: R2Bucket;
  /** This execution's id — namespaces the writeback artifact prefix. */
  readonly executionId: string;
  /** The run's declared writeback spec (trusted, Worker-side). */
  readonly spec: WritebackSpec;
  /** `"owner/repo"` the commit + PR target. */
  readonly repo: string;
  /**
   * The dispatch's base ref (`refs/heads/<x>` or a bare branch), used as the
   * base branch when the spec does not pin one. `undefined` ⇒ fall back to the
   * repo's default branch (resolved by `commitFilesAndOpenPr`).
   */
  readonly dispatchRef?: string;
  /**
   * Mint a fresh installation token for the repo — injected so the dispatcher
   * owns App-credential resolution (and tests stub it). Returns the token.
   */
  readonly mintToken: () => Promise<string>;
  /** The conventional writeback artifact name (default {@link WRITEBACK_ARTIFACT}). */
  readonly artifactName: string;
  /** API base override (tests / GHE). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/** Strip a leading `refs/heads/` so a dispatch ref reads as a branch name. */
const refToBranch = (ref: string): string =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;

/**
 * Read the writeback artifact for an execution and, when present + valid,
 * commit it as a PR. Returns a {@link WritebackOutcome} — never throws for an
 * absent/empty/rejected manifest (those are reported, not failures); a genuine
 * GitHub API failure propagates from `commitFilesAndOpenPr`.
 */
export const runWriteback = async (opts: RunWritebackOptions): Promise<WritebackOutcome> => {
  const prefix = writebackPrefix(opts.executionId, opts.artifactName);

  // 1. Read the manifest. Absent ⇒ the run produced no writeback — a clean skip.
  const manifestObj = await opts.bucket.get(`${prefix}${WRITEBACK_MANIFEST_FILE}`);
  if (manifestObj === null) {
    return { kind: "skipped", reason: "no writeback manifest produced" };
  }

  let manifest: WritebackManifest;
  try {
    manifest = decodeManifest(JSON.parse(await manifestObj.text()));
  } catch (cause) {
    return {
      kind: "rejected",
      reasons: [`malformed writeback manifest: ${String(cause)}`],
    };
  }

  // 2. Size each non-deleted entry from R2 object metadata (HEAD, not body) so
  //    the total-size cap is enforced before any blob content is buffered.
  const sizes = new Map<string, number>();
  for (const entry of manifest.entries) {
    if (entry.deleted === true) continue;
    const head = await opts.bucket.head(`${prefix}${WRITEBACK_FILES_DIR}/${entry.path}`);
    sizes.set(entry.path, head?.size ?? 0);
  }

  const validation = validateManifest(opts.spec, manifest, (e) => sizes.get(e.path) ?? 0);
  if (validation._kind === "empty") {
    return { kind: "skipped", reason: "writeback manifest has no entries" };
  }
  if (validation._kind === "rejected") {
    return {
      kind: "rejected",
      reasons: validation.reasons.map(describeRejection),
    };
  }

  // 3. Read each non-deleted blob's content from R2.
  const files: { path: string; content: string; mode: "100644" | "100755" }[] = [];
  const deletions: { path: string }[] = [];
  for (const entry of validation.entries) {
    if (entry.deleted) {
      deletions.push({ path: entry.path });
      continue;
    }
    const blob = await opts.bucket.get(`${prefix}${WRITEBACK_FILES_DIR}/${entry.path}`);
    if (blob === null) {
      // The manifest named a write but no blob landed — reject rather than
      // silently commit an empty file.
      return {
        kind: "rejected",
        reasons: [`writeback manifest entry "${entry.path}" has no file blob`],
      };
    }
    files.push({ path: entry.path, content: await blob.text(), mode: entry.mode });
  }

  // 4. Mint the token + commit. The head branch is the fixed bot branch (re-runs
  //    force-update it) or a fresh per-execution branch (`{ prefix }`).
  const token = await opts.mintToken();
  const headBranch = resolveHeadBranch(opts.spec.branch, opts.executionId);
  const baseBranch =
    opts.spec.baseBranch ??
    (opts.dispatchRef !== undefined ? refToBranch(opts.dispatchRef) : undefined);

  const result = await commitFilesAndOpenPr({
    token,
    repo: opts.repo,
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    headBranch,
    commitMessage: opts.spec.commitMessage,
    files,
    deletions,
    updateExisting: opts.spec.updateExisting ?? true,
    pr:
      opts.spec.pr === false
        ? false
        : {
            title: opts.spec.pr.title,
            body: opts.spec.pr.body,
            draft: opts.spec.pr.draft ?? true,
          },
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });

  if (result.skipped) {
    return {
      kind: "skipped",
      reason: `head branch "${headBranch}" already exists and updateExisting is false`,
    };
  }

  return {
    kind: "committed",
    created: result.created,
    ...(result.number !== undefined ? { number: result.number } : {}),
    ...(result.url !== undefined ? { url: result.url } : {}),
    ...(result.commitSha !== undefined ? { commitSha: result.commitSha } : {}),
    files: files.length,
    deletions: deletions.length,
  };
};

/**
 * Build the `mintToken` callback `runWriteback` needs from the App credentials
 * + the dispatch's installation id. Prefers the webhook-threaded id; falls back
 * to resolving the repo's installation from the App JWT (the App is the source
 * of truth for which installation covers a repo). Exposed here so the
 * dispatcher mints tokens without importing `@fractalboxdev/flare-dispatch-github-app`
 * directly — runtime-cf is the only seam onto the GitHub plumbing.
 */
export const makeWritebackTokenMinter = (
  appConfig: { readonly appId: string; readonly privateKeyPem: string },
  repo: string,
  installationId: number | undefined,
): (() => Promise<string>) => {
  return async () => {
    const id =
      installationId !== undefined && installationId > 0
        ? installationId
        : await resolveRepoInstallationId({
            appId: appConfig.appId,
            privateKeyPem: appConfig.privateKeyPem,
            repo,
          });
    return getInstallationToken({
      appId: appConfig.appId,
      privateKeyPem: appConfig.privateKeyPem,
      installationId: id,
    });
  };
};

/** A one-line, GitHub-check-ready summary of a writeback outcome. */
export const describeOutcome = (outcome: WritebackOutcome): string => {
  switch (outcome.kind) {
    case "skipped":
      return `writeback skipped — ${outcome.reason}`;
    case "rejected":
      return `writeback rejected — ${outcome.reasons.join("; ")}`;
    case "committed": {
      const where =
        outcome.url !== undefined ? `PR [#${outcome.number}](${outcome.url})` : "branch";
      const verb = outcome.created ? "opened" : "updated";
      return `writeback ${verb} ${where} (${outcome.files} file(s), ${outcome.deletions} deletion(s))`;
    }
  }
};
