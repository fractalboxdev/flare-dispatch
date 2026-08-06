// Idempotency-key dedupe against real DO storage, inside workerd
// (`vitest.workers.config.ts`).
//
// ADR-0003 calls this the correctness backbone of the cross-worker contract:
// durable steps are at-least-once and `git push` is not, so a retried
// `execUnderGrant` carrying the same key must join the in-flight command or
// return its recorded receipt - never run the command twice.
//
// Two guards implement that and they cover different windows, so both are
// driven here. The recorded receipt in `ctx.storage.kv` covers a retry that
// arrives after the first one finished; the in-memory `running` map covers the
// window the record cannot, because `runTaskCommand`'s storage read and write
// straddle an await and two arrivals would otherwise both miss the record and
// both run.
//
// The container's I/O is the one thing stubbed: `writeFile` and `exec` are
// replaced on the live instance, since no container engine runs in the pool.
// Everything the dedupe depends on stays real - the object, its storage, the
// receipt it persists, and the map's lifetime.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SubstrateSandboxBase } from "./sandbox-do";

/**
 * The two container calls `executeCommand` makes, as own properties that shadow
 * the SDK's prototype methods. Typed loosely on purpose: the real signatures
 * carry session options and result shapes this suite has no opinion about, and
 * matching them exactly would be a fake of the SDK rather than a stub of it.
 */
type StubbedIO = {
  writeFile: (...args: unknown[]) => Promise<unknown>;
  exec: (command: string, ...rest: unknown[]) => Promise<{ exitCode: number; stdout: string }>;
};

const stubbable = (instance: SubstrateSandboxBase): StubbedIO =>
  instance as unknown as StubbedIO;

let seq = 0;
const freshSandbox = (): DurableObjectStub<SubstrateSandboxBase> =>
  env.SANDBOX_LEAN.get(
    env.SANDBOX_LEAN.idFromName(`dispatcher:dedupe-${++seq}-${crypto.randomUUID().slice(0, 8)}`),
  ) as DurableObjectStub<SubstrateSandboxBase>;

/**
 * Replace the container I/O on one live instance and count the command runs.
 *
 * `readLogTail` execs too, so only the script invocation is counted - the
 * question is how many times the *workload's* command ran, not how many times
 * the DO shelled out.
 */
function stubContainerIO(instance: SubstrateSandboxBase, opts: { delayMs?: number } = {}) {
  const runs: string[] = [];
  const target = stubbable(instance);
  target.writeFile = async () => ({});
  target.exec = async (command: string) => {
    if (command.startsWith("tail -c")) return { exitCode: 0, stdout: "output tail" };
    runs.push(command);
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    return { exitCode: 0, stdout: "" };
  };
  return runs;
}

const INPUT = {
  command: "pnpm test",
  idempotencyKey: "step-4",
  logPath: "runs/7/step-4.log",
  timeoutMs: 60_000,
  tailBytes: 4_096,
};

describe("runTaskCommand dedupe (ADR-0003) - a retry is the same work, not new work", () => {
  it("joins a command still in flight rather than starting a second one", async () => {
    const outcomes = await runInDurableObject(freshSandbox(), async (instance) => {
      const runs = stubContainerIO(instance, { delayMs: 40 });
      // Deliberately not awaited in turn: the second call has to land while the
      // first is still inside its exec, which is exactly the window the
      // recorded receipt cannot cover.
      const first = instance.runTaskCommand(INPUT);
      const second = instance.runTaskCommand(INPUT);
      const [a, b] = await Promise.all([first, second]);
      return { a, b, runs: runs.length };
    });

    expect(outcomes.runs).toBe(1);
    expect(outcomes.a.deduped).toBe(false);
    expect(outcomes.b.deduped).toBe(true);
    // The joiner gets the real receipt, not a placeholder: a consumer folding
    // this into a step result must see the same exit code either way.
    expect(outcomes.b.exitCode).toBe(outcomes.a.exitCode);
    expect(outcomes.b.tail).toBe(outcomes.a.tail);
  });

  it("returns the recorded receipt for a retry that arrives after the command finished", async () => {
    const stub = freshSandbox();
    const first = await runInDurableObject(stub, async (instance) => {
      stubContainerIO(instance);
      return instance.runTaskCommand(INPUT);
    });
    expect(first.deduped).toBe(false);

    // A separate RPC call, reading the receipt back out of storage.
    const retry = await runInDurableObject(stub, async (instance) => {
      const runs = stubContainerIO(instance);
      const receipt = await instance.runTaskCommand(INPUT);
      return { receipt, runs: runs.length };
    });
    expect(retry.runs).toBe(0);
    expect(retry.receipt).toEqual({ ...first, deduped: true });
  });

  it("runs a distinct step, so dedupe never swallows the next command", async () => {
    const outcome = await runInDurableObject(freshSandbox(), async (instance) => {
      const runs = stubContainerIO(instance);
      await instance.runTaskCommand(INPUT);
      const next = await instance.runTaskCommand({ ...INPUT, idempotencyKey: "step-5" });
      return { next, runs: runs.length };
    });
    expect(outcome.runs).toBe(2);
    expect(outcome.next.deduped).toBe(false);
  });

  it("records nothing for a command whose container died, so the retry re-runs it", async () => {
    // The receipt is written only after the container returned a result. A
    // command that rejected must leave no record, or a transient container
    // failure would be remembered forever as this step's outcome.
    const stub = freshSandbox();
    await expect(
      runInDurableObject(stub, async (instance) => {
        stubbable(instance).writeFile = async () => ({});
        stubbable(instance).exec = async () => {
          throw new Error("container died");
        };
        return instance.runTaskCommand(INPUT);
      }),
    ).rejects.toThrow("container died");

    const retry = await runInDurableObject(stub, async (instance) => {
      const runs = stubContainerIO(instance);
      const receipt = await instance.runTaskCommand(INPUT);
      return { receipt, runs: runs.length };
    });
    expect(retry.runs).toBe(1);
    expect(retry.receipt.deduped).toBe(false);
  });
});
