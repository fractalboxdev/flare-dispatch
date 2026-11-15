// The `worker-deploy` run: re-read the branch head, claim the deploy, run the deploy command with the Cloudflare API
// reached only through the `cf-api` grant, then start `deploy-smoke` on the same commit (FD-GATE-061 to FD-GATE-069).
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Intents } from "@fractalboxdev/mameko-run";
import { Context, Effect, Layer, Option, Schema } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { CREDENTIAL_PLACEHOLDER } from "./egress.ts";
import { GithubRead } from "./github-read.ts";
import { checkedOutWorkspace, runStep, uploadLog } from "./job.ts";
import {
  WORKER_DEPLOY_MAX_DURATION_SEC,
  type DeployClaimGrant,
  type WorkerDeployInput,
} from "./inputs.ts";
import { timeoutProblem } from "./manifest.ts";
import { isSuccess, Outcome } from "./reasons.ts";

export const DEFAULT_DEPLOY_TIMEOUT_SEC = 900;

/** The deploy claim got no answer the ledger can decide on, so the run starts no deploy command. */
export class DeployClaimFailed extends Schema.TaggedError<DeployClaimFailed>()(
  "DeployClaimFailed",
  { detail: Schema.String },
) {}

/** Records that a deploy command started, so it starts at most once in an epoch (FD-GATE-067). */
export class DeployLedger extends Context.Service<
  DeployLedger,
  {
    /**
     * `true` the first time a key is claimed, `false` after. `grant` is the lease's deploy claim, which a ledger held
     * by the control plane presents.
     */
    readonly claim: (
      epochKey: string,
      grant?: DeployClaimGrant,
    ) => Effect.Effect<boolean, DeployClaimFailed>;
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

const ClaimAnswer = Schema.Struct({ claimed: Schema.Boolean });

/**
 * `DeployLedger` held by the control plane, for an executor whose file system does not outlive a reclaim, such as a
 * Container: a claim is one `POST` of the lease's deploy-claim token to the route the lease names. The control plane
 * keys the claim by execution id, so the first claim of an execution answers `true` and every later one, from any
 * epoch, answers `false`. The ledger fails closed: a lease without a deploy claim, a request that does not complete, a
 * non-2xx status or a body other than `{ "claimed": <boolean> }` fails the claim with `DeployClaimFailed`.
 */
export const httpDeployLedger = (fetch: typeof globalThis.fetch): Layer.Layer<DeployLedger> =>
  Layer.succeed(DeployLedger, {
    claim: (_epochKey, grant) =>
      Effect.gen(function* () {
        if (grant === undefined)
          return yield* new DeployClaimFailed({ detail: "the lease carries no deploy claim" });
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(grant.url, {
              method: "POST",
              headers: { authorization: `Bearer ${grant.token}` },
            }),
          catch: (cause) => new DeployClaimFailed({ detail: String(cause) }),
        });
        if (!response.ok)
          return yield* new DeployClaimFailed({ detail: `status ${response.status}` });
        const body = yield* Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: (cause) => new DeployClaimFailed({ detail: `body: ${String(cause)}` }),
        });
        const answer = yield* Schema.decodeUnknownEffect(ClaimAnswer)(body).pipe(
          Effect.mapError((e) => new DeployClaimFailed({ detail: `body: ${e.message}` })),
        );
        return answer.claimed;
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
    if (!(yield* ledger.claim(yield* epochKey(input), input.deployClaim)))
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
      const intents = yield* Intents;
      yield* intents.emit("deploy-smoke", {
        kind: "dispatch.followOn",
        // Intake takes the commit and smoke targets from the parent's trusted record and manifest.
        payload: { run: "deploy-smoke", inputs: {} },
      });
    }
    return outcome;
  }).pipe(
    Effect.catchTags({
      DeployClaimFailed: () => Effect.succeed(Outcome.failure("infra: DeployClaimFailed")),
      CheckoutFailed: () => Effect.succeed(Outcome.failure("infra: CheckoutFailed")),
      GithubReadFailed: () => Effect.succeed(Outcome.failure("infra: GithubReadFailed")),
      GithubUncredentialed: () => Effect.succeed(Outcome.failure("infra: GithubUncredentialed")),
      DuplicateIntentKey: () => Effect.succeed(Outcome.failure("infra: DuplicateIntentKey")),
      IntentLimitExceeded: () => Effect.succeed(Outcome.failure("infra: IntentLimitExceeded")),
    }),
  );
