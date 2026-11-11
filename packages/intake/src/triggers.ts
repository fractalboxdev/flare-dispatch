// A repository event through the manifest to admission: the commit, the manifest
// commit, the manifest's runs for the trigger, each run's request decoder, then
// one submission per run (specs/intake.md § Intake path).
import { GithubRead } from "@fractalboxdev/flare-dispatch-github";
import { Effect, Match, Option, Result } from "effect";
import { IntakeConfig, type IntakeError } from "./config.ts";
import {
  cacheTriggerOf,
  protectableRefOf,
  type DispatchEvent,
  type RecordedTrigger,
  type WebhookFields,
} from "./event.ts";
import { ManifestSource, type ManifestEntry, type RepoManifest } from "./manifest.ts";
import { ManifestReporter } from "./ports.ts";
import { isUnavailable, ProtectionSnapshots } from "./protection.ts";
import type { EntryView, IntakeRun } from "./runs.ts";
import { shed, submission, submit, type Admitted, type Submission } from "./submit.ts";

/** Where the manifest is read: a branch's head, or one commit (FD-INT-016). */
export type ManifestAt =
  | { readonly _tag: "BranchHead"; readonly branch: string }
  | { readonly _tag: "Commit"; readonly sha: string };

const branchOf = (ref: string) =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;

/**
 * The base branch head for `pull_request` and `merge_group`, the pushed commit for a push to the default branch, and
 * the default branch head for every other trigger (FD-INT-016).
 */
export const manifestAt = (event: string, f: WebhookFields, defaultBranch: string): ManifestAt => {
  if (event === "pull_request" && f.pull_request !== undefined)
    return { _tag: "BranchHead", branch: f.pull_request.base.ref };
  if (event === "merge_group" && f.merge_group?.base_ref !== undefined)
    return { _tag: "BranchHead", branch: branchOf(f.merge_group.base_ref) };
  if (event === "push" && f.ref === `refs/heads/${defaultBranch}` && f.after !== undefined)
    return { _tag: "Commit", sha: f.after };
  return { _tag: "BranchHead", branch: defaultBranch };
};

/** A branch push's branch, a tag push's tag, a pull request's head branch, else the default branch. */
export const refOf = (event: string, f: WebhookFields, defaultBranch: string) => {
  if (f.pull_request?.head.ref !== undefined) return `refs/heads/${f.pull_request.head.ref}`;
  if (event === "merge_group" && f.merge_group?.base_ref !== undefined)
    return f.merge_group.base_ref;
  if (f.ref !== undefined) return f.ref;
  return `refs/heads/${defaultBranch}`;
};

const READONLY_QUEUE = /^refs\/heads\/gh-readonly-queue\/(.+)\/pr-\d+-[0-9a-f]+$/;

/**
 * The branch whose required set decides a gating run: a pull request's base, a merge group's base, or the base a
 * `gh-readonly-queue/<base>/pr-<number>-<sha>` push names; null for every other event.
 */
export const targetBranchOf = (event: string, f: WebhookFields): string | null => {
  if (event === "pull_request" && f.pull_request !== undefined) return f.pull_request.base.ref;
  if (event === "merge_group" && f.merge_group?.base_ref !== undefined)
    return branchOf(f.merge_group.base_ref);
  if (event === "push" && f.ref !== undefined) return READONLY_QUEUE.exec(f.ref)?.[1] ?? null;
  return null;
};

/** What one trigger did: the executions it reached, and whether every one already existed. */
export interface TriggerOutcome {
  readonly executions: readonly string[];
  readonly duplicate: boolean;
  /** The first `intake_unavailable` among the submissions, which the caller answers `503` (FD-INT-004). */
  readonly unavailable: IntakeError | null;
}

export const nothing: TriggerOutcome = { executions: [], duplicate: false, unavailable: null };

const outcomeOf = (results: readonly Result.Result<Admitted, IntakeError>[]): TriggerOutcome => {
  const admitted = results.flatMap((r) => Option.toArray(Result.getSuccess(r)));
  const unavailable =
    results
      .flatMap((r) => Option.toArray(Result.getFailure(r)))
      .find((e) => e.code === "intake_unavailable") ?? null;
  return {
    executions: admitted.map((a) => a.executionId),
    duplicate: admitted.length > 0 && admitted.every((a) => a.duplicate),
    unavailable,
  };
};

/** Submits each submission; a refusal ends intake for that (trigger, run) pair only. */
export const submitEach = (subs: readonly Submission[]) =>
  Effect.forEach(subs, (s) =>
    submit(s).pipe(
      Effect.map((a) => Result.succeed(a) as Result.Result<Admitted, IntakeError>),
      Effect.catchTag("IntakeError", (e) =>
        Effect.succeed(Result.fail(e) as Result.Result<Admitted, IntakeError>),
      ),
    ),
  ).pipe(Effect.map(outcomeOf));

/**
 * The manifest at a commit, or why intake stops: an absent manifest stops silently (FD-INT-020); an unreadable one
 * records `manifest: unreadable` (FD-INT-019); an invalid one records `manifest: invalid` and posts the
 * `flare-dispatch/manifest` check run (FD-INT-018).
 */
