// The substrate's container Durable Objects — one class per image class
// (specs/adr/0010-named-image-classes-policy-selected.md), all sharing one
// body. Ported from fractalbot's reference sandbox DO with two structural
// changes its spec called for:
//
// 1. **Ticket-gated boot** (ADR-0004): `ensure()` refuses — typed, fail-closed
//    — unless the facade stored a valid admission ticket first. Calling
//    `ensure()` without one is the success-criterion test in specs/platform.md.
// 2. **Handles live here** (ADR-0003): backup handles are stored in this DO's
//    own storage, keyed by recipe version — the substrate never calls back
//    into a consumer.
//
// Exactly one command-running method: `runTaskCommand` — dedupe on an
// idempotency key, output to the artifact mount instead of into the isolate, a
// clamped tail. The egress grant that decides where a command may reach lives
// in the fence (`engine/exec-fence.ts`), which `guardedExec` runs with this
// DO's own id as the grant binding. The SDK's inherited `exec` still exists on
// this class, but no consumer holds a DO binding — the facade is the only
// caller (ADR-0003), and that is what makes the fence structural.
//
// `implements GuardedSandbox` is load-bearing rather than decorative: the six
// GrantTarget methods and `killAllProcesses` live on the real base class,
// which plain-node tests cannot import — the compiler is the only thing that
// can catch an SDK rename breaking the fence.
import { Sandbox, getSandbox, type DirectoryBackup } from "@cloudflare/sandbox";
import type {
  EnsureOutcome,
  ExecReceipt,
  SubstrateRecipe,
  SubstrateRepoRef,
} from "@fractalboxdev/flare-dispatch-substrate-contract";
import { repoSlug } from "@fractalboxdev/flare-dispatch-substrate-contract";
import { recordDenialD1 } from "./admission/denials-d1";
import { verifyTicket } from "./admission/ticket";
import {
  applyGrant,
  buildGrant,
  grantParamsFor,
  revokeGrant,
  serveGrantedRequest,
  type Grant,
  type GrantParams,
  type OutboundContext,
} from "./engine/egress";
import { runFence, type FenceInput, type FenceOutcome, type GuardedSandbox } from "./engine/exec-fence";
import { redactCapturedGitConfigCommand, scrubRemotesCommand } from "./engine/git-scrub";
import { clampTailBytes, nonceLogPath, shellQuote } from "./engine/policy";
import { resolveSubstrateSecret } from "./secrets";
import type { Env } from "./env";

/** Namespaced so nothing here collides with the SDK's own storage keys. */
const TICKET_KEY = "sub:ticket";
const IDENTITY_KEY = "sub:identity";
const LIFECYCLE_KEY = "sub:lifecycle";
const GENERATION_KEY = "sub:generation";
const HANDLES_KEY = "sub:handles";
/** One record per completed command, keyed by its idempotency key. */
const EXEC_KEY_PREFIX = "sub:exec:";

/** Reading a bounded tail is a local file read; it must not inherit a build's budget. */
const TAIL_READ_TIMEOUT_MS = 15_000;

/** Credential scrubbing walks the workspace; generous, but never a build's budget. */
const SCRUB_TIMEOUT_MS = 60_000;

const WORKSPACE_DIR = "/workspace";
const ARTIFACTS_DIR = "/artifacts";

/**
 * Matches the SDK default. The TTL deletes nothing — it only makes
 * `restoreBackup` reject — so the R2 lifecycle rule on `backups/` is what
 * actually reclaims objects; this decides when a handle stops being a cache
 * hit. The recipe is the source of truth; every backup is a cache.
 */
const BACKUP_TTL_SECONDS = 259_200;

type SandboxLifecycle = "running" | "draining" | "stopped";

type SandboxHandles = {
  /** Snapshot of the working tree. Restored BEFORE `deps` — parent, then child. */
  tree?: DirectoryBackup;
  deps?: DirectoryBackup;
  depsKey?: string;
  recipeVersion: number;
  updatedAt: number;
};

type StoredIdentity = { consumer: string; key: string };

