// The facade — the only way a consumer reaches the substrate
// (specs/adr/0003-facade-only-consumption.md).
//
// One `WorkerEntrypoint` subclass per consumer: the entrypoint a service
// binding targets is chosen in the consumer's reviewed wrangler config, and
// THAT choice is the consumer identity (ADR-0009 — never a runtime field).
// Consumers hold no DO binding, no container class, no D1 — every call lands
// here, crosses admission, and drives the substrate's own Durable Objects.
//
// Every failure a consumer must act on is a typed refusal in the return value
// (contract `SubstrateRefusal`), never an opaque throw: refusals render
// in-thread (fractalbot) or into check output (dispatcher) without either
// consumer knowing the substrate's insides.
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AbortOutcome,
  AdmissionMode,
  AttemptOutcome,
  CheckpointOutcome,
  CheckpointReason,
  EnsureOutcome,
  ExecInput,
  ExecOutcome,
  PoolName,
  PoolStatus,
  QueuePosition,
  SandboxKey,
  SubstrateFacade,
  SubstrateRecipe,
} from "@fractalboxdev/flare-dispatch-substrate-contract";
import {
  ADMISSION_RETRY_AFTER_MS,
  resolvePoolCaps,
  selectPool,
  type ConsumerId,
  type PoolCaps,
} from "./admission/pools";
import { makeAdmissionStoreD1, type AdmissionStore } from "./admission/store-d1";
import { mintTicket, TICKET_TTL_MS } from "./admission/ticket";
import { sandboxDoName } from "./engine/policy";
import { sandboxByName, type SubstrateSandboxBase } from "./sandbox-do";
import type { Env } from "./env";

/** Well-formedness gate on the one consumer input grants derive from. */
function recipeProblem(recipe: SubstrateRecipe): string | undefined {
  if (!Number.isInteger(recipe.version) || recipe.version < 0)
    return "recipe.version must be a non-negative integer";
  if (recipe.repo && !/^[\w.-]+\/[\w.-]+$/.test(`${recipe.repo.owner}/${recipe.repo.name}`))
    return "recipe.repo is not an owner/name pair";
  const unserved = recipe.profiles?.find((p) => p !== "public-repo-read");
  if (unserved !== undefined)
    return `grant profile ${unserved} is not served yet — public-repo-read only`;
  return undefined;
}

