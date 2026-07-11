// self-heal-pr run tests — driven through the CF test runtime with a canned
// sandbox program (command-substring → ExecResult), seeded config, and an
// incident/v1 pack. Asserts the verify→writeback gate: a verified fix stages a
// writeback (⇒ PR), an unverified one is silent, a non-command repro skips.

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalbox/flare-dispatch-core/testing";
import type { IncidentT } from "@fractalbox/flare-dispatch-core";
import { selfHealPr } from "./self-heal-pr";

const baseIncident: IncidentT = {
  contractVersion: "v1",
  incidentId: "ci:owner_name:test",
  class: "ci",
  repo: "owner/name",
  suspectRef: { base: "aaa", head: "bbb" },
  signals: [],
  ciFailures: [{ kind: "run-step", name: "test", conclusion: "failure", command: "pnpm test" }],
  demoChapters: [],
  suspectFiles: ["src/handler.ts"],
  repro: { kind: "command", command: "pnpm test" },
};

const config = {
  "self-heal.proxy-url": "https://dispatcher.example/v1/agent/ex/inference",
  "self-heal.agent-token": "cap-token-aaaaaaaaaaaaaa",
};

/** A sandbox program where the agent patched and the repro is green. */
const program = (opts: { verifyExit: number; outcome: string }) => ({
  writeFileSync: { exitCode: 0, stdout: "staged" },
  "flare-agent": { exitCode: 0, stdout: "" },
  "agent-result.json": { exitCode: 0, stdout: JSON.stringify({ outcome: opts.outcome, changedFiles: ["src/handler.ts"] }) },
  "pnpm test": { exitCode: opts.verifyExit, stdout: "" },
  "git status --porcelain": { exitCode: 0, stdout: "src/handler.ts" },
});

describe("self-heal-pr", () => {
  it.effect("verified fix stages a writeback (⇒ draft PR)", () => {
    const { layer } = makeCFRuntimeTest({ config, sandboxProgram: program({ verifyExit: 0, outcome: "patched" }) });
    return Effect.gen(function* () {
      const out = yield* selfHealPr.run({ incident: baseIncident, signals: [] });
      expect(out.outcome).toBe("patched");
      expect(out.verified).toBe(true);
      expect(out.prStaged).toBe(true);
      expect([...out.changedPaths]).toEqual(["src/handler.ts"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("unverified fix is silent — no writeback", () => {
    const { layer } = makeCFRuntimeTest({ config, sandboxProgram: program({ verifyExit: 1, outcome: "patched" }) });
    return Effect.gen(function* () {
      const out = yield* selfHealPr.run({ incident: baseIncident, signals: [] });
      expect(out.verified).toBe(false);
      expect(out.prStaged).toBe(false);
      expect([...out.changedPaths]).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("agent no-fix → no PR", () => {
    const { layer } = makeCFRuntimeTest({ config, sandboxProgram: program({ verifyExit: 0, outcome: "no-fix" }) });
    return Effect.gen(function* () {
      const out = yield* selfHealPr.run({ incident: baseIncident, signals: [] });
      expect(out.outcome).toBe("no-fix");
      expect(out.prStaged).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("demo class with a test-command repro is eligible (verify runs the test)", () => {
    // The demo failure verifies via the regression-test command — NOT a browser
    // re-run — so it flows through the same verify→writeback gate as the CI class.
    const incident: IncidentT = {
      ...baseIncident,
      class: "demo",
      incidentId: "demo:owner_name:Sign in",
      demoChapters: [{ name: "Sign in", narrative: "dashboard never rendered" }],
      ciFailures: [],
      repro: { kind: "command", command: "pnpm test", note: "write a regression test" },
    };
    const { layer } = makeCFRuntimeTest({ config, sandboxProgram: program({ verifyExit: 0, outcome: "patched" }) });
    return Effect.gen(function* () {
      const out = yield* selfHealPr.run({ incident, signals: [] });
      expect(out.outcome).toBe("patched");
      expect(out.verified).toBe(true);
      expect(out.prStaged).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("demo class WITHOUT a command repro is skipped (left to triage)", () => {
    const incident: IncidentT = {
      ...baseIncident,
      class: "demo",
      demoChapters: [{ name: "Sign in" }],
      ciFailures: [],
      repro: { kind: "derived", note: "write a regression test" },
    };
    const { layer } = makeCFRuntimeTest({ config, sandboxProgram: program({ verifyExit: 0, outcome: "patched" }) });
    return Effect.gen(function* () {
      const out = yield* selfHealPr.run({ incident, signals: [] });
      expect(out.outcome).toBe("skipped");
      expect(out.prStaged).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("non-command repro (application class) is skipped in V0", () => {
    const incident: IncidentT = {
      ...baseIncident,
      class: "application",
      repro: { kind: "derived", note: "write a failing test first" },
    };
    const { layer } = makeCFRuntimeTest({ config, sandboxProgram: program({ verifyExit: 0, outcome: "patched" }) });
    return Effect.gen(function* () {
      const out = yield* selfHealPr.run({ incident, signals: [] });
      expect(out.outcome).toBe("skipped");
      expect(out.prStaged).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when the proxy/token isn't injected", () => {
    const { layer } = makeCFRuntimeTest({ config: {}, sandboxProgram: program({ verifyExit: 0, outcome: "patched" }) });
    return Effect.gen(function* () {
      const r = yield* Effect.either(selfHealPr.run({ incident: baseIncident, signals: [] }));
      expect(r._tag).toBe("Left");
    }).pipe(Effect.provide(layer));
  });
});
