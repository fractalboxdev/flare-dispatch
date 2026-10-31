// FlareDispatch's Durable Object classes: mameko's, with the configuration each reads derived from the profile.
import { lookupRun } from "@fractalboxdev/flare-dispatch-catalog";
import {
  ExecutionEngine as MamekoExecutionEngine,
  ExecutorChannel as MamekoExecutorChannel,
  type ClaimedLease,
} from "@fractalboxdev/mameko-host-cloudflare";
import { Effect, Match } from "effect";
import {
  channelConfig,
  deadlineOutcomeOf,
  deployment,
  executionConfig,
  profileOf,
  type ControlPlaneEnv,
} from "./config.ts";
import { getExecutionInputs } from "./inputs.ts";

type ChannelEnv = ControlPlaneEnv & {
  readonly MAMEKO_CHANNEL_CONFIG: ReturnType<typeof channelConfig>;
};
type EngineEnv = ControlPlaneEnv & {
  readonly MAMEKO_EXECUTION_CONFIG: ReturnType<typeof executionConfig>;
};

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

const sha256 = async (text: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** The image a host execution names: it runs in no image, and a lease must carry the field. */
const NO_IMAGE = "none: host execution";

/** A lease's progress timeout, from `defineRun`'s default. */
const PROGRESS_TIMEOUT_MS = 300_000;

export class ExecutorChannel extends MamekoExecutorChannel<ChannelEnv> {
  constructor(ctx: DurableObjectState, env: ControlPlaneEnv) {
    super(ctx, { ...env, MAMEKO_CHANNEL_CONFIG: channelConfig(profileOf(env)) });
  }

  /**
   * A `batch` execution has the deadline outcome `deferred`, so admission starts no workflow (MAMEKO-ARCH-035) and it
   * waits as a D1 row; the first claim starts one before the lease grant, which the workflow's lease wait receives.
   * `start` is keyed by the execution id, so a later claim of the execution after a reclaim starts nothing new.
   */
  protected override leaseFields(executionId: string, className: string): Promise<ClaimedLease> {
    const env = this.env;
    return Effect.runPromise(
      Effect.gen(function* () {
        const { inputs, deadlineAtMs } = yield* getExecutionInputs(env.DB, executionId);
        const { results } = yield* Effect.promise(() =>
          env.DB.prepare("select run, scope_id from executions where id = ?")
            .bind(executionId)
            .all(),
        );
        const row = results[0] as { run: string; scope_id: string };
        const run = Match.value(lookupRun(deployment(env), row.run)).pipe(
          Match.tag("Available", ({ entry }) => entry.spec),
          Match.orElse(() => null),
        );
        yield* Effect.promise(() =>
          env.EXECUTION.get(env.EXECUTION.idFromName(executionId)).start({
            workflow_version: 1,
            executionId,
            className,
            deadlineAtMs,
            deadlineOutcome: deadlineOutcomeOf(profileOf(env), className),
          }),
        );
        return {
          run: row.run,
          run_digest: yield* Effect.promise(() => sha256(`${row.run}@${run?.version ?? ""}`)),
          run_version: run?.version ?? "",
          workflow_version: 1,
          request_context: null,
          image_digest: NO_IMAGE,
          scope_id: row.scope_id,
          inputs,
          deadline_at: deadlineAtMs,
          server_now: Date.now(),
          progress_timeout_ms: PROGRESS_TIMEOUT_MS,
          credentials: {},
          cache_namespaces: [],
          upload_grant: {},
          nonce: crypto.randomUUID(),
        } satisfies ClaimedLease;
      }),
    );
  }
}

export class ExecutionEngine extends MamekoExecutionEngine<EngineEnv> {
  constructor(ctx: DurableObjectState, env: ControlPlaneEnv) {
    super(ctx, { ...env, MAMEKO_EXECUTION_CONFIG: executionConfig(profileOf(env)) });
  }
}

export { EpochAnchor, LivenessMonitor } from "@fractalboxdev/mameko-host-cloudflare";
