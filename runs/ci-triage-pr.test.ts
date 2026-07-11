// Run-level unit tests for `ci-triage-pr` — drive the run against the in-memory
// test runtime with seeded config + github (actionRuns) + cloudflare
// (deployments) + model fakes.

import { it } from "@effect/vitest";
import { Effect, Either, Schema } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import type {
  DeploymentRef,
  ModelCompletionResult,
  WorkflowRunRef,
} from "@fractalboxdev/flare-dispatch-core";
import { ciTriagePr } from "./ci-triage-pr";

const firedAt = Date.UTC(2026, 5, 3); // 2026-06-03
// `run()` takes the DECODED input shape (the dispatcher's Schema decode applies
// the `signals: []` default before the run sees it).
const input = { firedAt, signals: [] } as const;

const exceptionSignal = {
  source: "workers-observability:my-api",
  title: "Unhandled exception in fetch handler",
  detail: "TypeError: Cannot read properties of undefined (reading 'id') — 12 occurrences over 24h",
  url: "https://dash.example.com/observability?service=my-api",
  count: 12,
} as const;

const failedRun: WorkflowRunRef = {
  repo: "owner/name",
  id: 1,
  name: "CI/CD",
  headBranch: "main",
  headSha: "deadbeef",
  status: "completed",
  conclusion: "failure",
  url: "https://github.com/owner/name/actions/runs/1",
  createdAt: firedAt - 3_600_000, // 1h before fire → within a 24h window
};

const failedDeploy: DeploymentRef = {
  project: "site",
  id: "dep1",
  environment: "production",
  status: "failure",
  url: "https://site.pages.dev",
  branch: "main",
  createdAt: firedAt - 3_600_000,
};

const triage = (): ModelCompletionResult => ({
  toolCalls: [
    {
      name: "report_triage",
      arguments: {
        summary: "2 failures today",
        items: [
          {
            title: "flaky CI",
            area: "github-actions",
            diagnosis: "timeout",
            suggestedFix: "bump timeout",
          },
        ],
      },
    },
  ],
  text: "",
});

const config = {
  "ci-triage.repos": "owner/name",
  "ci-triage.projects": "site",
  "ci-triage.workers-ai.model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
};

describe("ci-triage-pr", () => {
  it.effect("triages failures and opens a draft PR with the report file", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config,
      // The github / cloudflare fakes carry the clock `createdWithinHours`
      // filters against — seed it so the seeded failures stay in-window.
      github: { workflowRuns: [failedRun], now: firedAt },
      cloudflare: { deployments: [failedDeploy], now: firedAt },
      modelGateway: { responses: [triage()] },
    });

    return Effect.gen(function* () {
      const out = yield* ciTriagePr.run(input);
      expect(out.actionsFailures).toBe(1);
      expect(out.deployFailures).toBe(1);
      expect(out.prOpened).toBe(true);

      const calls = handles.github.openDraftPullRequestCalls;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.repo).toBe("owner/name");
      expect(calls[0]!.headBranch).toBe("flare-dispatch/ci-triage-2026-06-03");
      expect(calls[0]!.files[0]!.path).toBe(".flare-dispatch/ci-triage-2026-06-03.md");
      expect(calls[0]!.files[0]!.content).toContain("flaky CI");
    }).pipe(Effect.provide(layer));
  });

  it.effect("opens NO PR when there are no failures in the window", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config,
      // No seeded failures.
      modelGateway: { responses: [triage()] },
    });

    return Effect.gen(function* () {
      const out = yield* ciTriagePr.run(input);
      expect(out.actionsFailures).toBe(0);
      expect(out.deployFailures).toBe(0);
      expect(out.prOpened).toBe(false);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
      // Cheap, model not even consulted on a green day.
      expect(handles.modelGateway.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("is a no-op when neither repos nor projects are configured", () => {
    const { layer, handles } = makeCFRuntimeTest({ config: {} });
    return Effect.gen(function* () {
      const out = yield* ciTriagePr.run(input);
      expect(out.prOpened).toBe(false);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("triages caller-supplied signals alone and opens the PR", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config,
      // No seeded CI/deploy failures — the signal is the only evidence.
      github: { workflowRuns: [], now: firedAt },
      cloudflare: { deployments: [], now: firedAt },
      modelGateway: { responses: [triage()] },
    });

    return Effect.gen(function* () {
      const out = yield* ciTriagePr.run({ firedAt, signals: [exceptionSignal] });
      expect(out.actionsFailures).toBe(0);
      expect(out.deployFailures).toBe(0);
      expect(out.signalsCount).toBe(1);
      expect(out.prOpened).toBe(true);
      // The model WAS consulted — a signals-only day is not a green day.
      expect(handles.modelGateway.requests).toHaveLength(1);

      const calls = handles.github.openDraftPullRequestCalls;
      expect(calls).toHaveLength(1);
      const content = calls[0]!.files[0]!.content;
      expect(content).toContain("## Raw signals");
      expect(content).toContain(exceptionSignal.source);
      expect(content).toContain(exceptionSignal.title);
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders signals alongside failures in the report file", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config,
      github: { workflowRuns: [failedRun], now: firedAt },
      cloudflare: { deployments: [], now: firedAt },
      modelGateway: { responses: [triage()] },
    });

    return Effect.gen(function* () {
      const out = yield* ciTriagePr.run({ firedAt, signals: [exceptionSignal] });
      expect(out.actionsFailures).toBe(1);
      expect(out.signalsCount).toBe(1);

      const calls = handles.github.openDraftPullRequestCalls;
      expect(calls).toHaveLength(1);
      const content = calls[0]!.files[0]!.content;
      expect(content).toContain('"CI/CD"'); // the failed workflow
      expect(content).toContain(exceptionSignal.detail); // and the signal
      // The model saw both surfaces in one user body.
      const request = handles.modelGateway.requests[0]!;
      expect(JSON.stringify(request)).toContain("Observability signals to triage");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stays green when there are no failures AND no signals", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config,
      modelGateway: { responses: [triage()] },
    });
    return Effect.gen(function* () {
      const out = yield* ciTriagePr.run({ firedAt, signals: [] });
      expect(out.prOpened).toBe(false);
      expect(out.signalsCount).toBe(0);
      expect(handles.modelGateway.requests).toHaveLength(0);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});

describe("ci-triage-pr input schema (dispatch-gate decode)", () => {
  // `run()` is called with already-decoded input; the caps + default are
  // enforced where the dispatcher decodes `inputs` against the run schema
  // (routes/dispatch.ts). Exercise that decode directly.
  const decode = Schema.decodeUnknownEither(ciTriagePr.inputs);

  it("defaults absent signals to [] (schedule-mode shape)", () => {
    const decoded = Either.getOrThrow(decode({ firedAt }));
    expect(decoded.signals).toEqual([]);
  });

  it("rejects more than 50 signals", () => {
    const signals = Array.from({ length: 51 }, (_, i) => ({
      source: "s",
      title: `t${i}`,
      detail: "d",
    }));
    expect(Either.isLeft(decode({ firedAt, signals }))).toBe(true);
  });

  it("rejects an over-long detail", () => {
    const signals = [{ source: "s", title: "t", detail: "x".repeat(2_001) }];
    expect(Either.isLeft(decode({ firedAt, signals }))).toBe(true);
  });
});