export const readManifest = (repo: string, sha: string) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const read = yield* (yield* ManifestSource).read(repo, sha, config.catalog);
    return yield* Match.value(read).pipe(
      Match.tag("Valid", ({ manifest }) => Effect.succeed(Option.some(manifest))),
      Match.tag("Absent", () => Effect.succeed(Option.none<RepoManifest>())),
      Match.tag("Unreadable", () =>
        Effect.as(shed(repo, null, "manifest: unreadable"), Option.none<RepoManifest>()),
      ),
      Match.tag("Invalid", ({ errors }) =>
        Effect.gen(function* () {
          yield* shed(repo, null, "manifest: invalid");
          yield* (yield* ManifestReporter).invalid(repo, sha, errors);
          return Option.none<RepoManifest>();
        }),
      ),
      Match.exhaustive,
    );
  });

/** The manifest's entries that list the trigger, whose recipe the catalogue serves and the operator policy allows. */
export const entriesFor = (manifest: RepoManifest, trigger: string, repo: string) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    return manifest.runs.flatMap((entry) => {
      const run = config.catalog(entry.recipe);
      return run !== undefined && entry.triggers.includes(trigger) && config.allows(repo, run.name)
        ? [{ entry, run }]
        : [];
    });
  });

/** One entry as its run's request decoder sees it, with the manifest's `skipAuthors`. */
export const viewOf = (entry: ManifestEntry, manifest: RepoManifest): EntryView => ({
  label: entry.label ?? null,
  params: entry.params ?? {},
  ...(manifest.skipAuthors === undefined ? {} : { skipAuthors: manifest.skipAuthors }),
});

export interface RepositoryEvent {
  readonly event: DispatchEvent & { readonly _tag: "webhook" };
  readonly fields: WebhookFields;
  readonly repo: string;
  readonly trigger: RecordedTrigger;
  /** Keeps only the entries this event may submit, as the merge-queue filter does (FD-GH-075). */
  readonly keep?: (run: IntakeRun, entry: ManifestEntry) => boolean;
  /** The webhook's commit (FD-INT-028). */
  readonly sha: string;
}

/**
 * The submissions a webhook (or the sweep standing in for one) makes, one per manifest entry that answers it, in
 * manifest order; none when the manifest is absent, unreadable or invalid.
 */
export const webhookSubmissions = (e: RepositoryEvent) =>
  Effect.gen(function* () {
    const github = yield* GithubRead;
    const defaultBranch = yield* github.defaultBranch(e.repo);
    const at = manifestAt(e.event.event, e.fields, defaultBranch);
    const manifestSha = yield* Match.value(at).pipe(
      Match.tag("Commit", ({ sha }) => Effect.succeed(sha)),
      Match.tag("BranchHead", ({ branch }) => github.branchHead(e.repo, branch)),
      Match.exhaustive,
    );
    const manifest = yield* readManifest(e.repo, manifestSha);
    if (Option.isNone(manifest)) return [];
    const entries = yield* entriesFor(manifest.value, e.event.event, e.repo);
    const ref = refOf(e.event.event, e.fields, defaultBranch);
    const answering = entries.flatMap(({ entry, run }) => {
      if (e.keep !== undefined && !e.keep(run, entry)) return [];
      return Option.match(run.trigger(e.event, viewOf(entry, manifest.value), { defaultBranch }), {
        onNone: () => [],
        onSome: (inputs) => [{ entry, run, inputs }],
      });
    });
    if (answering.length === 0) return [];
    // A push's protection decides whether it is a protected trigger and a release trigger. Off the default branch an
    // unreadable answer submits nothing rather than record the push as unprotected; on the default branch, which is a
    // protected trigger regardless, it leaves the protection unknown.
    const pushed = protectableRefOf(e.event.event, e.fields);
    const read =
      pushed === null ? null : yield* (yield* ProtectionSnapshots).refProtected(e.repo, pushed);
    // Protection decides cache writes only, and an unprotected trigger writes no protected tier, so a push whose
    // protection does not read runs as unprotected rather than not at all.
    if (isUnavailable(read) && pushed !== `refs/heads/${defaultBranch}`)
      yield* Effect.logWarning("push protection unreadable; running as an unprotected trigger", {
        repo: e.repo,
        ref: pushed,
        reason: read.reason,
      });
    const refProtection = isUnavailable(read) ? null : read;
    const cacheTrigger = cacheTriggerOf(
      e.event.event,
      e.fields,
      defaultBranch,
      refProtection === true,
    );
    const targetBranch = targetBranchOf(e.event.event, e.fields);
    return answering.map(({ entry, run, inputs }) =>
      submission({
        run,
        trigger: e.trigger,
        event: e.event.event,
        label: entry.label ?? null,
        repo: e.repo,
        sha: e.sha,
        ref,
        inputs,
        installation: e.fields.installation?.id ?? null,
        cacheTrigger,
        defaultBranch,
        targetBranch,
        refProtection,
      }),
    );
  }).pipe(
    // A repository read that fails before the manifest is read is the same refusal as an unreadable manifest.
    Effect.catchTags({
      GithubHttpError: () => unreadable(e.repo),
      GithubNetworkError: () => unreadable(e.repo),
      GithubUncredentialed: () => unreadable(e.repo),
      GithubUnexpected: () => unreadable(e.repo),
    }),
  );

const unreadable = (repo: string) =>
  Effect.as(shed(repo, null, "manifest: unreadable"), [] as readonly Submission[]);

/** A webhook (or the sweep standing in for one) through the manifest to admission. */
export const triggerWebhook = (e: RepositoryEvent) =>
  Effect.flatMap(webhookSubmissions(e), submitEach);
