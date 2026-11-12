// The `pr.propose` payload binding and applier, and the `pr.close` applier (specs/runs/agentic.md § Applying a staged
// write, specs/github-output.md FD-GH-082 to FD-GH-084, FD-GH-087). The applier runs `stagedWriteGate` on the row's
// manifest before any GitHub call, and a rejection ends the row `refused` while the execution's outcome stands.
import type { ApplyAnswer, IntentRow, LookupAnswer } from "@fractalboxdev/mameko-ports";
import { Context, Effect, Exit, Match, Schema } from "effect";
import { sanitizeModelText } from "../boundary.ts";
import { stagedWriteGate } from "../staged-write/gate.ts";
import {
  BRANCH_PREFIX,
  DEFAULT_MAX_BYTES,
  Manifest,
  refusalReason,
  type GateVerdict,
  type ManifestEntry,
  type StoredBlob,
  type WritebackSpec,
} from "../staged-write/manifest.ts";
import { GitData, type GitDataError, type Repo } from "./git-data.ts";

export const RepoRef = Schema.Struct({ owner: Schema.String, name: Schema.String });

/** The `pr.propose` row's payload: the manifest of one execution's accepted staged write. */
export const PrProposePayload = Schema.Struct({
  executionId: Schema.String,
  run: Schema.String,
  repo: RepoRef,
  manifest: Manifest,
});
export type PrProposePayload = typeof PrProposePayload.Type;

/** What an accepted result carries for the binding to read. */
export interface AcceptedResult {
  readonly executionId: string;
  readonly run: string;
  readonly repo: typeof RepoRef.Type;
  readonly outcome: string;
  readonly stagedWrite?: Manifest;
}

/**
 * The `prProposePayload` binding: the manifest of a `success` result that carries a staged write, else `none`, so the
 * coordinator inserts at most one `pr.propose` row per execution (FD-AGT-034, MAMEKO-OUT-058).
 */
export const prProposePayload = (
  result: AcceptedResult,
): { readonly _tag: "payload"; readonly payload: PrProposePayload } | { readonly _tag: "none" } =>
  result.outcome === "success" && result.stagedWrite !== undefined
    ? {
        _tag: "payload",
        payload: {
          executionId: result.executionId,
          run: result.run,
          repo: result.repo,
          manifest: result.stagedWrite,
        },
      }
    : { _tag: "none" };

export class StagedWriteReadFailed extends Schema.TaggedError<StagedWriteReadFailed>()(
  "StagedWriteReadFailed",
  { source: Schema.String, detail: Schema.String },
) {}

export interface LoadedBlob extends StoredBlob {
  readonly bytes: Uint8Array;
}

/** The control plane's records an applier decides on. A failed read fails the call; it never answers empty. */
export class WritebackRecords extends Context.Service<
  WritebackRecords,
  {
    /**
     * The blobs of the execution's staged write from the artifact store, each with the digest of the bytes read. When
     * the distinct blobs together exceed `maxBytes`, no bytes are read: each blob carries its stored size, empty
     * bytes, an empty digest and no text, for the gate to reject as `too-large`.
     */
    readonly blobs: (
      executionId: string,
      entries: readonly ManifestEntry[],
      maxBytes: number,
    ) => Effect.Effect<readonly LoadedBlob[], StagedWriteReadFailed>;
    /** Whether the gateway recorded a model call for the execution or the device executor reported a local one. */
    readonly modelCalls: (executionId: string) => Effect.Effect<boolean, StagedWriteReadFailed>;
    /**
     * The model entry ids that answered the execution's model calls: those in the gateway's model-call records and
     * those in the device executor's local-call report. A read that cannot answer both fails, so an empty list means
     * no model answered a call.
     */
    readonly modelEntries: (
      executionId: string,
    ) => Effect.Effect<readonly string[], StagedWriteReadFailed>;
    readonly issuedCredentials: (
      executionId: string,
    ) => Effect.Effect<readonly string[], StagedWriteReadFailed>;
  }
>()("@fractalboxdev/flare-dispatch-agentic/WritebackRecords") {}

/** The catalogue's view a writeback needs: the run's `writeback` block and whether it declares a model call site. */
export interface WritebackDeclaration {
  readonly writeback: WritebackSpec;
  readonly declaresModel: boolean;
}

