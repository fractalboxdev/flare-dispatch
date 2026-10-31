// The `check` run's body: one commit in a clean directory, then each step in order until one fails.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Match, Schema } from "effect";
import type { RunResult } from "@fractalboxdev/mameko-run";
import { CommandExit, runCommand } from "./command.ts";
import { DEFAULT_STEP_TIMEOUT_SEC, type CheckInput, type CheckStep } from "./spec.ts";

/** A step ended with anything but exit 0: a finding about the commit. */
export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  step: Schema.String,
  detail: Schema.String,
}) {}

/** The commit never reached the workspace: an infrastructure failure, not a finding about the commit. */
export class CheckoutFailed extends Schema.TaggedError<CheckoutFailed>()("CheckoutFailed", {
  detail: Schema.String,
}) {}

/** The job environment names only what a job needs; it carries no secret of the executor's (FD-GATE-014). */
const INHERITED_ENV = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "PNPM_HOME"] as const;

const jobEnv = (input: CheckInput, job: string): Readonly<Record<string, string>> => ({
  ...Object.fromEntries(
    INHERITED_ENV.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  ),
  CI: "true",
  GIT_TERMINAL_PROMPT: "0",
  FD_REPO: input.repo,
  FD_SHA: input.sha,
  FD_REF: input.ref,
  FD_JOB: job,
});

const exitDetail = Match.type<CommandExit>().pipe(
  Match.tagsExhaustive({
    Exited: ({ code }) => `exit ${code}`,
    Signalled: ({ signal }) => `signal ${signal}`,
    TimedOut: () => "timeout",
    OverLimit: () => "output over limit",
    NotStarted: ({ detail }) => `did not start: ${detail}`,
  }),
);

const CHECKOUT_TIMEOUT_MS = 600_000;

/**
 * A shallow fetch of the one commit, so a commit no branch reaches still resolves. Submodules resolve over HTTPS,
 * because a job holds no SSH credential.
 */
const checkoutScript = (input: CheckInput): string =>
  [
    "git init -q .",
    `git remote add origin ${shellQuote(input.repo)}`,
    `git fetch -q --depth 1 origin ${input.sha}`,
    "git -c advice.detachedHead=false checkout -q --detach FETCH_HEAD",
    `git config url.https://github.com/.insteadOf git@github.com:`,
    "git submodule update -q --init --recursive --depth 1",
  ].join(" && ");

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

const checkout = (input: CheckInput, cwd: string) =>
  Effect.gen(function* () {
    const exit = yield* runCommand({
      command: checkoutScript(input),
      cwd,
      env: jobEnv(input, "checkout"),
      timeoutMs: CHECKOUT_TIMEOUT_MS,
    });
    if (!CommandExit.$is("Exited")(exit) || exit.code !== 0)
      return yield* new CheckoutFailed({ detail: exitDetail(exit) });
  });

const runStep = (input: CheckInput, step: CheckStep, cwd: string) =>
  Effect.gen(function* () {
    process.stderr.write(`[check] ${step.label}: ${step.command}\n`);
    const exit = yield* runCommand({
      command: step.command,
      cwd,
      env: jobEnv(input, step.label),
      timeoutMs: (step.timeoutSec ?? DEFAULT_STEP_TIMEOUT_SEC) * 1000,
    });
    if (!CommandExit.$is("Exited")(exit) || exit.code !== 0)
      return yield* new StepFailed({ step: step.label, detail: exitDetail(exit) });
  });

/**
 * The clean directory sits outside the repository the runner starts from, so a dependency the commit lacks cannot
 * resolve from a parent `node_modules`. `FD_WORKSPACE_ROOT` names where it goes, the OS temporary directory by default.
 */
const workspace = Effect.promise(() =>
  mkdtemp(join(process.env["FD_WORKSPACE_ROOT"] ?? tmpdir(), "fd-check-")),
);

const removeWorkspace = (dir: string) =>
  Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(
    Effect.catchDefect(() => Effect.void),
  );

export const runCheck = (input: CheckInput): Effect.Effect<RunResult> =>
  Effect.acquireUseRelease(
    workspace,
    (dir) =>
      Effect.gen(function* () {
        yield* checkout(input, dir);
        for (const step of input.steps) yield* runStep(input, step, dir);
        return { _tag: "success" } as RunResult;
      }),
    removeWorkspace,
  ).pipe(
    Effect.catchTags({
      StepFailed: ({ step, detail }) =>
        Effect.succeed({ _tag: "failure", reason: `finding: ${step}: ${detail}` } as RunResult),
      CheckoutFailed: ({ detail }) =>
        Effect.succeed({ _tag: "failure", reason: `infra: checkout: ${detail}` } as RunResult),
    }),
  );
