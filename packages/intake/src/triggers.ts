// A repository event through the manifest to admission: the commit, the manifest
// commit, the manifest's runs for the trigger, each run's request decoder, then
// one submission per run (specs/intake.md § Intake path).
import { GithubRead } from "@fractalboxdev/flare-dispatch-github";
import { Effect, Match, Option, Result } from "effect";
import { IntakeConfig, type IntakeError } from "./config.ts";
import type { DispatchEvent, RecordedTrigger, WebhookFields } from "./event.ts";
import { ManifestSource, type ManifestEntry, type RepoManifest } from "./manifest.ts";
import { ManifestReporter } from "./ports.ts";
import type { IntakeRun } from "./runs.ts";
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

export const viewOf = (entry: ManifestEntry) => ({
  label: entry.label ?? null,
  params: entry.params ?? {},
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

/** A webhook (or the sweep standing in for one) through the manifest to admission. */
export const triggerWebhook = (e: RepositoryEvent) =>
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
    if (Option.isNone(manifest)) return nothing;
    const entries = yield* entriesFor(manifest.value, e.event.event, e.repo);
    const ref = refOf(e.event.event, e.fields, defaultBranch);
    const subs = entries.flatMap(({ entry, run }) => {
      if (e.keep !== undefined && !e.keep(run, entry)) return [];
      return Option.match(run.trigger(e.event, viewOf(entry)), {
        onNone: () => [],
        onSome: (inputs) => [
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
          }),
        ],
      });
    });
    return yield* submitEach(subs);
  }).pipe(
    // A repository read that fails before the manifest is read is the same refusal as an unreadable manifest.
    Effect.catchTags({
      GithubHttpError: () => Effect.as(shed(e.repo, null, "manifest: unreadable"), nothing),
      GithubNetworkError: () => Effect.as(shed(e.repo, null, "manifest: unreadable"), nothing),
      GithubUncredentialed: () => Effect.as(shed(e.repo, null, "manifest: unreadable"), nothing),
      GithubUnexpected: () => Effect.as(shed(e.repo, null, "manifest: unreadable"), nothing),
    }),
  );
