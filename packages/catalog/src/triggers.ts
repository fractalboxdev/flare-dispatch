// The gate recipes' request decoders (MAMEKO-RUN-010, FD-RUN-008): each takes the decoded `DispatchEvent` and answers
// `Option` of its run's input. A decoder is bound to the repository's manifest entry, so the command a run executes
// comes only from the manifest or the dispatch inputs (FD-GATE-001). This module imports no process or file API.
import { Match, Option, Schema } from "effect";
import type { DispatchEvent, WebhookDelivery } from "./dispatch-event.ts";
import {
  CheckInput,
  StackDeployRequest,
  type ImagePublishInput,
  type StackDeployInput,
  OffloadTestInput,
  OxlintInput,
  SecurityRescanInput,
  WorkerDeployInput,
  type SandboxImageInput,
  type SecurityGateBase,
  type SecurityGateInput,
} from "./inputs.ts";
import {
  globMatches,
  type GateContext,
  type GateManifest,
  type ImagePublishEntry,
  type MatrixEntry,
  type StackDeployEntry,
  type SandboxImageEntry,
  type WorkerDeployEntry,
} from "./manifest.ts";

/** The `pull_request` actions a gate answers (specs/runs/gate.md § Recipes). */
export const GATE_PR_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"] as const;

type Delivery<E extends WebhookDelivery["event"]> = Extract<WebhookDelivery, { event: E }>;

/** The gate context of a webhook a gate answers: a gate pull-request action or a merge-group check request. */
export const gateContextOf = (delivery: WebhookDelivery): Option.Option<GateContext> =>
  Match.value(delivery).pipe(
    Match.when({ event: "pull_request" }, (d: Delivery<"pull_request">) =>
      (GATE_PR_ACTIONS as readonly string[]).includes(d.action)
        ? Option.some({
            repo: d.repository.cloneUrl,
            sha: d.pullRequest.headSha,
            ref: `refs/pull/${d.pullRequest.number}/head`,
            scope: d.repository.fullName,
            pullRequest: { draft: d.pullRequest.draft, author: d.pullRequest.author },
          })
        : Option.none(),
    ),
    Match.when({ event: "merge_group" }, (d: Delivery<"merge_group">) =>
      d.action === "checks_requested"
        ? Option.some({
            repo: d.repository.cloneUrl,
            sha: d.headSha,
            ref: d.headRef,
            scope: d.repository.fullName,
          })
        : Option.none(),
    ),
    Match.orElse(() => Option.none()),
  );

/** A dispatch for `run` decodes its inputs as the run's input; any other run's dispatch is none. */
const fromDispatch =
  <S extends Schema.Codec<unknown, unknown>>(run: string, schema: S) =>
  (event: DispatchEvent): Option.Option<S["Type"]> =>
    Match.value(event).pipe(
      Match.tag("dispatch", "mcp", (e) =>
        e.run === run ? Schema.decodeUnknownOption(schema)(e.inputs) : Option.none(),
      ),
      Match.orElse(() => Option.none()),
    );

const webhook =
  <A>(f: (d: WebhookDelivery) => Option.Option<A>) =>
  (event: DispatchEvent) =>
    Match.value(event).pipe(
      Match.tag("webhook", ({ delivery }) => f(delivery)),
      Match.orElse(() => Option.none<A>()),
    );

const either =
  <A>(...decoders: readonly ((event: DispatchEvent) => Option.Option<A>)[]) =>
  (event: DispatchEvent): Option.Option<A> => {
    for (const decode of decoders) {
      const decoded = decode(event);
      if (Option.isSome(decoded)) return decoded;
    }
    return Option.none();
  };

/** `check`: one execution per manifest entry, keyed by label (FD-GATE-019, FD-GATE-020). */
export const checkDecoder = (
  entry: NonNullable<GateManifest["check"]>[number],
  skipAuthors?: readonly string[],
) =>
  either(
    webhook((d) =>
      gateContextOf(d).pipe(
        Option.map((ctx): CheckInput => ({
          ...ctx,
          ...(skipAuthors === undefined ? {} : { skipAuthors }),
          label: entry.label,
          steps: [entry],
        })),
      ),
    ),
    fromDispatch("check", CheckInput),
  );

export const oxlintDecoder = (
  entry: NonNullable<GateManifest["oxlint"]>,
  skipAuthors?: readonly string[],
) =>
  either(
    webhook((d) =>
      gateContextOf(d).pipe(
        Option.map((ctx): OxlintInput => ({
          ...ctx,
          ...(skipAuthors === undefined ? {} : { skipAuthors }),
          ...(entry.version === undefined ? {} : { version: entry.version }),
        })),
      ),
    ),
    fromDispatch("oxlint", OxlintInput),
  );

