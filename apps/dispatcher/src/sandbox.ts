// FlareDispatch Dispatcher — RunSandbox: the Container-backed Durable Object.
//
// `RunSandbox` is the Durable Object class behind the `RUNS_SANDBOX` container
// binding. PR1 stubbed it as a bare `DurableObject`; PR4 makes it what the
// Containers API actually requires: a subclass of `@cloudflare/sandbox`'s
// `Sandbox` Durable Object, which wraps a container and exposes the typed
// `exec` / `gitCheckout` RPC surface `SandboxCloudflareLive` drives via
// `getSandbox(env.RUNS_SANDBOX, executionId)`.
//
// The subclasses are intentionally empty — they exist only to give each binding
// a repo-owned, named class (wrangler registers the *class name* in the
// `containers` + `durable_objects` config and the migrations). All behaviour is
// inherited from the SDK's `Sandbox`. A future PR can override lifecycle hooks
// (`onStart`, `onError`) here without touching the binding.
//
// `RunSandboxBrowser` is a second, identical class backing the chromium-baked
// `RUNS_SANDBOX_BROWSER` binding. The Container binding (not the class body) is
// what differs — both are built from infra/Dockerfile.sandbox, the browser one
// with `WITH_BROWSER=true`. Cloudflare requires a DISTINCT DO class per Container
// image, so the routing split (workflow.ts) needs this second class even though
// its code is identical.
//
// Spec: specs/01-architecture.md § Sandbox, specs/pm/plan.md § PR4 + § 6.

import { Sandbox } from "@cloudflare/sandbox";
import { recordContainerStop, takeRequested, type StopParamsLike } from "./container-stop";
import type { Env } from "./env";

/**
 * Idle window before a finished container is put to sleep.
 *
 * The SDK default is 10 minutes — and the Container DO bills wall-clock
 * *duration* (DO + container vCPU/memory) the whole time, so every execution
 * paid a 10-minute idle tail after its last command. Across a CI-shaped
 * workload (hundreds of short runs a day) that tail was ~45% of total spend.
 *
 * `isActivityExpired()` never fires while a request is in-flight (a long quiet
 * `exec` keeps the container awake regardless), and the window restarts when
 * the last request completes — so this only trims the *idle* tail. The primary
 * teardown is the explicit `destroy()` at the workflow's finalize boundary
 * (workflow.ts), which fires on success/failure/defect/interrupt; this idle
 * window is only the backstop for paths that die before reaching it (Worker
 * eviction, deploy mid-run).
 *
 * Why 10m, not the 2m a cost pass once set: a run's container filesystem is the
 * SHARED state across its durable steps — `step("checkout")` clones into it, a
 * later `step("exec")` runs in it. A checkpointed step's RESULT is memoized, but
 * the cloned filesystem is an ephemeral SIDE EFFECT that does not survive the
 * container sleeping between those steps. When a step-retry backoff or a Workflow
 * replay/resume gap exceeded 2m the container slept, the next exec re-provisioned
 * a FRESH (empty) container, and the command failed with `Failed to change
 * directory to '<cwd>'` — which `failOnNonZeroExit` runs (`oxlint`,
 * `offload-test`) then mis-rendered as a red lint/test verdict. Because
 * `destroy()` is the real teardown, a longer idle window costs extra ONLY on the
 * rare paths that skip finalize, so 10m (the SDK default, and the `LEASE_TTL_MS`
 * run-scale) buys durability across normal inter-step gaps at negligible cost.
 * `sandbox-cf.ts` `isWorkingDirFailure` is the honesty backstop for the residual
 * (eviction / replay beyond this window): it re-classifies a lost-workspace exec
 * as a retryable `ExecFailed`, never a phantom finding.
 */
const SANDBOX_SLEEP_AFTER = "10m";

/**
 * The shared body of the three `onStop` overrides.
 *
 * The classes exist only to give each container image a named class (see the
 * header), so the record belongs in one place rather than copied into each —
 * and the ordering below is load-bearing, so it should not be re-derived three
 * times either.
 *
 * Called AFTER `super.onStop()`: `callOnStop` in `@cloudflare/containers`
 * awaits the override and only then writes the DO's stopped state, so doing the
 * R2 put first would delay the SDK's own teardown and leave the state reading
 * `healthy` while the container is already gone.
 */
const recordStopFor = async (
  env: Env,
  ctx: DurableObjectState,
  requested: boolean,
  params?: StopParamsLike,
): Promise<void> =>
  recordContainerStop(
    env.RUNS_STORAGE,
    ctx.id.name ?? String(ctx.id),
    params,
    Date.now(),
    requested,
    env.CONTAINER_STOP_RECORDS,
  );

/**
 * Everything the three named classes share.
 *
 * They exist only to give each container image a class wrangler can register
 * (see the header), so the lifecycle logic lives here once. Three copies means
 * three places to fix an ordering or flag-lifetime bug, and a miss in one is
 * silent.
 */
abstract class RecordingSandbox extends Sandbox<Env> {
  override sleepAfter = SANDBOX_SLEEP_AFTER;

  /**
   * Set by our own `destroy()` so the record can say who asked. `workflow.ts`
   * tears every run down through an `Effect.ensuring`, so without this the
   * corpus is mostly our own teardowns with nothing to tell them from the
   * deaths worth reading.
   */
  #intent = { requested: false };

  override async destroy(): Promise<void> {
    this.#intent.requested = true;
    await super.destroy();
  }

  override async onStop(params?: StopParamsLike): Promise<void> {
    // Read-and-clear. `destroy()` does not reach `onStop` inline — the alarm
    // loop delivers it later — so the flag has to persist across that gap, and
    // then NOT persist any further. Left set, it would swallow every subsequent
    // stop this instance sees, including a real death after a failed destroy.
    const requested = takeRequested(this.#intent);
    await super.onStop();
    await recordStopFor(this.env, this.ctx, requested, params);
  }
}

/** The Durable Object class backing the lean `RUNS_SANDBOX` Container binding. */
export class RunSandbox extends RecordingSandbox {}

/**
 * The Durable Object class backing the chromium-baked `RUNS_SANDBOX_BROWSER`
 * Container binding. Identical to `RunSandbox` — only the bound image differs.
 */
export class RunSandboxBrowser extends RecordingSandbox {}

/**
 * The Durable Object class backing the agent-tier `RUNS_SANDBOX_AGENT` Container
 * binding (the `WITH_AGENT` image — flare-agent + toolchain, egress-restricted).
 * Identical body to `RunSandbox`; Cloudflare requires a distinct DO class per
 * Container image, so the self-heal routing split needs this third class.
 * specs/08-self-healing.md § 6.2.
 */
export class RunSandboxAgent extends RecordingSandbox {}
