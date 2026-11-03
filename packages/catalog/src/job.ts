// One gate job: a checkout of the execution's commit in a fresh workspace, an optional install, the job command, the
// verdict, and the redacted log uploaded before the verdict returns (specs/runs/gate.md § Exit to verdict).
import { Effect, Option, Schema, type Scope } from "effect";
import { CommandExit, GateExec } from "./command.ts";
import { redactLog } from "./egress.ts";
import { DEFAULT_JOB_TIMEOUT_SEC, GATE_JOB_MAX_DURATION_SEC, type GateJobInput } from "./inputs.ts";
import {
  globMatches,
  pullRequestSkip,
  timeoutProblem,
  type GateContext,
  type Writeback,
} from "./manifest.ts";
import { GateArtifacts, GateCache, type CacheEntry } from "./ports.ts";
import { isSuccess, Outcome } from "./reasons.ts";
import { installVerdictOf, verdictOf } from "./verdict.ts";

/** The job timeout of an install command (FD-GATE-027). */
export const INSTALL_TIMEOUT_SEC = 600;
const CHECKOUT_TIMEOUT_SEC = 600;

/** The job environment names only what a job needs; it carries no secret of the executor's (FD-GATE-014). */
const INHERITED_ENV = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "PNPM_HOME"] as const;

/** A gate job's environment: the inherited basics, `FD_REPO`, `FD_SHA`, `FD_REF` and `FD_JOB` (FD-GATE-013). */
export const jobEnv = (
  ctx: GateContext,
  job: string,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> => ({
  ...Object.fromEntries(
    INHERITED_ENV.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  ),
  ...extra,
  CI: "true",
  GIT_TERMINAL_PROMPT: "0",
  FD_REPO: ctx.repo,
  FD_SHA: ctx.sha,
  FD_REF: ctx.ref,
  FD_JOB: job,
});

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * A shallow fetch of the one commit, so a commit no branch reaches still resolves. Submodules resolve over HTTPS,
 * because a job holds no SSH credential.
 */
const checkoutScript = (ctx: GateContext): string =>
  [
    "git init -q .",
    `git remote add origin ${shellQuote(ctx.repo)}`,
    `git fetch -q --depth 1 origin ${ctx.sha}`,
    "git -c advice.detachedHead=false checkout -q --detach FETCH_HEAD",
    `git config url.https://github.com/.insteadOf git@github.com:`,
    "git submodule update -q --init --recursive --depth 1",
  ].join(" && ");

/** The commit never reached the workspace: an infrastructure failure, not a finding about the commit. */
export class CheckoutFailed extends Schema.TaggedError<CheckoutFailed>()("CheckoutFailed", {
  detail: Schema.String,
}) {}

/** A fresh workspace holding the execution's commit. */
export const checkedOutWorkspace = (
  ctx: GateContext,
): Effect.Effect<string, CheckoutFailed, GateExec | Scope.Scope> =>
  Effect.gen(function* () {
    const exec = yield* GateExec;
    const dir = yield* exec.workspace;
    const { exit } = yield* exec.run({
      command: checkoutScript(ctx),
      cwd: dir,
      env: jobEnv(ctx, "checkout"),
      timeoutMs: CHECKOUT_TIMEOUT_SEC * 1000,
      ...(ctx.deadlineAt === undefined ? {} : { deadlineAt: ctx.deadlineAt }),
    });
    if (!CommandExit.$is("Exited")(exit) || exit.code !== 0)
      return yield* new CheckoutFailed({
        detail: CommandExit.$is("Exited")(exit) ? `exit ${exit.code}` : exit._tag,
      });
    return dir;
  });

/** One command's outcome and the text of its output. */
export interface StepRun {
  readonly outcome: Outcome;
  readonly output: string;
}

const decoder = new TextDecoder();

/** Runs one command and maps its end to an outcome. */
export const runStep = (options: {
  readonly ctx: GateContext;
  readonly job: string;
  readonly command: string;
  readonly cwd: string;
  readonly timeoutSec: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly install?: boolean;
  readonly lint?: boolean;
}): Effect.Effect<StepRun, never, GateExec> =>
  Effect.gen(function* () {
    const exec = yield* GateExec;
    process.stderr.write(`[${options.job}] ${options.command}\n`);
    const run = yield* exec.run({
      command: options.command,
      cwd: options.cwd,
      env: jobEnv(options.ctx, options.job, options.env),
      timeoutMs: options.timeoutSec * 1000,
      ...(options.ctx.deadlineAt === undefined ? {} : { deadlineAt: options.ctx.deadlineAt }),
    });
    // An output past the limit yields no verdict from its contents (FD-GATE-008).
    const output = CommandExit.$is("OverLimit")(run.exit) ? "" : decoder.decode(run.output);
    const outcome =
      options.install === true
        ? installVerdictOf(run.exit)
        : verdictOf(run.exit, { output, ...(options.lint === true ? { lint: true } : {}) });
    return { outcome, output };
  });

/**
 * Uploads `<job key>.log` with every token shape redacted (FD-GATE-011). A failed upload changes nothing about the
 * verdict (FD-GATE-012).
 */
export const uploadLog = (job: string, output: string): Effect.Effect<void, never, GateArtifacts> =>
  Effect.gen(function* () {
    const artifacts = yield* GateArtifacts;
    yield* artifacts
      .upload(`${job}.log`, new TextEncoder().encode(redactLog(output)))
      .pipe(
        Effect.catchTag("ArtifactUploadFailed", (e) =>
          Effect.sync(() => process.stderr.write(`[${job}] log upload failed: ${e.detail}\n`)),
        ),
      );
  });

const withCache = <A, E, R>(
  input: GateJobInput,
  dir: string,
  body: Effect.Effect<A, E, R>,
  saveWhen: (a: A) => boolean,
) =>
  Effect.gen(function* () {
    const cache = yield* Effect.serviceOption(GateCache);
    const entries: readonly CacheEntry[] = input.cache ?? [];
    // An executor with no cache answers every restore as a miss: the job only does more work.
    if (Option.isNone(cache) || entries.length === 0) return yield* body;
    for (const entry of entries) yield* cache.value.restore(entry, dir);
    const result = yield* body;
    if (saveWhen(result)) for (const entry of entries) yield* cache.value.save(entry, dir);
    return result;
  });

/** Runs one matrix job (FD-GATE-025 to FD-GATE-028, FD-GATE-034, FD-GATE-081). */
export const runGateJob = (input: GateJobInput) =>
  Effect.gen(function* () {
    const skip = pullRequestSkip(input);
    if (skip !== undefined) return skip;
    const bad = timeoutProblem(input.timeoutSec, GATE_JOB_MAX_DURATION_SEC);
    if (bad !== undefined) return bad;
    if (input.command.trim() === "") return Outcome.failure("config: no command");
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* checkedOutWorkspace(input);
        const logs: string[] = [];
        const step = withCache(
          input,
          dir,
          Effect.gen(function* () {
            if (input.install !== undefined && input.install.trim() !== "") {
              const installed = yield* runStep({
                ctx: input,
                job: input.key,
                command: input.install,
                cwd: dir,
                timeoutSec: INSTALL_TIMEOUT_SEC,
                install: true,
                ...(input.env === undefined ? {} : { env: input.env }),
              });
              logs.push(installed.output);
              if (!isSuccess(installed.outcome)) return installed.outcome;
            }
            const ran = yield* runStep({
              ctx: input,
              job: input.key,
              command: input.command,
              cwd: dir,
              timeoutSec: input.timeoutSec ?? DEFAULT_JOB_TIMEOUT_SEC,
              ...(input.env === undefined ? {} : { env: input.env }),
            });
            logs.push(ran.output);
            return ran.outcome;
          }),
          isSuccess,
        );
        let outcome = yield* step;
        if (isSuccess(outcome) && input.writeback !== undefined)
          outcome = yield* stageWriteback(input, input.writeback, dir);
        yield* uploadLog(input.key, logs.join(""));
        return outcome;
      }),
    );
  }).pipe(
    Effect.catchTag("CheckoutFailed", () =>
      Effect.succeed(Outcome.failure("infra: CheckoutFailed")),
    ),
  );

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const sha256 = (bytes: Uint8Array) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)).pipe(
    Effect.map((d) => `sha256:${hex(d)}`),
  );

