// The gate recipes' request decoders (MAMEKO-RUN-010, FD-RUN-008): each takes the decoded `DispatchEvent` and answers
// `Option` of its run's input. A decoder is bound to the repository's manifest entry, so the command a run executes
// comes only from the manifest or the dispatch inputs (FD-GATE-001). This module imports no process or file API.
import { Match, Option, Schema } from "effect";
import type { DispatchEvent, WebhookDelivery } from "./dispatch-event.ts";
import {
  CheckInput,
  OffloadTestInput,
  OxlintInput,
  WorkerDeployInput,
  type SandboxImageInput,
} from "./inputs.ts";
import {
  globMatches,
  type GateContext,
  type GateManifest,
  type MatrixEntry,
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

/** The commit-scoped dedup key of FD-INT-009, shared by a push and a dispatch of one commit (FD-GATE-062). */
export const workerDeployDedupKey = (scope: string, sha: string, label?: string): string =>
  `worker-deploy${label === undefined ? "" : `:${label}`}:${scope}:${sha}`;

/** The serial group of one repository, branch and label (FD-GATE-063). */
export const workerDeploySerialGroup = (scope: string, branch: string, label?: string): string =>
  `worker-deploy:${scope}@${branch}${label === undefined ? "" : `:${label}`}`;
