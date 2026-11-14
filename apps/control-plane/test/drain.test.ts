// The settle-time drain's wiring (MAMEKO-HOST-064): the committed template binds `MAMEKO_DRAIN` to this Worker's own
// `MamekoDrain` entrypoint, which the Worker module exports, and a deploy without the App drains nothing through it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc, placeholderOverlay, renderTemplate } from "@fractalboxdev/flare-dispatch-ops";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ControlPlaneEnv } from "../src/config.ts";
import { drainExecution, MamekoDrain } from "../src/drain.ts";
import * as worker from "../src/worker.ts";

const template = readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8");

describe("the settle-time drain", () => {
  it("binds MAMEKO_DRAIN to the Worker's own MamekoDrain entrypoint, which the Worker exports", async () => {
    const config = parseJsonc(
      await Effect.runPromise(renderTemplate("control-plane", template, placeholderOverlay)),
    ) as { name: string; services: { binding: string; service: string; entrypoint: string }[] };
    expect(config.services).toContainEqual({
      binding: "MAMEKO_DRAIN",
      service: config.name,
      entrypoint: "MamekoDrain",
    });
    expect(worker.MamekoDrain).toBe(MamekoDrain);
  });

  it("drains nothing on a deploy without the App, whose tick has no actuator", async () => {
    const env = { PLANE_ID: "flare-dispatch", DB: {} } as unknown as ControlPlaneEnv;
    await expect(drainExecution(env)("01JDZ8Q6V3M2K9T4WXYZ5DRAIN")).resolves.toBeUndefined();
  });
});