export interface ApplierConfig {
  readonly writebackFor: (run: string) => WritebackDeclaration | undefined;
  /** The App's bot login, `<app slug>[bot]`; any other commit author holds the branch. */
  readonly appLogin: string;
  readonly githubHost?: string;
}

/** The trailer naming the execution in each commit the applier writes, read back by `lookup`. */
export const executionTrailer = (executionId: string) => `Flare-Dispatch-Execution: ${executionId}`;

/** The trailer naming the model entries that drafted a model-authored commit, each id once, in sorted order. */
export const draftedWithTrailer = (modelEntryIds: readonly string[]) =>
  `Drafted-With: ${[...new Set(modelEntryIds)].sort().join(", ")}`;

const DRAFTED_WITH_LINE = /^[ \t]*drafted-with[ \t]*:/i;

/**
 * The commit message: the manifest's message without any `Drafted-With:` line of its own, then one trailer block. A
 * commit whose records name a model entry carries `Drafted-With:` with the ids the records hold, so the manifest, which
 * the run returns, supplies none of them (FD-AGT-040).
 */
export const commitMessage = (
  message: string,
  executionId: string,
  modelEntryIds: readonly string[],
) =>
  [
    message
      .split("\n")
      .filter((line) => !DRAFTED_WITH_LINE.test(line))
      .join("\n")
      .trimEnd(),
    "",
    ...(modelEntryIds.length > 0 ? [draftedWithTrailer(modelEntryIds)] : []),
    executionTrailer(executionId),
  ].join("\n");

const decodePayload = Schema.decodeUnknownExit(PrProposePayload);

/** The bytes as UTF-8 text, or null when they are not valid UTF-8. */
export const textOf = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
};

const fromGitError = (e: GitDataError): ApplyAnswer =>
  e.status === 0 || e.status === 429 || e.status >= 500
    ? { _tag: "retryable", reason: `github ${e.call}: ${e.status}` }
    : { _tag: "refused", reason: `writeback: github-refused; ${e.call} ${e.status}` };

const repoOf = (row: IntentRow, payload: PrProposePayload): Repo => ({
  scopeId: row.scopeId,
  owner: payload.repo.owner,
  name: payload.repo.name,
});

/** Whether the branch holds a commit since the base whose author is not the App (FD-GH-084, FD-GH-087). */
const humanCommits = (repo: Repo, base: string, head: string, appLogin: string) =>
  Effect.gen(function* () {
    const git = yield* GitData;
    const commits = yield* git.commitsSince(repo, base, head);
    return commits.some((c) => c.authorLogin !== appLogin);
  });

/** A write is model-authored when the recipe declares a model call site or the records hold a model call. */
const modelAuthorship = (declaration: WritebackDeclaration, executionId: string) =>
  Effect.gen(function* () {
    if (declaration.declaresModel) return true;
    const records = yield* WritebackRecords;
    return yield* records.modelCalls(executionId);
  });

/**
 * Runs `stagedWriteGate` on a manifest with the blobs read back from the artifact store. The first verdict treats
 * every blob line as added, so no GitHub call precedes it; only a reason on a blob line can change once the base
 * commit's text is known, so for those files the base is read and the gate runs again, before any write.
 */
export const gateStagedWrite = (input: {
  readonly executionId: string;
  readonly repo: Repo;
  readonly manifest: Manifest;
  readonly writeback: WritebackSpec;
  readonly modelAuthored: boolean;
  readonly githubHost: string;
}) =>
  Effect.gen(function* () {
    const records = yield* WritebackRecords;
    const git = yield* GitData;
    const { manifest } = input;
    const blobs = yield* records.blobs(
      input.executionId,
      manifest.entries,
      input.writeback.maxBytes ?? DEFAULT_MAX_BYTES,
    );
    const issued = yield* records.issuedCredentials(input.executionId);
    const runGate = (baseText: (path: string) => string | null) =>
      stagedWriteGate(manifest, input.writeback, input.modelAuthored, {
        blobs,
        baseText,
        issuedCredentials: issued,
        githubHost: input.githubHost,
      });
    const verdict = yield* Match.value(runGate(() => null)).pipe(
      Match.tag("accept", (v) => Effect.succeed<GateVerdict>(v)),
      Match.tag("reject", (v) =>
        Effect.gen(function* () {
          const lineScoped = [
            ...new Set(
              v.reasons
                .filter(
                  (r) => r.line !== undefined && manifest.entries.some((e) => e.path === r.path),
                )
                .map((r) => r.path as string),
            ),
          ];
          if (lineScoped.length === 0) return v as GateVerdict;
          const baseTexts = new Map<string, string | null>();
          for (const path of lineScoped) {
            const bytes = yield* git.fileAt(input.repo, manifest.baseCommit, path);
            baseTexts.set(path, bytes === null ? null : textOf(bytes));
          }
          return runGate((path) => baseTexts.get(path) ?? null);
        }),
      ),
      Match.exhaustive,
    );
    return { verdict, blobs };
  });