/** The branch a staged write proposes: always under `flare-dispatch/` (FD-GATE-081). */
export const writebackBranch = (branch: string): string =>
  branch.startsWith("flare-dispatch/") ? branch : `flare-dispatch/${branch}`;

/**
 * Stages the files the job changed that match the writeback paths as one staged write: blobs under
 * `staged-write/blobs/<digest>` and the manifest as `staged-write.json`, which the `pr.propose` applier's
 * staged-write gate checks (FD-GATE-081). A job that changed no matching file stages nothing.
 */
const stageWriteback = (input: GateJobInput, writeback: Writeback, dir: string) =>
  Effect.gen(function* () {
    const exec = yield* GateExec;
    const artifacts = yield* GateArtifacts;
    const listed = yield* exec.run({
      command: "git status --porcelain=v1 -z --untracked-files=all",
      cwd: dir,
      env: jobEnv(input, input.key),
      timeoutMs: 60_000,
    });
    if (!CommandExit.$is("Exited")(listed.exit) || listed.exit.code !== 0)
      return Outcome.failure("writeback: status");
    const paths = decoder
      .decode(listed.output)
      .split("\0")
      .filter((entry) => entry.length > 3 && !entry.startsWith("D"))
      .map((entry) => entry.slice(3))
      .filter((path) => writeback.paths.some((glob) => globMatches(glob, path)));
    if (paths.length === 0) return Outcome.success();
    const entries: { path: string; mode: string; digest: string }[] = [];
    for (const path of paths) {
      const bytes = yield* exec.readFile(`${dir}/${path}`);
      const digest = yield* sha256(bytes);
      yield* artifacts.upload(`staged-write/blobs/${digest}`, bytes);
      entries.push({ path, mode: "100644", digest });
    }
    const manifest = {
      branch: writebackBranch(writeback.branch),
      baseBranch: input.ref.replace(/^refs\/heads\//, ""),
      baseCommit: input.sha,
      commitMessage: writeback.title ?? `chore: ${input.key} writeback`,
      pr: {
        title: writeback.title ?? `${input.key}: regenerated files`,
        body: `Files the \`${input.key}\` job regenerated at ${input.sha}.`,
        draft: false,
        labels: [],
      },
      entries,
    };
    yield* artifacts.upload(
      "staged-write.json",
      new TextEncoder().encode(`${JSON.stringify(manifest)}\n`),
    );
    return Outcome.success();
  }).pipe(
    Effect.catchTags({
      WorkspaceReadFailed: () => Effect.succeed(Outcome.failure("writeback: read")),
      ArtifactUploadFailed: () => Effect.succeed(Outcome.failure("writeback: upload")),
    }),
  );