/** The `commit` dedup recipe of FD-INT-009. */
export const commitDedupKey = (run: string, scope: string, sha: string, label?: string): string =>
  `${run}${label === undefined ? "" : `:${label}`}:${scope}:${sha}`;

/** `offload-test` on a gate event, a default-branch push or a release tag push (FD-GATE-025, FD-GATE-052, -054). */
export const offloadTestDecoder = (entry: MatrixEntry, skipAuthors?: readonly string[]) =>
  either(
    webhook((d): Option.Option<OffloadTestInput> => {
      const base = {
        entry,
        ...(skipAuthors === undefined ? {} : { skipAuthors }),
        defaultBranch: d.repository.defaultBranch,
      };
      if (d.event === "push") {
        const onDefault = d.ref === `refs/heads/${d.repository.defaultBranch}`;
        const tag = d.ref.startsWith("refs/tags/");
        if (!onDefault && !(tag && entry.release === true)) return Option.none();
        return Option.some({
          ...base,
          repo: d.repository.cloneUrl,
          sha: d.after,
          ref: d.ref,
          scope: d.repository.fullName,
          parentDedupKey: commitDedupKey("offload-test", d.repository.fullName, d.after),
          trigger: onDefault ? "push-default" : "other",
        });
      }
      return gateContextOf(d).pipe(
        Option.map((ctx) => ({
          ...base,
          ...ctx,
          parentDedupKey: commitDedupKey("offload-test", d.repository.fullName, ctx.sha),
          trigger: d.event === "merge_group" ? ("merge_group" as const) : ("pull_request" as const),
          ...(d.event === "pull_request" ? { baseSha: d.pullRequest.baseSha } : {}),
        })),
      );
    }),
    fromDispatch("offload-test", OffloadTestInput),
  );

/** `worker-deploy` on a push to the deploy branch, or an Actions dispatch (FD-GATE-062). */
export const workerDeployDecoder = (entry: WorkerDeployEntry) =>
  either(
    webhook((d): Option.Option<WorkerDeployInput> => {
      if (d.event !== "push") return Option.none();
      const branch = entry.branch ?? d.repository.defaultBranch;
      return d.ref === `refs/heads/${branch}`
        ? Option.some({
            repo: d.repository.cloneUrl,
            sha: d.after,
            ref: d.ref,
            scope: d.repository.fullName,
            branch,
            entry,
          })
        : Option.none();
    }),
    fromDispatch("worker-deploy", WorkerDeployInput),
  );

/**
 * `sandbox-image` on a pull request, or a push to the default branch, that changes a path matching
 * `sandboxImage.paths`, default `infra/**` (FD-GATE-076, FD-GATE-077).
 */
export const sandboxImageDecoder = (entry: SandboxImageEntry) =>
  webhook((d): Option.Option<SandboxImageInput> => {
    const globs = entry.paths ?? ["infra/**"];
    const touches = (paths: readonly string[] | undefined) =>
      (paths ?? []).some((p) => globs.some((g) => globMatches(g, p)));
    if (d.event === "pull_request" && (GATE_PR_ACTIONS as readonly string[]).includes(d.action))
      return touches(d.changedPaths)
        ? Option.some({
            repo: d.repository.cloneUrl,
            sha: d.pullRequest.headSha,
            ref: `refs/pull/${d.pullRequest.number}/head`,
            scope: d.repository.fullName,
            entry,
            publish: false,
            executorLabels: [],
          })
        : Option.none();
    if (d.event === "push" && d.ref === `refs/heads/${d.repository.defaultBranch}`)
      return touches(d.changedPaths)
        ? Option.some({
            repo: d.repository.cloneUrl,
            sha: d.after,
            ref: d.ref,
            scope: d.repository.fullName,
            entry,
            publish: true,
            executorLabels: [],
          })
        : Option.none();
    return Option.none();
  });

/**
 * `image-publish` on a push to `imagePublish.branch` (default the default branch) that changes a path matching
 * `imagePublish.paths` (default every path), or a dispatch (FD-GATE-128). Every input field comes from the event and
 * the manifest entry; a dispatch's inputs supply none.
 */
export const imagePublishDecoder = (entry: ImagePublishEntry) =>
  either(
    webhook((d): Option.Option<ImagePublishInput> => {
      if (d.event !== "push") return Option.none();
      const branch = entry.branch ?? d.repository.defaultBranch;
      if (d.ref !== `refs/heads/${branch}`) return Option.none();
      const globs = entry.paths ?? ["**"];
      const touched = (d.changedPaths ?? []).some((p) => globs.some((g) => globMatches(g, p)));
      return touched
        ? Option.some({ scope: d.repository.fullName, sha: d.after, ref: d.ref, entry })
        : Option.none();
    }),
    (event: DispatchEvent): Option.Option<ImagePublishInput> =>
      Match.value(event).pipe(
        Match.tag("dispatch", "mcp", (e) =>
          e.run === "image-publish"
            ? Option.some({ scope: e.repo, sha: e.sha, ref: e.ref, entry })
            : Option.none(),
        ),
        Match.orElse(() => Option.none()),
      ),
  );

