import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { nativeWorkflowId, readNativeWorkflowPolicy } from "./native-workflow-policy";
import { nativeCommandDigest } from "@fractalboxdev/flare-dispatch-core";

const request = { repo: "owner/context", head: "1".repeat(40), base: "2".repeat(40), executor_ref: "3".repeat(40),
  nonce: "native-0123456789abcdef", target: "aarch64-pc-windows-msvc" as const, mode: "gate" as const, profile: "" as const,
  command_sha256: "e964c83ffcc2427c138b484a6fc61f7ebcf70b59186899176e48da89516bb2da" };
const policy = { repo: request.repo, executor_ref: request.executor_ref, timeoutSec: 60, pollIntervalSec: 30 };

describe("native Workflow configured identity", () => {
  it("uses the full admitted request identity independently of caller property order",async()=>{
    const reverse=Object.fromEntries(Object.entries(request).reverse()) as typeof request;
    expect(await nativeWorkflowId(reverse)).toBe(await nativeWorkflowId(request));
    for(const changed of [{head:"4".repeat(40)},{base:"4".repeat(40)},{executor_ref:"4".repeat(40)},
      {nonce:"native-ffffffffffffffff"},{repo:"owner/other"}])
      {
        const candidate={...request,...changed};
        const command_sha256=await Effect.runPromise(nativeCommandDigest(candidate));
        expect(await nativeWorkflowId({...candidate,command_sha256})).not.toBe(await nativeWorkflowId(request));
      }
  });
  it("requires explicit positive duration and polling configuration",async()=>{
    expect(await Effect.runPromise(readNativeWorkflowPolicy(JSON.stringify(policy)))).toEqual(policy);
    for(const changed of [{timeoutSec:0},{timeoutSec:-1},{pollIntervalSec:0},{pollIntervalSec:NaN},{pollIntervalSec:Number.MAX_SAFE_INTEGER+1}])
      await expect(Effect.runPromise(readNativeWorkflowPolicy(JSON.stringify({...policy,...changed})))).rejects.toThrow();
    const {pollIntervalSec:_poll,...missingPoll}=policy;
    await expect(Effect.runPromise(readNativeWorkflowPolicy(JSON.stringify(missingPoll)))).rejects.toThrow();
    await expect(Effect.runPromise(readNativeWorkflowPolicy(JSON.stringify({...policy,token:"fixture-forbidden"})))).rejects.toThrow();
  });
});
