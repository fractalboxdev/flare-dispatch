// Run-level unit tests for `spec-drift-pr` — drive the run against the in-memory
// test runtime (`makeCFRuntimeTest`) with seeded config + sandbox + model fakes.
// No CF, no Docker, no model provider.

import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import type { ModelCompletionResult } from "@fractalboxdev/flare-dispatch-core";
import { specDriftPr } from "./spec-drift-pr";

const firedAt = Date.UTC(2026, 5, 3); // 2026-06-03
const input = { firedAt } as const;

/** A tools-mode model result returning the `propose_spec_edits` payload. */
const proposal = (edits: unknown[]): ModelCompletionResult => ({
  toolCalls: [
    {
      name: "propose_spec_edits",
      arguments: { summary: "drift found", edits },
    },
  ],
  text: "",
});

const backendConfig = {
  "spec-drift.repos": "owner/name",
  "spec-drift.workers-ai.model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
};

// Sandbox program: specs present, a file tree, a git log.
const sandboxProgram = {
  "specs/*.md": { exitCode: 0, stdout: "\n===FILE specs/01.md===\nold spec text" },
  "head -800": { exitCode: 0, stdout: "specs/01.md\nsrc/a.ts" },
  "git log --oneline": { exitCode: 0, stdout: "abc feat: thing" },
};

describe("spec-drift-pr", () => {
  it.effect("opens a draft PR with the proposed spec edits", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: backendConfig,
      sandboxProgram,
      modelGateway: {
        responses: [
          proposal([{ path: "specs/01.md", newContent: "new spec text", rationale: "stale" }]),
        ],
      },
    });

    return Effect.gen(function* () {
      const out = yield* specDriftPr.run(input);
      expect(out.reposScanned).toBe(1);
      expect(out.prsOpened).toBe(1);

      const calls = handles.github.openDraftPullRequestCalls;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.repo).toBe("owner/name");
      expect(calls[0]!.headBranch).toBe("flare-dispatch/spec-drift-2026-06-03");
      expect(calls[0]!.files).toEqual([{ path: "specs/01.md", content: "new spec text" }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("opens NO PR when the specs are already in sync", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: backendConfig,
      sandboxProgram,
      modelGateway: { responses: [proposal([])] },
    });

    return Effect.gen(function* () {
      const out = yield* specDriftPr.run(input);
      expect(out.prsOpened).toBe(0);
      expect(out.reposClean).toBe(1);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("is a no-op when spec-drift.repos is unset", () => {
    const { layer, handles } = makeCFRuntimeTest({ config: {} });
    return Effect.gen(function* () {
      const out = yield* specDriftPr.run(input);
      expect(out.reposScanned).toBe(0);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when the backend model is unconfigured", () => {
    // repos set, but no `spec-drift.workers-ai.model` → BackendUnconfigured.
    const { layer } = makeCFRuntimeTest({
      config: { "spec-drift.repos": "owner/name" },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(specDriftPr.run(input));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