export class SubstrateSandboxBase
  extends Sandbox<Env>
  implements GuardedSandbox
{
  /**
   * Deny-all egress — the whole security posture of the class (ADR-0005,
   * verified against `@cloudflare/containers@0.3.7` internals; the pin is a
   * security surface, ADR-0011).
   *
   * The two properties act together and neither is sufficient alone.
   * `enableInternet = false` withholds the platform's direct network access;
   * `allowedHosts = []` engages the interception gate and then matches
   * nothing. The empty array is load-bearing: `shouldInterceptAllOutbound()`
   * tests `effectiveAllowedHosts !== undefined`, so `[]` turns interception ON
   * (unset would leave the proxy out of the path entirely), and
   * `ContainerProxy.fetch` then answers 520 for every hostname before any
   * `outboundByHost` handler is consulted — which is why a grant is two
   * calls, an admission and a policy, rather than a handler alone.
   *
   * `deniedHosts` is intentionally left unset: an empty deny list denies
   * nothing, and grants carry the write-sink denies per apply.
   */
  override enableInternet = false;
  override allowedHosts: string[] = [];

  /**
   * Idle timeout, from a var so changing it is not a deploy. `keepAlive` is
   * deliberately never set — a task that runs keeps resetting this timer
   * through its own activity, and a leaked flag pins an idle container
   * silently (it costs money without failing).
   */
  override sleepAfter = this.env.SANDBOX_SLEEP_AFTER || "10m";

  // -------------------------------------------------------------------------
  // Admission gate (ADR-0004)
  // -------------------------------------------------------------------------

  /**
   * Store the admission ticket + identity, verified before storing. Called by
   * the facade at admit; consumers cannot reach this object at all (ADR-0003).
   * Verification here AND at ensure() is deliberate: the store-time check
   * refuses a facade bug loudly at admit; the boot-time check is the gate.
   */
  async admit(consumer: string, key: string, ticket: string): Promise<{ ok: boolean; reason?: string }> {
    const verdict = await verifyTicket(this.env.TICKET_SECRET, ticket, { consumer, key }, Date.now());
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    this.ctx.storage.kv.put(IDENTITY_KEY, { consumer, key } satisfies StoredIdentity);
    this.ctx.storage.kv.put(TICKET_KEY, ticket);
    return { ok: true };
  }

  /** The boot gate: a valid, unexpired ticket for this object's identity, or a reason. */
  private async ticketGate(): Promise<string | undefined> {
    const identity = this.ctx.storage.kv.get<StoredIdentity>(IDENTITY_KEY);
    const ticket = this.ctx.storage.kv.get<string>(TICKET_KEY);
    if (!identity) return "no admission ticket";
    const verdict = await verifyTicket(this.env.TICKET_SECRET, ticket, identity, Date.now());
    return verdict.ok ? undefined : verdict.reason;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async lifecycle(): Promise<SandboxLifecycle> {
    return this.ctx.storage.kv.get<SandboxLifecycle>(LIFECYCLE_KEY) ?? "stopped";
  }

  async setLifecycle(state: SandboxLifecycle): Promise<void> {
    this.ctx.storage.kv.put(LIFECYCLE_KEY, state);
  }

  // The SDK's own onStart/onStop do real work (session setup, transport
  // teardown), so both delegate. Recording the state after `super` rather than
  // before means a start that throws does not leave the flag claiming
  // `running` for a container that never came up.
  override async onStart(): Promise<void> {
    await super.onStart();
    await this.setLifecycle("running");
  }

  override async onStop(): Promise<void> {
    await super.onStop();
    await this.setLifecycle("stopped");
  }

  // -------------------------------------------------------------------------
  // ensure() / checkpoint()
  // -------------------------------------------------------------------------

  /**
   * Bring the container to the state the recipe describes — behind the ticket
   * gate, memoized on an in-flight promise keyed by recipe version so two
   * concurrent callers with one version join one restore rather than racing
   * two against the same filesystem.
   */
  async ensure(recipe: SubstrateRecipe): Promise<EnsureOutcome> {
    const gateReason = await this.ticketGate();
    if (gateReason !== undefined)
      return { ok: false, refusal: { kind: "ticket-rejected", reason: gateReason } };

    const inFlight = this.ensuring;
    if (inFlight && inFlight.version === recipe.version) return inFlight.promise;

    const promise = this.runEnsure(recipe).finally(() => {
      if (this.ensuring?.promise === promise) this.ensuring = undefined;
    });
    this.ensuring = { version: recipe.version, promise };
    return promise;
  }

  private ensuring?: { version: number; promise: Promise<EnsureOutcome> };
  private draining?: Promise<void>;

  /**
   * Commands running right now, by idempotency key, each with the wall-clock
   * deadline its own `timeoutMs` implies. Closes the check-then-act race in
   * `runTaskCommand` (the storage read and write straddle an await), and is
   * what `onActivityExpired` reads to refuse a snapshot over a live
   * filesystem.
   */
  private readonly running = new Map<
    string,
    { deadline: number; promise: Promise<ExecReceipt> }
  >();

  private async runEnsure(recipe: SubstrateRecipe): Promise<EnsureOutcome> {
    await this.awaitDrain();
    await this.revokeStaleGrant(recipe);

    const handles = this.readHandles();

    // Fast path. `ensure()` runs inside every exec rather than once up front,
    // so reusing a live container has to cost nothing.
    if (
      (await this.lifecycle()) === "running" &&
      handles?.recipeVersion === recipe.version
    ) {
      return { ok: true, generation: this.generation(), rebuilt: false };
    }

    // Everything below resolves to the same slow path. BACKUP_EXPIRED,
    // BACKUP_NOT_FOUND, an R2 error and a base image that moved under the
    // snapshot are all cache misses rather than errors — which is what stops
    // expiry from becoming an outage.
    if (!(await this.tryRestore(recipe, handles))) {
      await this.cleanRebuild(recipe);
    }
    await this.mountArtifacts();

    // Record the version this tree was built to, so the fast path above can
    // recognise a live container on the next call — and so a later snapshot
    // keys its handle to the right recipe.
    await this.bindRecipeVersion(recipe.version);

    return { ok: true, generation: this.bumpGeneration(), rebuilt: true };
  }

  /** True when the recipe's tree was restored. Never throws — a miss is a miss. */
  private async tryRestore(
    recipe: SubstrateRecipe,
    handles?: SandboxHandles,
  ): Promise<boolean> {
    // A handle from a different recipe version describes a different execution.
    if (!handles?.tree || handles.recipeVersion !== recipe.version) return false;
    try {
      // Parent first, child second. Restoring `/workspace` on top of a dep
      // cache already restored at `/workspace/node_modules` destroys it every
      // time — on the exact path built to avoid a cold install.
      await this.restoreBackup(handles.tree);
      if (handles.deps) await this.restoreBackup(handles.deps);
      return true;
    } catch (err) {
      console.error("restore failed, falling through to a clean rebuild", err);
      return false;
    }
  }

  /**
   * Rebuild from the recipe, which is the source of truth. "Clean" is
   * load-bearing: a partial restore leaves `/workspace` non-empty and
   * `git clone` refuses to run into it, so the wipe happens before the clone.
   */
  private async cleanRebuild(recipe: SubstrateRecipe): Promise<void> {
    await this.wipeWorkspace();
    if (!recipe.repo) return; // a shell with nothing to clone — and no egress

    // The clone is the only thing `ensure()` does that leaves the container,
    // and under `enableInternet = false` / `allowedHosts = []` it is denied
    // unless a grant is open while it runs. The grant is opened here rather
    // than by the caller, and that is forced rather than chosen: the fence
    // revokes unconditionally at its top as a backstop, so a grant applied
    // before `ensure()` would be destroyed by the very call that needs it.
    // Same policy the fence uses — read-only, scoped to the recipe's repo, and
    // deliberately WITHOUT the recipe's profiles: a clone needs github.com and
    // nothing a profile adds, so no credentialed host is admitted here.
    const grant = this.repoGrant(recipe.repo, recipe.lfs);
    await applyGrant(this, grant);
    try {
      await this.gitCheckout(`https://github.com/${repoSlug(recipe.repo)}.git`, {
        branch: recipe.repo.ref,
        targetDir: WORKSPACE_DIR,
        // The recipe names one ref; history beyond it is bytes nobody reads.
        depth: 1,
      });
    } finally {
      // Unconditional: a clone that failed halfway must not leave github.com
      // admitted for whatever runs next.
      await revokeGrant(this, grant);
    }

    // Scrub before any workload command can read `.git/config` (ADR-0006). The
    // substrate's own clone is unauthenticated today, so this rewrites a URL
    // that is already clean — deliberately: the scrub is what makes an
    // authenticated clone safe to add, and a step that only starts running when
    // it first matters is a step nobody has ever seen work.
    await this.scrubGitRemotes(repoSlug(recipe.repo));
  }

  /**
   * Rewrite the workspace's remotes to their credential-free form. Never
   * throws: on a tree with no remote (a shell recipe, a partial clone) the
   * command is a no-op, and a scrub that cannot run must not take down an
   * `ensure()` whose clone succeeded — the capture-time redaction is the
   * backstop that decides whether state may be persisted.
   */
  private async scrubGitRemotes(slug: string): Promise<void> {
    try {
      await this.exec(scrubRemotesCommand(WORKSPACE_DIR, slug), {
        timeout: SCRUB_TIMEOUT_MS,
      });
    } catch (err) {
      console.error("post-clone remote scrub failed", err);
    }
  }

  /** The read-only, repo-scoped grant a clone of this recipe needs. */
  private repoGrant(repo: SubstrateRepoRef, lfs?: boolean): Grant {
    return buildGrant(grantParamsFor(repo, this.ctx.id.toString(), { lfs }));
  }

  /**
   * The fence's backstop, run before anything else `ensure()` does. A caller
   * that died between apply and its `finally` leaves the grant open in DO
   * state, where it survives eviction — so the next call starts by assuming
   * one leaked. Revoking a grant that was never applied is a no-op, and it
   * deliberately does not touch the deny list.
   */
  private async revokeStaleGrant(recipe: SubstrateRecipe): Promise<void> {
    if (!recipe.repo) return;
    try {
      // The recipe's FULL grant, profiles included — a leaked handler mapping
      // on a credentialed host is the one worth clearing most, and a repo-only
      // backstop would leave `api.cloudflare.com` admitted with its injector
      // still bound.
      await revokeGrant(
        this,
        buildGrant(
          grantParamsFor(recipe.repo, this.ctx.id.toString(), {
            lfs: recipe.lfs,
            profiles: recipe.profiles,
          }),
        ),
      );
    } catch (err) {
      // Best effort by construction: a revoke that cannot run leaves the
      // deny-all posture in place, which is the safe direction.
      console.error("backstop revoke failed", err);
    }
  }

  private async wipeWorkspace(): Promise<void> {
    try {
      await this.deleteFile(WORKSPACE_DIR);
    } catch (err) {
      // Already absent on a cold container, which is the normal case.
      console.debug("workspace wipe found nothing to remove", err);
    }
    await this.mkdir(WORKSPACE_DIR, { recursive: true });
  }

  /**
   * `/artifacts` is where exec streams its logs, so it has to exist before any
   * command runs. Prefixed per container: one bucket, and two executions must
   * not be able to read or overwrite each other's output.
   */
  private async mountArtifacts(): Promise<void> {
    try {
      await this.mountBucket("BACKUP_BUCKET", ARTIFACTS_DIR, {
        prefix: `artifacts/${this.ctx.id.toString()}/`,
      });
    } catch (err) {
      // A missing artifacts mount costs logs, not correctness — the receipt
      // still carries its tail inline. Failing ensure() here would turn a
      // degraded log path into a dead execution.
      console.error("artifacts mount failed; logs will not persist", err);
    }
  }

  // -------------------------------------------------------------------------
  // The exec surface
  // -------------------------------------------------------------------------

  /**
   * Run the whole fence — approval floor, stale-revoke, ensure, apply, run,
   * kill-before-revoke — against this object, with this object's own id as
   * the grant binding (ADR-0003: the substrate derives the grant from the
   * recipe and its own DO id; a consumer never sees either).
   */
  async guardedExec(input: Omit<FenceInput, "containerId">): Promise<FenceOutcome> {
    return runFence(this, { ...input, containerId: this.ctx.id.toString() });
  }

  /**
   * Run one command in the container and return a receipt: dedupe, run, log,
   * clamp. No grant is opened here and no `ensure()` runs — the fence wraps
   * this with both.
   */
  async runTaskCommand(input: {
    command: string;
    idempotencyKey: string;
    logPath: string;
    timeoutMs: number;
    tailBytes: number;
  }): Promise<ExecReceipt> {
    // Durable steps are at-least-once and `git push` is not. A retried step
    // arrives with the same key and must be recognised as the same work
    // rather than run twice (ADR-0003's correctness backbone).
    const key = `${EXEC_KEY_PREFIX}${input.idempotencyKey}`;
    const recorded = this.ctx.storage.kv.get<ExecReceipt>(key);
    if (recorded) return { ...recorded, deduped: true };

    // The read above and the write below straddle an await, so the record
    // alone is a check-then-act: two arrivals with one key both miss it and
    // both run. This map is the guard — a retried facade call joins the
    // in-flight command.
    const inFlight = this.running.get(input.idempotencyKey);
    if (inFlight) return { ...(await inFlight.promise), deduped: true };

    const promise = this.executeCommand(input, key);
    this.running.set(input.idempotencyKey, {
      deadline: Date.now() + input.timeoutMs,
      promise,
    });
    try {
      return await promise;
    } finally {
      this.running.delete(input.idempotencyKey);
    }
  }

  private async executeCommand(
    input: { command: string; idempotencyKey: string; logPath: string; timeoutMs: number; tailBytes: number },
    key: string,
  ): Promise<ExecReceipt> {
    // One nonce for the pair, so the script and its log are traceable to each
    // other and neither name is predictable from inside the container.
    const nonce = crypto.randomUUID();
    const logFile = `${ARTIFACTS_DIR}/${nonceLogPath(input.logPath, nonce)}`;
    const scriptFile = `/tmp/step-${nonce}.sh`;

    // The command goes into a file, not into the outer shell line. Inline, a
    // `}` inside the command closes the `{ … }` group early: the rest of the
    // line escapes the redirect and the exit code comes from an empty group.
    // Quoting is not the fix — it breaks every pipeline and heredoc a command
    // legitimately wants. In a script file nothing the command contains can
    // restructure the outer line.
    await this.writeFile(scriptFile, input.command);

    const startedAt = Date.now();
    // Output is redirected inside the container rather than returned and then
    // written out: `exec` buffers stdout into this isolate as a string, and a
    // repo build's log is a multi-megabyte allocation on its way to a file we
    // already have a path for.
    const result = await this.exec(
      `sh ${shellQuote(scriptFile)} > ${shellQuote(logFile)} 2>&1`,
      { timeout: input.timeoutMs, cwd: WORKSPACE_DIR },
    );

    const { tail, truncated } = await this.readLogTail(logFile, input.tailBytes);
    const receipt: ExecReceipt = {
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      deduped: false,
      tail,
      truncated,
    };

    // Recorded only when the container returned a result. A command whose
    // container died mid-flight rejects here and is never recorded, so the
    // retry re-runs it.
    this.ctx.storage.kv.put(key, receipt);
    return receipt;
  }

  /**
   * Read back the tail of a command's log, in the container. `tail -c` rather
   * than a file read, so the bytes that cross into this isolate are bounded by
   * the caller's budget instead of the log's size; one extra byte is requested
   * deliberately — getting it back is how we know there was more. Never
   * throws: the exit code is the result, and losing the tail must not turn a
   * degraded log into a failed execution.
   */
  private async readLogTail(
    logFile: string,
    tailBytes: number,
  ): Promise<{ tail: string; truncated: boolean }> {
    try {
      const out = await this.exec(
        `tail -c ${tailBytes + 1} ${shellQuote(logFile)}`,
        { timeout: TAIL_READ_TIMEOUT_MS },
      );
      return clampTailBytes(out.stdout ?? "", tailBytes);
    } catch (err) {
      console.error("could not read the command log tail", logFile, err);
      return { tail: "", truncated: false };
    }
  }

  // -------------------------------------------------------------------------
  // checkpoint / abort
  // -------------------------------------------------------------------------

  /**
   * Turn-boundary checkpoint: snapshot, then stop. The stop is in a `finally`
   * because a failed snapshot must not leave a container running and billing —
   * the snapshot is a cache, the stop is the money.
   */
  async checkpoint(reason: string): Promise<void> {
    try {
      await this.snapshot(reason);
    } finally {
      try {
        await this.stop();
      } catch (err) {
        // Safe on an already-stopped container.
        console.debug("stop on an already-stopped container", err);
      }
    }
  }

  /** Kill + stop, skipping the snapshot — the off-switch half (ADR-0003). */
  async abortExec(): Promise<{ killed: number }> {
    let killed = 0;
    try {
      killed = await this.killAllProcesses();
    } catch (err) {
      console.debug("abort kill on a container that is already gone", err);
    }
    try {
      await this.stop();
    } catch (err) {
      console.debug("abort stop on an already-stopped container", err);
    }
    return { killed };
  }

  /**
   * The idle-expiry trigger. `super.onActivityExpired()`, never `this.stop()` —
   * the SDK's override IS the keepAlive mechanism. The early return closes a
   * real window: exec timeouts run past the idle alarm, and a snapshot over a
   * filesystem a build is still writing into records a torn tree as the
   * restore point. Declining costs nothing — the SDK re-arms and the hook
   * fires again — and it is bounded by the command's own deadline, so a hung
   * command cannot pin an idle container.
   */
  override async onActivityExpired(): Promise<void> {
    if (this.commandInFlight()) return;
    try {
      await this.snapshot("idle-expired");
    } finally {
      await super.onActivityExpired();
    }
  }

  /** True while a command is running and still inside its own timeout budget. */
  private commandInFlight(): boolean {
    const now = Date.now();
    for (const run of this.running.values()) if (now < run.deadline) return true;
    return false;
  }

  /**
   * Snapshot `/workspace` and record the handle locally (ADR-0003: handles are
   * the substrate's, keyed by recipe version). Never throws — a failed backup
   * is a cache miss, and the next `ensure()` rebuilds from the recipe.
   * `draining` is published for the whole window because the snapshot takes
   * seconds to minutes, and work arriving inside it must not drive a container
   * that is about to stop.
   */
  private async snapshot(reason: string): Promise<void> {
    this.draining = (async () => {
      await this.setLifecycle("draining");
      try {
        // The capture chokepoint (ADR-0006). Everything a workload wrote is
        // about to become an R2 object with a three-day TTL, so the credential
        // sweep runs here and its failure is a hard stop: no backup is strictly
        // better than a backup carrying an installation token, and the recipe
        // rebuilds the tree either way.
        await this.redactCapturedCredentials();
        // `gitignore: true` keeps `node_modules` and build output out of the
        // authored-state snapshot — those are derived, and rebuilding them is
        // what a dep cache is for.
        const tree = await this.createBackup({
          dir: WORKSPACE_DIR,
          name: `${reason}-${Date.now()}`,
          ttl: BACKUP_TTL_SECONDS,
          gitignore: true,
        });
        const previous = this.readHandles();
        this.ctx.storage.kv.put(HANDLES_KEY, {
          ...previous,
          tree,
          recipeVersion: previous?.recipeVersion ?? this.ensuring?.version ?? 0,
          updatedAt: Date.now(),
        } satisfies SandboxHandles);
      } catch (err) {
        console.error("checkpoint failed; next ensure() will rebuild", err);
      } finally {
        await this.setLifecycle("stopped");
      }
    })();
    try {
      await this.draining;
    } finally {
      this.draining = undefined;
    }
  }

  /**
   * Redact credentials from the tree about to be captured (ADR-0006), throwing
   * if the sweep does not complete.
   *
   * Throwing is the whole design. The caller's `catch` turns it into "checkpoint
   * failed; next ensure() will rebuild", which is exactly the outcome we want:
   * the execution continues, the backup is skipped, and no object carrying a
   * token lands in R2 where its lifetime is the bucket's rather than the token's.
   */
  private async redactCapturedCredentials(): Promise<void> {
    const result = await this.exec(redactCapturedGitConfigCommand(WORKSPACE_DIR), {
      timeout: SCRUB_TIMEOUT_MS,
    });
    if (result.exitCode !== 0)
      throw new Error(
        `credential redaction exited ${result.exitCode}; refusing to capture this tree`,
      );
  }

  /**
   * Wait out a snapshot in flight. Only an in-memory promise is waited on: a
   * *persisted* `draining` means the object was evicted mid-snapshot — and
   * eviction takes the container with it, so a rebuild is already the answer.
   */
  private async awaitDrain(): Promise<void> {
    if (this.draining) await this.draining.catch(() => {});
  }

  /** Record the recipe version a snapshot should be keyed to. Facade-set at ensure. */
  async bindRecipeVersion(version: number): Promise<void> {
    const previous = this.readHandles();
    if (previous?.recipeVersion === version) return;
    this.ctx.storage.kv.put(HANDLES_KEY, {
      ...previous,
      recipeVersion: version,
      updatedAt: Date.now(),
    } satisfies SandboxHandles);
  }

  private readHandles(): SandboxHandles | undefined {
    return this.ctx.storage.kv.get<SandboxHandles>(HANDLES_KEY) ?? undefined;
  }

  private generation(): number {
    return this.ctx.storage.kv.get<number>(GENERATION_KEY) ?? 0;
  }

  private bumpGeneration(): number {
    const next = this.generation() + 1;
    this.ctx.storage.kv.put(GENERATION_KEY, next);
    return next;
  }
}

/** The lean CI class — the dispatcher's default pool at adoption. */
export class SubstrateSandboxLean extends SubstrateSandboxBase {}
/** Chromium-baked class for browser/e2e workloads. */
export class SubstrateSandboxBrowser extends SubstrateSandboxBase {}
/** Agent-tier class (review/self-heal toolchain). */
export class SubstrateSandboxAgent extends SubstrateSandboxBase {}
/** fractalbot's task class (OpenCode harness et al. — image lands separately). */
export class SubstrateSandboxTask extends SubstrateSandboxBase {}

/**
 * Resolve the container for one execution. `normalizeId: true` is pinned
 * rather than left to default — the SDK warns it "will default to true in a
 * future version", and leaving it unset means an SDK bump silently re-points
 * every id at a different Durable Object. Every call site that reaches a
 * substrate container goes through this function; the options here are the
 * one derivation.
 */
export function sandboxByName(
  ns: DurableObjectNamespace<SubstrateSandboxBase>,
  doName: string,
): SubstrateSandboxBase {
  return getSandbox(ns, doName, { normalizeId: true }) as unknown as SubstrateSandboxBase;
}

/**
 * The egress handlers each class exposes, with the denial recorder wired to
 * D1 (ADR-0005: every denial is a per-execution event, never surfaced into
 * the container) and the secret resolver wired to the Worker's own environment
 * (ADR-0006: this is the only place a credential value exists on the request
 * path, and it exists there for one `fetch`).
 *
 * Registered by assignment rather than a `static outboundHandlers = …` field:
 * the base declares `outboundHandlers` as a static *accessor* whose setter
 * populates the SDK's registry (keyed by class name — what `setOutboundByHost`
 * later looks up). A class field would shadow that accessor under
 * `useDefineForClassFields` semantics and register nothing — and the failure
 * is invisible until a grant is applied, at which point `setOutboundByHost`
 * throws "Outbound handler method 'publicRepo' not found".
 */
const handlersFor = () => ({
  publicRepo: (
    req: Request,
    env: Env,
    ctx: OutboundContext<GrantParams>,
  ): Promise<Response> =>
    serveGrantedRequest(req, ctx, {
      fetch,
      recordDenial: (event) => {
        void recordDenialD1(env.ADMISSION_DB, ctx.containerId, event).catch((err) =>
          console.error("denial record failed", err),
        );
      },
      resolveSecret: (name) => resolveSubstrateSecret(env, name),
    }),
});

SubstrateSandboxLean.outboundHandlers = handlersFor();
SubstrateSandboxBrowser.outboundHandlers = handlersFor();
SubstrateSandboxAgent.outboundHandlers = handlersFor();
SubstrateSandboxTask.outboundHandlers = handlersFor();