/**
 * `apply` on a `pr.propose` row: decode, gate, then blobs, tree and commit on the base commit, the branch ref, and the
 * pull request reused or opened (FD-AGT-016, FD-AGT-018, FD-AGT-035, FD-GH-082 to FD-GH-084). A model-authored
 * commit carries the `Drafted-With:` trailer from `WritebackRecords.modelEntries`, read before any GitHub call
 * (FD-AGT-040), and a model-authored pull request's title and body pass through `sanitizeModelText` first (FD-AGT-041).
 */
export const applyPrPropose = (config: ApplierConfig) => (row: IntentRow) =>
  Effect.gen(function* () {
    const decoded = decodePayload(row.payload);
    if (Exit.isFailure(decoded))
      return { _tag: "refused", reason: "writeback: payload-invalid" } satisfies ApplyAnswer;
    const payload = decoded.value;
    const { manifest } = payload;
    const declaration = config.writebackFor(payload.run);
    if (declaration === undefined)
      return { _tag: "refused", reason: "writeback: no-writeback-block" } satisfies ApplyAnswer;

    const git = yield* GitData;
    const repo = repoOf(row, payload);
    const modelAuthored = yield* modelAuthorship(declaration, payload.executionId);
    const modelEntries = modelAuthored
      ? yield* Effect.flatMap(WritebackRecords, (records) =>
          records.modelEntries(payload.executionId),
        )
      : [];
    const { verdict, blobs } = yield* gateStagedWrite({
      executionId: payload.executionId,
      repo,
      manifest,
      writeback: declaration.writeback,
      modelAuthored,
      githubHost: config.githubHost ?? "github.com",
    });
    if (verdict._tag === "reject")
      return { _tag: "refused", reason: refusalReason(verdict.reasons) } satisfies ApplyAnswer;

    const defaultBranch = yield* git.defaultBranch(repo);
    if (
      !manifest.branch.startsWith(BRANCH_PREFIX) ||
      manifest.branch === defaultBranch ||
      (yield* git.branchProtected(repo, manifest.branch))
    )
      return { _tag: "refused", reason: "writeback: branch-invalid" } satisfies ApplyAnswer;

    const existing = yield* git.refSha(repo, manifest.branch);
    if (
      existing !== null &&
      (yield* humanCommits(repo, manifest.baseCommit, existing, config.appLogin))
    )
      return { _tag: "refused", reason: "writeback: human-commits-present" } satisfies ApplyAnswer;

    const byPath = new Map(blobs.map((b) => [b.path, b]));
    const tree = [];
    for (const entry of manifest.entries) {
      const blob = byPath.get(entry.path) as LoadedBlob;
      tree.push({
        path: entry.path,
        mode: entry.mode,
        sha: yield* git.createBlob(repo, blob.bytes),
      });
    }
    const baseTree = (yield* git.commit(repo, manifest.baseCommit)).tree;
    const treeSha = yield* git.createTree(repo, baseTree, tree);
    const commitSha = yield* git.createCommit(repo, {
      message: commitMessage(manifest.message, payload.executionId, modelEntries),
      tree: treeSha,
      parents: [manifest.baseCommit],
    });
    if (existing === null) yield* git.createRef(repo, manifest.branch, commitSha);
    else yield* git.updateRef(repo, manifest.branch, commitSha);

    const text = modelAuthored
      ? { title: sanitizeModelText(manifest.pr.title), body: sanitizeModelText(manifest.pr.body) }
      : { title: manifest.pr.title, body: manifest.pr.body };
    const open = yield* git.openPull(repo, manifest.branch);
    const pull =
      open ??
      (yield* git.createPull(repo, {
        head: manifest.branch,
        base: manifest.baseBranch,
        ...text,
        draft: manifest.pr.draft,
      }));
    if (open !== null) yield* git.updatePull(repo, open.number, text);
    yield* git.addLabels(repo, pull.number, manifest.pr.labels);
    return { _tag: "applied", externalRef: pull.url } satisfies ApplyAnswer;
  }).pipe(
    Effect.catchTags({
      GitDataError: (e) => Effect.succeed(fromGitError(e)),
      StagedWriteReadFailed: (e) =>
        Effect.succeed({
          _tag: "retryable",
          reason: `writeback: read ${e.source}`,
        } satisfies ApplyAnswer),
    }),
  );

