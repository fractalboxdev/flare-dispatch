// `contextful-cache-warm` — fills the compile cache's `base` lane from each
// default-branch head, so a pull request's first gate reads compiled crates
// instead of compiling cold.
//
// The head lists its compile groups (`contextful-ci stages --parts
// --compile-groups`): one gate part per distinct set of `cargo test`
// invocations. Each group compiles through `gate --stage <part>
// --compile-only`, which runs the part's own cargo invocations with `--no-run`,
// under the same command, checkout path, install and cache wrapper as a gate
// part, because sccache keys an entry on the compile's arguments, working
// directory and `CARGO_*` environment: any difference turns every
// pull-request read into a miss. The groups spread over at most
// `WARM_CHILDREN` children of this run, each compiling its share in one
// container; a tree whose `contextful-ci` lists no groups compiles the gate's
// `workspace.compile` part in the parent's container. No part check-runs.
//
// Spec: specs/adr/0007-cost-efficient-execution.md § Base-lane warm.

import { Effect, Exit, Schema } from "effect";
import {
  ChildRuns,
  config,
  defineRun,
  github,
  handoffChildAdmission,
  io,
  RunSkipped,
  sandbox,
  spawnChildRun,
  step,
  type ChildStatusRecord,
} from "@fractalboxdev/flare-dispatch-core";
import {
  compileCacheCommand,
  compileCacheEnv,
  COMPILE_CACHE_ENDPOINT_KEY,
  COMPILE_CACHE_TOKEN_KEY,
  durableExec,
  ensureWorkspace,
  prebuildCargoBinary,
  restorePrebuilt,
  waitForChildrenDurably,
  workspace,
  type PrebuiltBinary,
  type Workspace,
} from "@fractalboxdev/flare-dispatch-core/primitives";
import {
  CI_PACKAGE,
  ciCommand,
  lightLabelsKey,
  parseLightLabels,
  parseStages,
  STAGE_TIMEOUT_SEC,
  stageCommand,
} from "./contextful-gate";

const NAME = "contextful-cache-warm";

const REPO = "fractalboxdev/contextful";
const BRANCH = "main";
const SHA40 = /^[a-f0-9]{40}$/i;
const ZERO_SHA = "0".repeat(40);

/**
 * The gate part a tree without compile groups warms: `cargo test --workspace
 * --no-run` in the workspace stage's target directory, the build every
 * `workspace.*` part links against.
 */
export const WARM_PART = "workspace.compile";

/** Children the compile groups spread over, round-robin in run order. */
export const WARM_CHILDREN = 4;
/** Queue age a run of this definition, parent or child, may wait before it starts. */
const WARM_QUEUE_SEC = 90 * 60;
/**
 * A child starts no group past this many seconds after it starts: with the last
 * group's own `STAGE_TIMEOUT_SEC`, a child ends within ~2.75 h.
 */
const GROUP_START_CUTOFF_SEC = 2 * 3600;
/** The parent's join: a child's queue age, its start cutoff and its last group's deadline. */
const CHILD_WAIT_SEC = WARM_QUEUE_SEC + GROUP_START_CUTOFF_SEC + STAGE_TIMEOUT_SEC + 600;

/** `stages --folds` lines, `<label> <member>…`, as each member's fold label. */
export const parseFolds = (stdout: string): ReadonlyMap<string, string> =>
  new Map(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length > 1)
      .flatMap(([label, ...members]) => members.map((member): [string, string] => [member, label!])),
  );

/**
 * The groups the heavy tier does not compile into `base` on this push. With
 * `gate.lightLabels:<repo>` set, a pull-request group is heavy unless it, or
 * the fold that dispatches it, is light; the heavy tier runs no nightly part.
 */
export const warmableGroups = (
  pr: readonly string[],
  nightly: readonly string[],
  folds: ReadonlyMap<string, string>,
  light: readonly string[] | null,
): readonly string[] =>
  light === null
    ? [...pr, ...nightly]
    : [...pr.filter((group) => light.includes(group) || light.includes(folds.get(group) ?? group)), ...nightly];

const Input = Schema.Struct({
  repo: Schema.Literal(REPO),
  sha: Schema.String.pipe(Schema.pattern(SHA40)),
  /** The push's `before`: the `--base` a gate part passes. */
  baseSha: Schema.String.pipe(Schema.pattern(SHA40)),
  /** The pushed head commit's timestamp in ms: the rank within the supersession group. */
  revisedAt: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  /** A child's share of the compile groups, compiled in order. Absent: the parent. */
  groups: Schema.optional(
    Schema.Array(Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/))).pipe(
      Schema.minItems(1),
      Schema.maxItems(64),
    ),
  ),
});

type InputType = Schema.Schema.Type<typeof Input>;

const Output = Schema.Struct({
  /** Each group this execution compiled, with the compile's exit code. */
  parts: Schema.Array(Schema.Struct({ part: Schema.String, exitCode: Schema.Number })),
  /** The groups past the start cutoff, left uncompiled. */
  unstarted: Schema.Array(Schema.String),
  /** The parent's children: each one's groups and terminal status. */
  children: Schema.optional(Schema.Array(Schema.Struct({ parts: Schema.Array(Schema.String), status: Schema.String }))),
});

