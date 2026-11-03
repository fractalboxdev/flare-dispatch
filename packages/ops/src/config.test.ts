import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { opsConfigFrom, webhookSilentHours } from "./index.ts";

describe("runtime configuration", () => {
  it("reads the rendered vars, a JSON list as an array or its JSON text, and ignores other bindings", () => {
    const c = Effect.runSync(
      opsConfigFrom({
        OPERATORS: '["ops@acme.com"]',
        DISPATCHERS: ["ci.access"],
        WEBHOOK_SILENT_HOURS: "12",
        DB: {},
      }),
    );
    expect(c.OPERATORS).toEqual(["ops@acme.com"]);
    expect(c.DISPATCHERS).toEqual(["ci.access"]);
    expect(webhookSilentHours(c)).toBe(12);
    expect(webhookSilentHours(Effect.runSync(opsConfigFrom({})))).toBe(24);
  });

  it("fails a var that does not decode", () => {
    const err = Effect.runSync(Effect.flip(opsConfigFrom({ OPERATORS: "not json" })));
    expect(err.issues.length).toBeGreaterThan(0);
  });
});