/** `lookup` on a `pr.propose` row: found when the branch head is the applier's commit for this execution. */
export const lookupPrPropose = (row: IntentRow) =>
  Effect.gen(function* () {
    const decoded = decodePayload(row.payload);
    if (Exit.isFailure(decoded)) return { _tag: "absent" } satisfies LookupAnswer;
    const payload = decoded.value;
    const git = yield* GitData;
    const repo = repoOf(row, payload);
    const head = yield* git.refSha(repo, payload.manifest.branch);
    if (head === null) return { _tag: "absent" } satisfies LookupAnswer;
    const commit = yield* git.commit(repo, head);
    if (!commit.message.includes(executionTrailer(payload.executionId)))
      return { _tag: "absent" } satisfies LookupAnswer;
    const pull = yield* git.openPull(repo, payload.manifest.branch);
    return pull === null
      ? ({ _tag: "absent" } satisfies LookupAnswer)
      : ({ _tag: "found", externalRef: pull.url } satisfies LookupAnswer);
  }).pipe(
    Effect.catchTag("GitDataError", (e) =>
      Effect.succeed({
        _tag: "undetermined",
        reason: `github ${e.call}: ${e.status}`,
      } satisfies LookupAnswer),
    ),
  );

export const PrClosePayload = Schema.Struct({
  repo: RepoRef,
  branch: Schema.String,
  base: Schema.String,
});

const decodeClose = Schema.decodeUnknownExit(PrClosePayload);

/**
 * `apply` on a `pr.close` row: closes the open pull request only when its head branch is under `flare-dispatch/` and
 * carries no commit whose author is not the App (FD-GH-087).
 */
export const applyPrClose = (config: Pick<ApplierConfig, "appLogin">) => (row: IntentRow) =>
  Effect.gen(function* () {
    const decoded = decodeClose(row.payload);
    if (Exit.isFailure(decoded))
      return { _tag: "refused", reason: "writeback: payload-invalid" } satisfies ApplyAnswer;
    const { repo: r, branch, base } = decoded.value;
    const repo: Repo = { scopeId: row.scopeId, owner: r.owner, name: r.name };
    const git = yield* GitData;
    if (!branch.startsWith(BRANCH_PREFIX))
      return { _tag: "refused", reason: "writeback: branch-invalid" } satisfies ApplyAnswer;
    const pull = yield* git.openPull(repo, branch);
    if (pull === null)
      return { _tag: "applied", externalRef: `closed:${branch}` } satisfies ApplyAnswer;
    const head = yield* git.refSha(repo, branch);
    const baseSha = yield* git.refSha(repo, base);
    if (
      head !== null &&
      baseSha !== null &&
      (yield* humanCommits(repo, baseSha, head, config.appLogin))
    )
      return { _tag: "refused", reason: "writeback: human-commits-present" } satisfies ApplyAnswer;
    yield* git.closePull(repo, pull.number);
    return { _tag: "applied", externalRef: pull.url } satisfies ApplyAnswer;
  }).pipe(Effect.catchTag("GitDataError", (e) => Effect.succeed(fromGitError(e))));

/** A refusal's reasons as the execution's dashboard page lists them (FD-AGT-018, FD-AGT-038). */
export const refusalView = (
  lastError: string,
): { readonly firstKind: string; readonly reasons: readonly string[] } | null => {
  const match = /^writeback: ([^;]+)(?:; (.*))?$/.exec(lastError);
  if (match === null) return null;
  const first = match[1] as string;
  return { firstKind: first, reasons: match[2] === undefined ? [first] : match[2].split("; ") };
};

/** The answer kinds the outbox reads; exported so a composite applier can route by kind. */
export const answerKind = Match.type<ApplyAnswer>().pipe(
  Match.tagsExhaustive({
    applied: () => "applied" as const,
    refused: () => "refused" as const,
    retryable: () => "retryable" as const,
    unknown: () => "unknown" as const,
  }),
);
