import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Effect, Exit, Match, Schema } from "effect";
import { NativeAdmissionTime, NativeReceiptRefused, assertNativeControllerDeadline } from "@fractalboxdev/flare-dispatch-core";
import { parseNativeControllerAppId, signAppJwt } from "@fractalboxdev/flare-dispatch-github-app";
import { NativeControllerCheckpoint, NATIVE_CONTROLLER_CHECKPOINT_MAX_BYTES,
  advanceNativeControllerCheckpoint, preflightNativeDispatchD1 } from "@fractalboxdev/flare-dispatch-runtime-cf/native";
import type { Env } from "./env";
import { NativeWorkflowParams, admitNativeWorkflowRequest, nativeWorkflowId, readNativeWorkflowPolicy } from "./native-workflow-policy";

/** Only lifecycle metadata and the next bounded poll time cross native Workflow checkpoints. */
export const NativeWorkflowPoll = Schema.Struct({
  checkpoint: NativeControllerCheckpoint,
  nextPollAt: Schema.NullOr(NativeAdmissionTime),
}).pipe(Schema.filter(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= NATIVE_CONTROLLER_CHECKPOINT_MAX_BYTES));
type NativeWorkflowPoll = typeof NativeWorkflowPoll.Type;
const refusal = () => new NativeReceiptRefused({ reason: "native Workflow admission or execution refused" });

export const nativeWorkflowPoll = (raw: unknown, pollIntervalSec: number, now: number) => Effect.gen(function* () {
  const checkpoint = yield* Schema.decodeUnknown(NativeControllerCheckpoint, { onExcessProperty: "error" })(raw).pipe(Effect.mapError(refusal));
  if (checkpoint.deadlineAt === undefined) return yield* Effect.fail(refusal());
  yield* assertNativeControllerDeadline(checkpoint.deadlineAt, now);
  const pending = Match.value(checkpoint).pipe(
    Match.tags({ WaitingForRun: () => true, Running: () => true, Failed: () => false, Published: () => false }),
    Match.exhaustive,
  );
  const nextPollAt = pending ? now + Math.min(pollIntervalSec, checkpoint.deadlineAt - now) : null;
  return yield* Schema.decodeUnknown(NativeWorkflowPoll, { onExcessProperty: "error" })({ checkpoint, nextPollAt }).pipe(Effect.mapError(refusal));
});

/** Native orchestration uses GitHub's executor; it owns no sandbox or container lease. */
export class NativeWorkflow extends WorkflowEntrypoint<Env, NativeWorkflowParams> {
  async run(event: WorkflowEvent<NativeWorkflowParams>, step: WorkflowStep): Promise<NativeControllerCheckpoint> {
    for (let index = 0; ; index++) {
      const poll = await step.do(`native advance ${index}`, async () => {
        const outcome = await Effect.runPromiseExit(Effect.gen(this, function* () {
          const params = yield* Schema.decodeUnknown(NativeWorkflowParams, { onExcessProperty: "error" })(event.payload).pipe(Effect.mapError(refusal));
          const policy = yield* readNativeWorkflowPolicy(this.env.NATIVE_EXECUTION_POLICY);
          if (JSON.stringify(policy) !== JSON.stringify(params.policy)) return yield* Effect.fail(refusal());
          const request = yield* admitNativeWorkflowRequest(params.request, policy);
          const id = yield* Effect.promise(() => nativeWorkflowId(request));
          if (id !== event.instanceId) return yield* Effect.fail(refusal());
          const appId = this.env.GITHUB_APP_ID;
          const key = this.env.GITHUB_APP_PRIVATE_KEY;
          if (appId === undefined || key === undefined || key.length === 0) return yield* Effect.fail(refusal());
          const configuredId = yield* Effect.try({ try: () => parseNativeControllerAppId(appId), catch: refusal });
          yield* preflightNativeDispatchD1(this.env.RUNS_METADATA, request, configuredId, { timeoutSec: policy.timeoutSec });
          const appJwt = yield* Effect.tryPromise({ try: () => signAppJwt({ appId, privateKeyPem: key }), catch: refusal });
          const checkpoint = yield* advanceNativeControllerCheckpoint({ db: this.env.RUNS_METADATA, bucket: this.env.RUNS_STORAGE,
            policy: { timeoutSec: policy.timeoutSec }, auth: { appId, appJwt, repo: request.repo } }, request);
          return yield* nativeWorkflowPoll(checkpoint, policy.pollIntervalSec, Math.floor(Date.now() / 1000));
        }));
        return Exit.match(outcome, {
          onSuccess: value => value,
          onFailure: () => { throw new NonRetryableError("native Workflow admission or execution refused"); },
        });
      });
      const terminal = Match.value(poll.checkpoint).pipe(
        Match.tags({
          WaitingForRun: () => null,
          Running: () => null,
          Failed: () => { throw new NonRetryableError("native executor reported terminal failure"); },
          Published: checkpoint => checkpoint,
        }),
        Match.exhaustive,
      );
      if (terminal !== null) return terminal;
      if (poll.nextPollAt === null) throw new NonRetryableError("native Workflow poll checkpoint invalid");
      await step.sleepUntil(`native poll ${index}`, poll.nextPollAt * 1000);
    }
  }
}
