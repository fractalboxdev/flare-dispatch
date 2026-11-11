// The staged write: the manifest an execution proposes, the recipe's `writeback` block, and the gate's reasons
// (specs/runs/agentic.md § Model, § Staged write).
import { Schema } from "effect";

/** The prefix the drain enforces on every staged-write branch (FD-AGT-028, FD-GH-082). */
export const BRANCH_PREFIX = "flare-dispatch/";

/** The `maxFiles` default (FD-AGT-025). */
export const DEFAULT_MAX_FILES = 200;

/** The `maxBytes` default, 5 MiB (FD-AGT-026). */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

/** One file of a staged write: its path, its git mode and the SHA-256 digest of its blob. */
export const ManifestEntry = Schema.Struct({
  path: Schema.String,
  mode: Schema.String,
  digest: Sha256,
});
export type ManifestEntry = typeof ManifestEntry.Type;

export const PullRequestFields = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  draft: Schema.Boolean,
  labels: Schema.Array(Schema.String),
});
export type PullRequestFields = typeof PullRequestFields.Type;

/** The manifest of a staged write; its blobs live in the artifact store under the execution. */
export const Manifest = Schema.Struct({
  branch: Schema.String,
  baseBranch: Schema.String,
  baseCommit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  message: Schema.String,
  pr: PullRequestFields,
  entries: Schema.Array(ManifestEntry),
});
export type Manifest = typeof Manifest.Type;

/** The artifact name of a staged write's manifest inside the execution's artifact prefix (FD-AGT-013). */
export const STAGED_WRITE_MANIFEST = "staged-write/manifest.json";

/** The artifact name of one staged blob inside the execution's artifact prefix, keyed by its SHA-256 digest. */
export const stagedBlobName = (digest: string) => `staged-write/blobs/${digest}`;

/** A recipe's `writeback` block (specs/runs/agentic.md § Model). */
export const WritebackSpec = Schema.Struct({
  branch: Schema.String,
  baseBranch: Schema.String,
  /** Globs relative to the repository root; `*` stays inside one segment and `**` spans segments. */
  allowlist: Schema.Array(Schema.String),
  allowSensitivePaths: Schema.Boolean,
  allowWorkflows: Schema.Boolean,
  maxFiles: Schema.optionalKey(Schema.Number),
  maxBytes: Schema.optionalKey(Schema.Number),
  /** Hosts a model-authored text may link to, beside the repository's GitHub host (FD-AGT-031). */
  linkAllowlist: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type WritebackSpec = typeof WritebackSpec.Type;

export const REASON_KINDS = [
  "path-invalid",
  "protected-path",
  "workflows-not-opted-in",
  "sensitive-not-opted-in",
  "outside-allowlist",
  "too-many-files",
  "too-large",
  "mode-invalid",
  "branch-invalid",
  "digest-mismatch",
  "blob-missing",
  "secret-detected",
  "url-not-allowed",
  "encoded-run",
] as const;
export type ReasonKind = (typeof REASON_KINDS)[number];

/**
 * One rejection reason. `path` names the entry, or `message`, `pr.title` or `pr.body` for a text field; `line` is
 * 1-based. A reason never carries the matched value (FD-AGT-030).
 */
export const GateReason = Schema.Struct({
  kind: Schema.Literals(REASON_KINDS),
  path: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Number),
  detail: Schema.optionalKey(Schema.String),
});
export type GateReason = typeof GateReason.Type;

export type GateVerdict =
  | { readonly _tag: "accept" }
  | { readonly _tag: "reject"; readonly reasons: readonly GateReason[] };

/** One blob as the applier read it back from the artifact store, with the digest of the bytes it read. */
export interface StoredBlob {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
  /** The blob as UTF-8 text, or null for a binary blob. */
  readonly text: string | null;
}

/** What the gate reads besides the manifest: the stored blobs, the base commit's files and the issued credentials. */
export interface GateEvidence {
  readonly blobs: readonly StoredBlob[];
  /** A file's text at the base commit, or null when it is absent or binary there. */
  readonly baseText: (path: string) => string | null;
  /** Credentials the control plane issued to the execution (FD-AGT-029). */
  readonly issuedCredentials: readonly string[];
  /** The repository's GitHub host, always in the link allowlist (FD-AGT-031). */
  readonly githubHost: string;
}

/** The text of a refusal: `writeback: <first reason kind>`, then every reason (FD-AGT-018). */
export const refusalReason = (reasons: readonly GateReason[]): string => {
  const first = reasons[0]?.kind ?? "rejected";
  const listed = reasons.map(
    (r) =>
      `${r.kind}${r.path === undefined ? "" : ` ${r.path}`}${r.line === undefined ? "" : `:${r.line}`}${
        r.detail === undefined ? "" : ` (${r.detail})`
      }`,
  );
  return `writeback: ${first}; ${listed.join("; ")}`;
};
