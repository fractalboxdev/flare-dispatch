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
  DenialEvent,
  DetachedStatusOutcome,
  EnsureOutcome,
  ExecInput,
  ExecOutcome,
  PoolName,
  PoolStatus,
  QueuePosition,
  ReadFileOutcome,
  SandboxKey,
  StartDetachedInput,
  StartDetachedOutcome,
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
import { checkApprovalFloor, commandRequiresApproval } from "./engine/approval";
import { selectionProblem } from "./engine/profiles";
import { sandboxDoName } from "./engine/policy";
import { sandboxByName, type SubstrateSandboxBase } from "./sandbox-do";
import type { Env } from "./env";

/**
 * Well-formedness gate on the one consumer input grants derive from.
 *
 * The profile/target half delegates to the catalog (`selectionProblem`), which
 * is now the served list: a name it does not carry is a typed `recipe-rejected`
 * at the boundary rather than a silently-empty grant — a run that believes it
 * has `rust-install` and gets deny-all should fail here, where the reason is
 * legible, not deep in a build log. The catalog also keeps ADR-0005's
 * "no repo ⇒ no egress" rule, so a profile cannot compose onto nothing.
 */
function recipeProblem(recipe: SubstrateRecipe): string | undefined {
  if (!Number.isInteger(recipe.version) || recipe.version < 0)
    return "recipe.version must be a non-negative integer";
  if (recipe.repo && !/^[\w.-]+\/[\w.-]+$/.test(`${recipe.repo.owner}/${recipe.repo.name}`))
    return "recipe.repo is not an owner/name pair";
  return selectionProblem({
    repo: recipe.repo ? `${recipe.repo.owner}/${recipe.repo.name}` : "",
    containerId: "unbound",
    lfs: recipe.lfs,
    profiles: recipe.profiles,
    targets: recipe.targets,
    position: recipe.enforcement,
  });
}

export abstract class SubstrateFacadeBase extends WorkerEntrypoint<Env> implements SubstrateFacade {
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
      return {
        admitted: false,
        position: attempt.position,
        poolBusy: attempt.poolBusy,
        enqueuedAt,
      };

    const expiresAt = Date.now() + TICKET_TTL_MS;
    const ticket = await mintTicket(this.env.TICKET_SECRET, {
      consumer: this.consumer,
      key,
      pool,
      expiresAt,
    });
    const stub = sandboxByName(this.namespaceFor(pool), id);
    const stored = await stub.admit(this.consumer, key, ticket);
    if (!stored.ok) throw new Error(`ticket store refused: ${stored.reason ?? "unknown"}`);
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
        refusal: {
          kind: "recipe-rejected",
          reason: err instanceof Error ? err.message : "bad key",
        },
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
        refusal: {
          kind: "recipe-rejected",
          reason: err instanceof Error ? err.message : "bad key",
        },
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

  async readFile(key: SandboxKey, path: string): Promise<ReadFileOutcome> {
    if (!path || path.trim() !== path)
      return { ok: false, refusal: { kind: "recipe-rejected", reason: "path is empty or padded" } };
    try {
      const stub = await this.rowStub(this.executionId(key));
      if (!stub)
        return { ok: false, refusal: { kind: "sandbox-unavailable", reason: "no container" } };
      const result = await stub.readWorkspaceFile(path);
      return result.ok
        ? { ok: true, content: result.content }
        : { ok: false, refusal: { kind: "sandbox-unavailable", reason: result.reason } };
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

  /**
   * Start a process that outlives this call (ADR-0012). Admission and the
   * ticket are the same as for an exec — a detached process occupies a
   * container and must be counted — but **no grant is derived and none is
   * applied**: it runs under the container's deny-all floor.
   *
   * The approval floor (ADR-0007) is crossed here rather than in the DO,
   * because a refusal must cost nothing: starting `git push` detached must be
   * refused before a container is touched, exactly as `execUnderGrant` refuses
   * it before the fence applies anything.
   */
  async startDetached(key: SandboxKey, input: StartDetachedInput): Promise<StartDetachedOutcome> {
    const problem = recipeProblem(input.recipe);
    if (problem) return { ok: false, refusal: { kind: "recipe-rejected", reason: problem } };

    const command = input.command.trim();
    if (!command)
      return { ok: false, refusal: { kind: "recipe-rejected", reason: "empty command" } };

    const floorRefusal = await checkApprovalFloor(command, input.approval);
    if (floorRefusal) return { ok: false, refusal: floorRefusal };

    const pool = selectPool(this.consumer, input.recipe);
    let id: string;
    try {
      id = this.executionId(key);
    } catch (err) {
      return {
        ok: false,
        refusal: {
          kind: "recipe-rejected",
          reason: err instanceof Error ? err.message : "bad key",
        },
      };
    }

    try {
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

      // The attestation is spent in the DO, where the ticket lives, for the
      // same reason the fence spends it there: the record belongs at the object
      // that runs the command, and only a floor command spends one.
      if (input.approval && commandRequiresApproval(command) !== undefined) {
        const spent = await admitted.stub.claimAttestation(input.approval, input.idempotencyKey);
        if (spent) return { ok: false, refusal: spent };
      }

      const started = await admitted.stub.startDetached({
        recipe: input.recipe,
        command,
        idempotencyKey: input.idempotencyKey,
        logPath: input.logPath,
      });
      return started.ok
        ? { ok: true, process: { id: started.process.id, startedAt: started.process.startedAt } }
        : { ok: false, refusal: started.refusal };
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

  async detachedStatus(key: SandboxKey, processId: string): Promise<DetachedStatusOutcome> {
    try {
      const stub = await this.rowStub(this.executionId(key));
      if (!stub)
        return { ok: false, refusal: { kind: "sandbox-unavailable", reason: "no container" } };
      return { ok: true, status: await stub.detachedStatus(processId) };
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

  async stopDetached(key: SandboxKey, processId: string): Promise<{ ok: true; stopped: boolean }> {
    // Never refuses, for the same reason `abort` never does: a caller shutting
    // something down cannot be left holding an error it has no move against.
    try {
      const stub = await this.rowStub(this.executionId(key));
      if (stub) return { ok: true, ...(await stub.stopDetached(processId)) };
    } catch (err) {
      console.error("stopDetached: best-effort teardown hit an error", err);
    }
    return { ok: true, stopped: false };
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

  /**
   * The execution's egress denials (ADR-0005). Asked of the DO rather than read
   * from D1 here: the rows are keyed by the container's own id, and the facade
   * only ever holds the *name* it derives the object from — which is what keeps
   * one consumer's key from ever addressing another's denials.
   */
  async denials(key: SandboxKey): Promise<readonly DenialEvent[]> {
    try {
      const stub = await this.rowStub(this.executionId(key));
      return stub ? await stub.denials() : [];
    } catch (err) {
      // Diagnostics must not throw into a consumer that is already rendering a
      // failure. An unreadable audit trail is reported as an empty one, loudly
      // in the substrate's own logs.
      console.error("denials: could not read the execution's denial events", err);
      return [];
    }
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
