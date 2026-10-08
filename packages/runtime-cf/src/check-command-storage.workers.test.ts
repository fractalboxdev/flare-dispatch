import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CheckCommandTestStorage } from "./check-command-worker-fixture";
import { commandFingerprint, makeCheckCommandOwner } from "./check-command";
declare module "cloudflare:test" {
  interface ProvidedEnv {
    CHECK_COMMAND_STORAGE: DurableObjectNamespace<CheckCommandTestStorage>;
  }
}

describe("check command mutation-side persistence", () => {
  it("reconstructed durable owners retain preparation and atomically claim one launch", async () => {
    const id = env.CHECK_COMMAND_STORAGE.newUniqueId();
    const stub = env.CHECK_COMMAND_STORAGE.get(id);
    let launches = 0;
    const box = {
      async writeFile() { return { success: true }; },
      async startProcess() { launches++; },
      async getProcess() { return launches > 0 ? { status: "running" } : null; },
      async exec() { throw new Error("no spool access in preparation"); },
    };
    const owner = () => makeCheckCommandOwner({
      load: (key) => env.CHECK_COMMAND_STORAGE.get(id).load(key),
      reserve: (key, value) => env.CHECK_COMMAND_STORAGE.get(id).reserve(key, value),
      save: (key, value, expected) => env.CHECK_COMMAND_STORAGE.get(id).save(key, value, expected),
    }, box, () => 1000);
    const candidate = { id: "native-preparation", container: { id: "box" },
      fingerprint: await commandFingerprint("command", undefined, {}, 60, "box"), startedAt: 1000, deadline: 61000 };
    const handles = await Promise.all(Array.from({ length: 12 }, (_, n) => owner().prepare({
      ...candidate, startedAt: 1000 + n, deadline: 61000 + n,
    })));
    expect(handles.every((handle) => JSON.stringify(handle) === JSON.stringify(handles[0]))).toBe(true);
    expect(launches).toBe(0);
    await stub.reconstruct(`check-command:${candidate.id}`);
    const persisted = await owner().prepare({ ...candidate, startedAt: 2000, deadline: 62000 });
    expect(persisted).toEqual(handles[0]);
    await Promise.allSettled(handles.map((handle) => owner().start({ handle, command: "command" })));
    expect(launches).toBe(1);
  });
  it("concurrent durable reservations claim once and reconstructed clients preserve the intent", async () => {
    const id = env.CHECK_COMMAND_STORAGE.newUniqueId();
    const first = env.CHECK_COMMAND_STORAGE.get(id);
    const claimed = await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        first.reserve("command", { intent: "before launch", first: n }),
      ),
    );
    expect(claimed.filter(Boolean)).toHaveLength(1);
    const recorded = await first.load("command");
    const generation = await first.generationId();
    const fresh = await first.reconstruct("command");
    expect(fresh.generation).not.toBe(generation);
    expect(fresh.valueJson).toEqual(JSON.stringify(recorded));
    const reconstructed = env.CHECK_COMMAND_STORAGE.get(id);
    expect(await reconstructed.reserve("command", { intent: "second launch" })).toBe(false);
    expect(await reconstructed.load("command")).toEqual(recorded);
    expect(await reconstructed.save("command", { terminal: 7 }, { wrong: true })).toBe(false);
    expect(await reconstructed.save("command", { terminal: 7 }, recorded)).toBe(true);
    expect(await env.CHECK_COMMAND_STORAGE.get(id).load("command")).toEqual({ terminal: 7 });
  });
});
