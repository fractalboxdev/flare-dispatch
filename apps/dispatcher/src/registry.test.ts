import { describe, expect, it } from "vitest";
import { lookupRun, triggersByEvent } from "./registry";

const CONTEXTFUL_REPO = "fractalboxdev/contextful";

describe("contextful runs", () => {
  const CONTEXTFUL_RUNS = ["contextful-gate", "contextful-cache-warm", "contextful-release", "contextful-measures", "contextful-protocol"];

  it("no webhook starts a contextful run", () => {
    const events = ["pull_request", "push", "pull_request_target", "check_suite", "workflow_dispatch", "release", "create"];
    const started = events.flatMap((event) =>
      triggersByEvent(event)
        .filter((m) => m.run.name.startsWith("contextful-"))
        .map((m) => m.run.name),
    );
    expect(started).toEqual([]);
  });

  it("a v-tag push to contextful starts no release", () => {
    const sha = "a".repeat(40);
    const payload = { repository: { full_name: CONTEXTFUL_REPO }, ref: "refs/tags/v1.2.3", after: sha };
    const fired = triggersByEvent("push").filter((m) => m.trigger.gate?.({ payload } as never));
    expect(fired.filter((m) => m.run.name.startsWith("contextful-"))).toEqual([]);
  });

  it("keeps every contextful run dispatchable by name, with no triggers or schedules", () => {
    for (const name of CONTEXTFUL_RUNS) {
      const run = lookupRun(name);
      expect(run, name).toBeDefined();
      expect(run?.triggers, name).toEqual([]);
      expect(run?.schedules, name).toEqual([]);
    }
  });
});