type OutputType = Schema.Schema.Type<typeof Output>;

export const contextfulCacheWarm = defineRun({
  name: NAME,
  version: "1.1.0",
  inputs: Input,
  outputs: Output,
  triggers: [
    {
      event: "push",
      // A redelivered push, or a second push of the same head, collapses onto
      // the execution that already warmed it.
      idempotencyKey: ({ payload }) => `contextful-cache-warm:${String(payload.after ?? "")}`,
      gate: ({ payload }) =>
        payload.repository?.full_name === REPO &&
        payload.repository?.default_branch === BRANCH &&
        payload.ref === `refs/heads/${BRANCH}` &&
        typeof payload.after === "string" && SHA40.test(payload.after) && payload.after !== ZERO_SHA &&
        typeof payload.before === "string" && SHA40.test(payload.before) && payload.before !== ZERO_SHA,
      inputs: ({ payload }): InputType => {
        const revisedAt = Date.parse(String(payload.head_commit?.timestamp ?? ""));
        return {
          repo: REPO,
          sha: String(payload.after),
          baseSha: String(payload.before),
          ...(Number.isInteger(revisedAt) && revisedAt >= 0 ? { revisedAt } : {}),
        };
      },
    },
  ],
  // Only default-branch heads write `base`; the body refuses any other sha
  // before the token reaches a container.
  compileCache: () => "base",
  // A newer head cancels the older warm, queued or running, with its
  // children: its entries already written stay, and the newer head's compile
  // reads them. A child joins no group; its parent's cancellation reaches it.
  supersede: (input) =>
    input.groups !== undefined
      ? undefined
      : { group: `${NAME}:${input.repo}:${BRANCH}`, order: input.revisedAt ?? 0 },
  joinsChildren: true,
  limits: { maxDurationSec: 6 * 3600, admissionMaxQueueAgeSec: WARM_QUEUE_SEC },
  run: (input) =>
    Effect.gen(function* () {
      const child = input.groups !== undefined;
      // A configured two-tier gate compiles its heavy parts on this push into
      // `base` already; the parent warms only the light ones.
      const lightLabels = child
        ? null
        : yield* step("resolve-tiers", () =>
            config.get(lightLabelsKey(input.repo)).pipe(Effect.map((raw) => parseLightLabels(raw) ?? null)),
          );
      const current = yield* step("read-head", () =>
        github.branchHead({ repo: input.repo, branch: BRANCH }).pipe(
          Effect.map((sha): string | null => sha),
          Effect.orElseSucceed((): string | null => null),
        ),
      );
      if (current === null) {
        return yield* Effect.fail(
          new RunSkipped({ reason: `the head of ${BRANCH} could not be read; only a default-branch head writes base` }),
        );
      }
      if (current.toLowerCase() !== input.sha.toLowerCase()) {
        return yield* Effect.fail(new RunSkipped({ reason: `${input.sha} is no longer the head of ${BRANCH}` }));
      }
      // Read INLINE, as `check` does: the token is a credential and stays out
      // of checkpointed state.
      const endpoint = yield* config.get(COMPILE_CACHE_ENDPOINT_KEY);
      const token = yield* config.get(COMPILE_CACHE_TOKEN_KEY);
      if (endpoint === undefined || endpoint === "" || token === undefined || token === "") {
        return yield* Effect.fail(new RunSkipped({ reason: "compile cache not injected on this deploy" }));
      }

      const { container, dir } = yield* step("checkout", () =>
        workspace({ repo: input.repo, sha: input.sha, install: true }),
      );
      const prebuilt = yield* step(
        "prebuild-ci-binary",
        () =>
          ensureWorkspace({ current: { container, dir }, repo: input.repo, sha: input.sha, install: true }).pipe(
            Effect.flatMap((ws) => prebuildCargoBinary({ workspace: ws, pkg: CI_PACKAGE, bin: CI_PACKAGE })),
          ),
        { timeoutSec: 1920, retries: 1, retryOn: ["CheckoutFailed"] },
      ).pipe(Effect.orElseSucceed((): PrebuiltBinary | null => null));
      // A re-cloned container lost the binary; restore it as a gate part does.
      const restore = (ws: Workspace) =>
        prebuilt === null
          ? Effect.succeed(ws)
          : restorePrebuilt({ container: ws.container, dir: ws.dir, entry: prebuilt }).pipe(Effect.as(ws));
      const ensure = (ws: Workspace) =>
        ensureWorkspace({ current: ws, repo: input.repo, sha: input.sha, install: true }).pipe(
          Effect.flatMap((next) => (next === ws ? Effect.succeed(next) : restore(next))),
        );

      // Compile `groups` in order in this container, each under its own
      // deadline, starting none past the cutoff. A failed or timed-out compile
      // still leaves every entry it wrote; the gate gives the verdict.
      const compile = (groups: readonly string[], compileOnly: boolean) =>
        Effect.gen(function* () {
          const startedAt = yield* step("warm-started", () => io.now);
          let ws: Workspace = { container, dir };
          const parts: { part: string; exitCode: number }[] = [];
          const unstarted: string[] = [];
          for (const [index, part] of groups.entries()) {
            const now = yield* step(`warm-clock-${index}`, () => io.now);
            if (now - startedAt > GROUP_START_CUTOFF_SEC * 1000) {
              unstarted.push(part);
              continue;
            }
            const outcome = yield* durableExec({
              name: index === 0 ? "warm" : `warm-${index}`,
              workspace: ws,
              ensure,
              exec: (current) => ({
                cwd: current.dir,
                command: compileCacheCommand(stageCommand(part, input.baseSha, prebuilt, { compileOnly }), input.repo),
                env: compileCacheEnv({ endpoint, token }),
                redactValues: [token],
                timeoutSec: STAGE_TIMEOUT_SEC,
              }),
            }).pipe(
              Effect.map(({ result, workspace: next }) => ({ exitCode: result.exitCode, next })),
              Effect.catchTag("ExecTimeout", () => Effect.succeed({ exitCode: 124, next: ws })),
            );
            ws = outcome.next;
            if (outcome.exitCode !== 0) {
              yield* io.log("warn", `${NAME}: ${part} exited ${outcome.exitCode}; base holds what it compiled`);
            }
            parts.push({ part, exitCode: outcome.exitCode });
          }
          if (unstarted.length > 0) {
            yield* io.log("warn", `${NAME}: past the ${GROUP_START_CUTOFF_SEC / 3600} h start cutoff, left ${unstarted.join(", ")}`);
          }
          return { parts, unstarted } satisfies OutputType;
        });

      if (input.groups !== undefined) return yield* compile(input.groups, true);

      // The head's compile groups per tier, and the folds that dispatch them.
      // A tree whose `contextful-ci` lists none warms the gate's compile part.
      const listed = yield* step(
        "discover-groups",
        () =>
          ensure({ container, dir }).pipe(
            Effect.flatMap((ws) =>
              Effect.forEach(
                ["stages --parts --compile-groups --tier pr", "stages --parts --compile-groups --tier nightly", "stages --folds"],
                (args) =>
                  sandbox
                    .exec({ container: ws.container, cwd: ws.dir, command: ciCommand(args, prebuilt), timeoutSec: 1800 })
                    .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout : null))),
              ),
            ),
          ),
        { timeoutSec: 1920, retries: 3, retryOn: ["ExecFailed", "StepFailed", "CheckoutFailed"] },
      );
      const [prListed, nightlyListed, foldsListed] = listed;
      const pr = prListed === null || prListed === undefined ? undefined : parseStages(prListed);
      const nightly = nightlyListed === null || nightlyListed === undefined ? undefined : parseStages(nightlyListed);
      const folds = parseFolds(foldsListed ?? "");
      const groups =
        pr === undefined
          ? warmableGroups([WARM_PART], [], folds, lightLabels)
          : warmableGroups(pr, nightly ?? [], folds, lightLabels);
      if (groups.length === 0) {
        return yield* Effect.fail(
          new RunSkipped({ reason: "the two-tier gate's heavy tier compiles every compile group into base on this push" }),
        );
      }
      if (pr === undefined || groups.length === 1) return yield* compile(groups, pr !== undefined);

      // The parent's container and admission slot go to the children rather
      // than idling through the join. Either release failing costs capacity only.
      yield* Effect.exit(step("release-warm-container", () => sandbox.destroy({ container })));
      yield* Effect.exit(step("handoff-admission", () => handoffChildAdmission()));
      const width = Math.min(WARM_CHILDREN, groups.length);
      const chunks = Array.from({ length: width }, (_, i) => groups.filter((_, j) => j % width === i));
      const handles = yield* step("spawn-groups", () =>
        Effect.forEach(chunks, (share) => spawnChildRun({ run: NAME, input: { ...input, groups: share } }), {
          concurrency: chunks.length,
        }),
      );
      const ids = handles.map((handle) => handle.executionId);
      const waited = yield* Effect.exit(
        waitForChildrenDurably({ name: "await-groups", ids, timeout: `${CHILD_WAIT_SEC / 60} minutes` }),
      );
      // A join that outlives its deadline reads the children once more.
      const records = Exit.isSuccess(waited)
        ? waited.value
        : yield* step("settle-groups", () => Effect.flatMap(ChildRuns, (children) => children.poll({ ids }))).pipe(
            Effect.orElseSucceed(() => ids.map((executionId): ChildStatusRecord => ({ executionId, status: "missing" }))),
          );
      return {
        parts: [],
        unstarted: [],
        children: chunks.map((share, i) => ({
          parts: share,
          status: records.find((record) => record.executionId === ids[i])?.status ?? "missing",
        })),
      } satisfies OutputType;
    }),
});