const branchOfRef = (ref: string): string | undefined =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;

/**
 * The `stack-deploy` input of one stack: the manifest entry labelled with the stack, the commit, and the images the
 * request supplies. The branch is `branch` of the entry, else the branch the ref names (FD-GATE-133, FD-GATE-135).
 */
export const stackDeployInputOf = (
  entry: StackDeployEntry,
  stack: string,
  context: { readonly scope: string; readonly sha: string; readonly ref: string },
  request: unknown,
): Option.Option<StackDeployInput> => {
  const branch = entry.branch ?? branchOfRef(context.ref);
  if (branch === undefined) return Option.none();
  return Option.map(Schema.decodeUnknownOption(StackDeployRequest)(request), ({ images }) => ({
    ...context,
    stack,
    branch,
    entry,
    images,
  }));
};

/**
 * `stack-deploy` on a dispatch for the entry's stack, the entry's label. The manifest entry fixes the role, the
 * project and the approval; the dispatch supplies the images alone, so no caller can drop a required approval
 * (FD-GATE-133, FD-GATE-136).
 */
export const stackDeployDecoder =
  (entry: StackDeployEntry, stack: string | null) =>
  (event: DispatchEvent): Option.Option<StackDeployInput> =>
    stack === null
      ? Option.none()
      : Match.value(event).pipe(
          Match.tag("dispatch", "mcp", (e) =>
            e.run === "stack-deploy"
              ? stackDeployInputOf(
                  entry,
                  stack,
                  { scope: e.repo, sha: e.sha, ref: e.ref },
                  e.inputs,
                )
              : Option.none(),
          ),
          Match.orElse(() => Option.none()),
        );

/** The serial group of one repository and stack (FD-GATE-134). */
export const stackDeploySerialGroup = (scope: string, stack: string): string =>
  `stack-deploy:${scope}@${stack}`;

/** The commit-scoped dedup key of FD-INT-009, shared by a push and a dispatch of one commit (FD-GATE-062). */
export const workerDeployDedupKey = (scope: string, sha: string, label?: string): string =>
  `worker-deploy${label === undefined ? "" : `:${label}`}:${scope}:${sha}`;

/** The serial group of one repository, branch and label (FD-GATE-063). */
export const workerDeploySerialGroup = (scope: string, branch: string, label?: string): string =>
  `worker-deploy:${scope}@${branch}${label === undefined ? "" : `:${label}`}`;

const branchOf = (ref: string) =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;

/**
 * `security-gate` on each pull-request action and merge-group check request its table row names (specs/runs/gate.md
 * § Recipes), whatever the pull request's author, labels or draft state (FD-GATE-085): the input carries the head and
 * where the scan range starts, and no fact a skip could read. A merge group's range starts at `merge_group.base_sha`;
 * a delivery without it starts at the merge base with the target branch. A check re-run replays the recorded input, so
 * it scans the same range. No dispatch starts it.
 */
export const securityGateDecoder = () =>
  webhook((d): Option.Option<SecurityGateInput> =>
    Match.value(d).pipe(
      Match.when({ event: "pull_request" }, (d: Delivery<"pull_request">) =>
        (GATE_PR_ACTIONS as readonly string[]).includes(d.action)
          ? Option.some({
              repo: d.repository.cloneUrl,
              sha: d.pullRequest.headSha,
              ref: `refs/pull/${d.pullRequest.number}/head`,
              scope: d.repository.fullName,
              base: {
                _tag: "TargetBranch",
                branch: d.pullRequest.baseRef,
                baseSha: d.pullRequest.baseSha,
              } satisfies SecurityGateBase,
            })
          : Option.none(),
      ),
      Match.when({ event: "merge_group" }, (d: Delivery<"merge_group">) =>
        d.action === "checks_requested"
          ? Option.some({
              repo: d.repository.cloneUrl,
              sha: d.headSha,
              ref: d.headRef,
              scope: d.repository.fullName,
              base: (d.baseSha === undefined
                ? { _tag: "TargetBranch", branch: branchOf(d.baseRef) }
                : { _tag: "MergeGroup", baseSha: d.baseSha }) satisfies SecurityGateBase,
            })
          : Option.none(),
      ),
      Match.orElse(() => Option.none()),
    ),
  );

/**
 * `security-rescan` from a dispatch alone (FD-GATE-111): a webhook, a schedule or any other trigger answers none. Its
 * input names the commit only; the range's base is the merge base with the default branch head (FD-GATE-112).
 */
export const securityRescanDecoder = () => fromDispatch("security-rescan", SecurityRescanInput);
