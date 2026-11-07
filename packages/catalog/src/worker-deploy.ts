// The `worker-deploy` run: re-read the branch head, run the deploy command once per epoch with the Cloudflare API
// reached only through the `cf-api` grant, then start `deploy-smoke` on the same commit (FD-GATE-061 to FD-GATE-069).
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Option } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { CREDENTIAL_PLACEHOLDER } from "./egress.ts";
import { GithubRead } from "./github-read.ts";
import { checkedOutWorkspace, runStep, uploadLog } from "./job.ts";
import { WORKER_DEPLOY_MAX_DURATION_SEC, type WorkerDeployInput } from "./inputs.ts";
import { timeoutProblem } from "./manifest.ts";
import { GateIntents } from "./ports.ts";
import { isSuccess, Outcome } from "./reasons.ts";

export const DEFAULT_DEPLOY_TIMEOUT_SEC = 900;

/** Records that a deploy command started in an epoch, so it starts at most once there (FD-GATE-067). */
export class DeployLedger extends Context.Service<
  DeployLedger,
  {
    /** `true` the first time a key is claimed, `false` after. */
    readonly claim: (epochKey: string) => Effect.Effect<boolean>;
  }
>()("@fractalboxdev/flare-dispatch-catalog/DeployLedger") {}

/**
 * `DeployLedger` on the executor's file system: a claim is one `mkdir`, which fails when the directory exists, so
 * two attempts of one epoch cannot both claim it.
 */
export const fileDeployLedger = (root: string): Layer.Layer<DeployLedger> =>
  Layer.succeed(DeployLedger, {
    claim: (epochKey) =>
      Effect.promise(async () => {
        await mkdir(root, { recursive: true });
        try {
          await mkdir(join(root, encodeURIComponent(epochKey)));
          return true;
        } catch {
          return false;
        }
      }),
  });

/** The epoch's key: the workflow's execution id, which mameko derives from `<execution id>:<epoch>`. */
const epochKey = (input: WorkerDeployInput) =>
  Effect.serviceOption(WorkflowEngine.WorkflowInstance).pipe(
    Effect.map(
      Option.match({ onNone: () => `${input.scope}:${input.sha}`, onSome: (i) => i.executionId }),
    ),
  );

/** The environment the deploy command gets: the branch facts, and a placeholder for each granted credential. */
export const deployEnv = (
  input: WorkerDeployInput,
  head: string,
): Readonly<Record<string, string>> => ({
  FD_BRANCH: input.branch,
  FD_BRANCH_HEAD_SHA: head,
  ...((input.entry.grants ?? []).includes("cf-api")
    ? { CLOUDFLARE_API_TOKEN: CREDENTIAL_PLACEHOLDER }
    : {}),
});

export const runWorkerDeploy = (input: WorkerDeployInput) =>
  Effect.gen(function* () {
    const bad = timeoutProblem(input.entry.timeoutSec, WORKER_DEPLOY_MAX_DURATION_SEC);
    if (bad !== undefined) return bad;
    const github = yield* GithubRead;
    // Every epoch re-reads the head before the command, so a reclaimed deploy cannot ship a superseded commit.
    const head = yield* github.branchHead(input.scope, input.branch);
    if (head !== input.sha && input.entry.requireHead !== false)
      return Outcome.cancelled("superseded: branch head moved");
    const ledger = yield* DeployLedger;
    if (!(yield* ledger.claim(yield* epochKey(input))))
      return Outcome.failure("infra: DeployAlreadyStarted");
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* checkedOutWorkspace(input);
        const ran = yield* runStep({
          ctx: input,
          job: "deploy",
          command: input.entry.command,
          cwd: dir,
          timeoutSec: input.entry.timeoutSec ?? DEFAULT_DEPLOY_TIMEOUT_SEC,
          env: deployEnv(input, head),
        });
        yield* uploadLog("deploy", ran.output);
        return ran.outcome;
      }),
    );
    if (isSuccess(outcome)) {
      const intents = yield* GateIntents;
      yield* intents.emit({
        kind: "dispatch.followOn",
        key: "deploy-smoke:0",
        payload: { run: "deploy-smoke", repository: input.scope, sha: input.sha, ref: input.ref },
      });
    }
    return outcome;
  }).pipe(
    Effect.catchTags({
      CheckoutFailed: () => Effect.succeed(Outcome.failure("infra: CheckoutFailed")),
      GithubReadFailed: () => Effect.succeed(Outcome.failure("infra: GithubReadFailed")),
      GithubUncredentialed: () => Effect.succeed(Outcome.failure("infra: GithubUncredentialed")),
      IntentRejected: () => Effect.succeed(Outcome.failure("intent: undeclared kind")),
    }),
  );
