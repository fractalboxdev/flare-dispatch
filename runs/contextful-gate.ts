import { Effect, Schema } from "effect";
import {
  AcceptanceFailed,
  defineRun,
  handoffChildAdmission,
  sandbox,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import {
  ensureWorkspace,
  fanOut,
  waitForChildren,
  workspace,
} from "@fractalboxdev/flare-dispatch-core/primitives";

const REPO = "fractalboxdev/contextful";
const DISCOVER = "cargo run --locked -q -p contextful-ci -- stages --parts";
const STAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const MAX_STAGES = 32;
const MAX_STAGE_LIST_BYTES = 2048;
const STAGE_CONCURRENCY = 2;

const Input = Schema.Struct({
  repo: Schema.Literal(REPO),
  sha: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/i)),
  baseSha: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/i)),
});

type InputType = Schema.Schema.Type<typeof Input>;

const Output = Schema.Struct({
  stages: Schema.Number,
  failed: Schema.Array(Schema.String),
});

/** A malformed or empty discovery cannot quietly remove required checks. */
export const parseStages = (stdout: string): readonly string[] | undefined => {
  if (new TextEncoder().encode(stdout).length > MAX_STAGE_LIST_BYTES) return undefined;
  const stages = stdout
    .trim()
    .split(/\r?\n/)
    .map((stage) => stage.trim());
  if (
    stages.length === 0 ||
    stages.length > MAX_STAGES ||
    stages.some((stage) => !STAGE_PATTERN.test(stage)) ||
    new Set(stages).size !== stages.length
  )
    return undefined;
  return stages;
};

/** The base revision keeps deleted stages in the PR's required check set. */
export const mergeStages = (
  head: readonly string[],
  base: readonly string[],
): readonly string[] => [...new Set([...head, ...base])];

export const contextfulGate = defineRun({
  name: "contextful-gate",
  version: "1.0.0",
  inputs: Input,
  outputs: Output,
  triggers: [
    {
      event: "pull_request",
      actions: ["opened", "synchronize", "reopened", "ready_for_review"],
      idempotencyKey: ({ payload }) =>
        `contextful-gate:${String(payload.pull_request?.number ?? "")}:${String(payload.pull_request?.head?.sha ?? "")}:${String(payload.pull_request?.base?.sha ?? "")}`,
      gate: ({ payload }) =>
        payload.repository?.full_name === REPO &&
        payload.pull_request?.head?.repo?.full_name === REPO,
      inputs: ({ payload }): InputType => ({
        repo: REPO,
        sha: String(payload.pull_request?.head?.sha ?? ""),
        baseSha: String(payload.pull_request?.base?.sha ?? ""),
      }),
    },
  ],
  limits: { maxDurationSec: 30 * 3600, admissionMaxQueueAgeSec: 90 * 60 },
  run: (input) =>
    Effect.gen(function* () {
      const { container, dir } = yield* step("checkout", () =>
        workspace({ repo: input.repo, sha: input.sha }),
      );
      const discovery = yield* step(
        "discover-stages",
        () =>
          ensureWorkspace({ current: { container, dir }, repo: input.repo, sha: input.sha }).pipe(
            Effect.flatMap((ws) =>
              sandbox.exec({
                container: ws.container,
                cwd: ws.dir,
                command: DISCOVER,
                timeoutSec: 1800,
              }),
            ),
          ),
        { timeoutSec: 1920, retries: 3, retryOn: ["ExecFailed", "StepFailed", "CheckoutFailed"] },
      );
      const headStages = discovery.exitCode === 0 ? parseStages(discovery.stdout) : undefined;
      const baseWorkspace = yield* step("checkout-base", () =>
        workspace({ repo: input.repo, sha: input.baseSha }),
      );
      const baseDiscovery = yield* step(
        "discover-base-stages",
        () =>
          ensureWorkspace({ current: baseWorkspace, repo: input.repo, sha: input.baseSha }).pipe(
            Effect.flatMap((ws) =>
              sandbox
                .exec({
                  container: ws.container,
                  cwd: ws.dir,
                  command: DISCOVER,
                  timeoutSec: 1800,
                })
                .pipe(Effect.map((result) => ({ ...result, container: ws.container }))),
            ),
          ),
        { timeoutSec: 1920, retries: 3, retryOn: ["ExecFailed", "StepFailed", "CheckoutFailed"] },
      );
      const baseStages =
        baseDiscovery.exitCode === 0 ? parseStages(baseDiscovery.stdout) : undefined;
      yield* step("release-discovery-container", () =>
        sandbox.destroy({ container: baseDiscovery.container }),
      );
      if (headStages === undefined || baseStages === undefined) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: discovery.exitCode || baseDiscovery.exitCode || 1,
            summaryMd:
              "The head or base gate stage list is empty, invalid, or could not be discovered.",
          }),
        );
      }
      const stages = mergeStages(headStages, baseStages);
      if (stages.length > MAX_STAGES) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: 1,
            summaryMd: "The combined head and base gate stage lists exceed 32 parts.",
          }),
        );
      }

      const failed: string[] = [];
      for (let offset = 0; offset < stages.length; offset += STAGE_CONCURRENCY) {
        const batch = stages.slice(offset, offset + STAGE_CONCURRENCY);
        const handles = yield* step(`spawn-stages-${offset}`, () =>
          fanOut({
            run: "check",
            items: batch,
            concurrency: STAGE_CONCURRENCY,
            toInput: (stage) => ({
              repo: input.repo,
              sha: input.sha,
              checkLabel: stage,
              command: `cargo run --locked -q -p contextful-ci -- gate --predecessors --stage ${stage} --base ${input.baseSha}`,
              failOnNonZeroExit: true,
              timeoutSec: 1800,
              admissionMaxQueueAgeSec: 90 * 60,
              install: false,
              secrets: [],
            }),
          }),
        );
        if (offset === 0) {
          yield* step("handoff-admission", () => handoffChildAdmission());
        }
        const results = yield* step(`await-stages-${offset}`, () =>
          waitForChildren({
            ids: handles.map((handle) => handle.executionId),
            timeout: "130 minutes",
          }),
        );
        results.forEach((result, index) => {
          if (result.status !== "success") failed.push(batch[index]!);
        });
      }
      if (failed.length > 0) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: 1,
            summaryMd: `Gate stages failed: ${failed.join(", ")}`,
          }),
        );
      }
      return { stages: stages.length, failed };
    }),
});
