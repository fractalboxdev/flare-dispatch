import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CheckCommandTestStorage } from "./check-command-worker-fixture";
declare module "cloudflare:test" {
  interface ProvidedEnv {
    CHECK_COMMAND_STORAGE: DurableObjectNamespace<CheckCommandTestStorage>;
  }
}

describe("check command mutation-side persistence", () => {
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