export abstract class SubstrateFacadeBase
  extends WorkerEntrypoint<Env>
  implements SubstrateFacade
{
  protected abstract readonly consumer: ConsumerId;

  private get store(): AdmissionStore {
    return makeAdmissionStoreD1(this.env.ADMISSION_DB);
  }

  private get caps(): PoolCaps {
    return resolvePoolCaps(this.env.POOL_CAPS);
  }

  private namespaceFor(pool: PoolName): DurableObjectNamespace<SubstrateSandboxBase> {
    const ns = {
      lean: this.env.SANDBOX_LEAN,
      browser: this.env.SANDBOX_BROWSER,
      agent: this.env.SANDBOX_AGENT,
      task: this.env.SANDBOX_TASK,
    }[pool];
    return ns as unknown as DurableObjectNamespace<SubstrateSandboxBase>;
  }

  /** The admission row id and the DO name are the same namespaced string. */
  private executionId(key: SandboxKey): string {
    return sandboxDoName(this.consumer, key);
  }

  /**
   * Admit (or re-join) this execution and hand its DO a fresh ticket. The
   * single claim attempt never blocks — queue waits are the consumer's own
   * durable machinery driving admissionEnqueue/Attempt (ADR-0004).
   */
  private async admitAndTicket(
    id: string,
    key: SandboxKey,
    pool: PoolName,
  ): Promise<
    | { admitted: true; stub: SubstrateSandboxBase; expiresAt: number }
    | { admitted: false; position: number; poolBusy: number; enqueuedAt: number }
  > {
    const { enqueuedAt } = await this.store.enqueue(id, this.consumer, pool);
    const attempt = await this.store.attempt(id, this.consumer, pool, this.caps[pool]);
    if (!attempt.admitted)
      return { admitted: false, position: attempt.position, poolBusy: attempt.poolBusy, enqueuedAt };

    const expiresAt = Date.now() + TICKET_TTL_MS;
    const ticket = await mintTicket(this.env.TICKET_SECRET, {
      consumer: this.consumer,
      key,
      pool,
      expiresAt,
    });
    const stub = sandboxByName(this.namespaceFor(pool), id);
    const stored = await stub.admit(this.consumer, key, ticket);
    if (!stored.ok)
      throw new Error(`ticket store refused: ${stored.reason ?? "unknown"}`);
    return { admitted: true, stub, expiresAt };
  }

  async ensureSandbox(
    key: SandboxKey,
    recipe: SubstrateRecipe,
    admission: AdmissionMode,
  ): Promise<EnsureOutcome> {
    const problem = recipeProblem(recipe);
    if (problem) return { ok: false, refusal: { kind: "recipe-rejected", reason: problem } };

    const pool = selectPool(this.consumer, recipe);
    let id: string;
    try {
      id = this.executionId(key);
    } catch (err) {
      return {
        ok: false,
        refusal: { kind: "recipe-rejected", reason: err instanceof Error ? err.message : "bad key" },
      };
    }

    try {
      const admitted = await this.admitAndTicket(id, key, pool);
      if (!admitted.admitted) {
        // Fail-fast refusal in both modes — in queue mode the consumer keeps
        // driving attempts from its own durable steps; this call never waits.
        if (admission.mode === "refuse") await this.store.release(id);
        return {
          ok: false,
          refusal: {
            kind: "admission-refused",
            pool,
            poolBusy: admitted.poolBusy,
            cap: this.caps[pool],
            position: admitted.position,
            queuedForMs: Math.max(0, Date.now() - admitted.enqueuedAt),
            retryAfterMs: ADMISSION_RETRY_AFTER_MS,
          },
        };
      }
      return await admitted.stub.ensure(recipe);
    } catch (err) {
      return {
        ok: false,
        refusal: {
          kind: "sandbox-unavailable",
          reason: err instanceof Error ? err.message : "substrate error",
        },
      };
    }
  }

  async execUnderGrant(key: SandboxKey, input: ExecInput): Promise<ExecOutcome> {
    const problem = recipeProblem(input.recipe);
    if (problem) return { ok: false, refusal: { kind: "recipe-rejected", reason: problem } };

    const pool = selectPool(this.consumer, input.recipe);
    let id: string;
    try {
      id = this.executionId(key);
    } catch (err) {
      return {
        ok: false,
        refusal: { kind: "recipe-rejected", reason: err instanceof Error ? err.message : "bad key" },
      };
    }

    try {
      // Exec is one call that ensures internally — a resume after a long
      // approval wait re-admits here (fail-fast) and pays a rebuild inside
      // the fence, rather than exec'ing a container admission forgot.
      const admitted = await this.admitAndTicket(id, key, pool);
      if (!admitted.admitted)
        return {
          ok: false,
          refusal: {
            kind: "admission-refused",
            pool,
            poolBusy: admitted.poolBusy,
            cap: this.caps[pool],
            position: admitted.position,
            queuedForMs: Math.max(0, Date.now() - admitted.enqueuedAt),
            retryAfterMs: ADMISSION_RETRY_AFTER_MS,
          },
        };

      const outcome = await admitted.stub.guardedExec({
        recipe: input.recipe,
        command: input.command,
        idempotencyKey: input.idempotencyKey,
        logPath: input.logPath,
        timeoutMs: input.timeoutMs,
        tailBytes: input.tailBytes,
        lfs: input.lfs,
        approval: input.approval,
      });
      if (!outcome.ok) return { ok: false, refusal: outcome.refusal };
      return {
        ok: true,
        receipt: outcome.receipt,
        ensured: outcome.ensured,
        granted: outcome.granted,
        killed: outcome.killed,
      };
    } catch (err) {
      return {
        ok: false,
        refusal: {
          kind: "sandbox-unavailable",
          reason: err instanceof Error ? err.message : "substrate error",
        },
      };
    }
  }

  async checkpoint(key: SandboxKey, reason: CheckpointReason): Promise<CheckpointOutcome> {
    try {
      const id = this.executionId(key);
      // The stopped container must not keep holding a pool slot — checkpoint
      // is the polite end of an execution's claim on the fleet; the next
      // ensure/exec re-admits.
      const row = await this.rowStub(id);
      if (row) await row.checkpoint(reason);
      await this.store.release(id);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        refusal: {
          kind: "sandbox-unavailable",
          reason: err instanceof Error ? err.message : "substrate error",
        },
      };
    }
  }

  async abort(key: SandboxKey): Promise<AbortOutcome> {
    // The off-switch never refuses: kill what can be killed, release the
    // slot, report what happened. Idempotent on an already-gone container.
    let killed = 0;
    try {
      const id = this.executionId(key);
      const stub = await this.rowStub(id);
      if (stub) killed = (await stub.abortExec()).killed;
      await this.store.release(id);
    } catch (err) {
      console.error("abort: best-effort teardown hit an error", err);
    }
    return { ok: true, killed };
  }

  /**
   * The DO for an id, addressed in every pool it may live in. An execution's
   * pool is stable (policy-selected from consumer + recipe), but checkpoint
   * and abort take no recipe — so resolve by trying the consumer's pools.
   * Cheap: DO stubs are name-derived, no I/O until a call.
   */
  private async rowStub(id: string): Promise<SubstrateSandboxBase | undefined> {
    const pool = selectPool(this.consumer, { version: 0 });
    return sandboxByName(this.namespaceFor(pool), id);
  }

  async admissionEnqueue(key: SandboxKey, recipe: SubstrateRecipe): Promise<QueuePosition> {
    const pool = selectPool(this.consumer, recipe);
    const id = this.executionId(key);
    await this.store.enqueue(id, this.consumer, pool);
    const status = await this.store.status(this.caps);
    const mine = status.pools.find((p) => p.pool === pool);
    return {
      pool,
      position: Math.max(0, (mine?.queued ?? 1) - 1),
      poolBusy: mine?.busy ?? 0,
      cap: this.caps[pool],
    };
  }

  async admissionAttempt(key: SandboxKey, recipe: SubstrateRecipe): Promise<AttemptOutcome> {
    const pool = selectPool(this.consumer, recipe);
    const id = this.executionId(key);
    const admitted = await this.admitAndTicket(id, key, pool);
    if (admitted.admitted) return { admitted: true, expiresAt: admitted.expiresAt };
    return {
      admitted: false,
      pool,
      position: admitted.position,
      poolBusy: admitted.poolBusy,
      cap: this.caps[pool],
    };
  }

  async admissionRelease(key: SandboxKey): Promise<void> {
    await this.store.release(this.executionId(key));
  }

  async poolStatus(): Promise<PoolStatus> {
    return this.store.status(this.caps);
  }
}

/** The dispatcher's binding target (in-repo consumer). */
export class DispatcherFacade extends SubstrateFacadeBase {
  protected readonly consumer = "dispatcher" as const;
}

/** fractalbot's binding target (external consumer, same account). */
export class FractalbotFacade extends SubstrateFacadeBase {
  protected readonly consumer = "fractalbot" as const;
}

/**
 * The substrate's own scratch consumer — what the deploy probes ride
 * (verify/run.ts). It is a real entrypoint rather than a private code path so
 * the probes exercise the same admission, ticket and fence sequence a consumer
 * does; a canary that took a shortcut around the facade could pass on a build
 * whose facade was broken.
 *
 * Its work is one repo-less container for the canary and one clone for the
 * dogfood, both aborted at the end of the probe.
 */
export class SelfCheckFacade extends SubstrateFacadeBase {
  protected readonly consumer = "self-check" as const;
}
