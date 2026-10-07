import { DurableObject } from "cloudflare:workers";
import { checkCommandStorage } from "./check-command-storage";

/** Storage-only fixture: no Sandbox, container, credential or external command. */
export class CheckCommandTestStorage extends DurableObject {
  private readonly generation = crypto.randomUUID();
  generationId() {
    return this.generation;
  }
  async reconstruct(key: string) {
    const fresh = new CheckCommandTestStorage(this.ctx, this.env);
    return {
      generation: fresh.generation,
      valueJson: JSON.stringify(await fresh.load(key)) ?? "null",
    };
  }
  reserve(key: string, value: unknown) {
    return checkCommandStorage(this.ctx.storage).reserve(key, value);
  }
  load(key: string) {
    return checkCommandStorage(this.ctx.storage).load(key);
  }
  save(key: string, value: unknown, expected: unknown) {
    return checkCommandStorage(this.ctx.storage).save(key, value, expected);
  }
}
export default {
  fetch() {
    return new Response("storage fixture");
  },
};
