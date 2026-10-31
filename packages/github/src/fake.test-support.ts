// An in-memory GitHub for the applier tests: check runs and annotations per
// repository, a scripted failure queue, and a record of every call.
import { AlarmPort, type Alarm, type IntentRow } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { InstallationDirectory } from "./applier.ts";
import {
  GithubClient,
  type Annotation,
  type CheckRun,
  type CheckRunBody,
  type GithubError,
} from "./client.ts";

export interface FakeGithub {
  readonly runs: CheckRun[];
  readonly annotations: Map<number, Annotation[]>;
  readonly calls: string[];
  /** Failures the next calls take, in order; a `null` entry lets that call through. */
  readonly failures: (GithubError | null)[];
  /** Errors answered after the next write takes effect: GitHub did the work and the answer failed. */
  readonly lostAnswers: GithubError[];
  readonly alarms: Alarm[];
  tokenRefreshes: number;
}

export const fakeGithub = (): FakeGithub => ({
  runs: [],
  annotations: new Map(),
  calls: [],
  failures: [],
  lostAnswers: [],
  alarms: [],
  tokenRefreshes: 0,
});

const merge = (run: CheckRun, body: CheckRunBody): CheckRun => ({
  ...run,
  ...(body.status === undefined ? {} : { status: body.status }),
  ...(body.conclusion === undefined ? {} : { conclusion: body.conclusion }),
  ...(body.output === undefined
    ? {}
    : { output: { title: body.output.title, summary: body.output.summary } }),
});

export const fakeLayers = (
  gh: FakeGithub,
  installations: Record<string, number> = { "acme/app": 7 },
) => {
  const step = <A>(name: string, f: () => A): Effect.Effect<A, GithubError> =>
    Effect.suspend(() => {
      gh.calls.push(name);
      const failure = gh.failures.shift();
      if (failure !== undefined && failure !== null) return Effect.fail(failure);
      const value = f();
      const lost = name === "create" || name === "update" ? gh.lostAnswers.shift() : undefined;
      return lost === undefined ? Effect.succeed(value) : Effect.fail(lost);
    });
  const client = Layer.succeed(GithubClient, {
    createCheckRun: ({ body }) =>
      step("create", () => {
        const run: CheckRun = merge(
          {
            id: 1000 + gh.runs.length,
            name: body.name ?? "",
            external_id: body.external_id ?? null,
            status: "queued",
            conclusion: null,
            output: { title: null, summary: null },
          },
          body,
        );
        gh.runs.push(run);
        return run;
      }),
    updateCheckRun: ({ checkRunId, body }) =>
      step("update", () => {
        const i = gh.runs.findIndex((r) => r.id === checkRunId);
        const next = merge(gh.runs[i]!, body);
        gh.runs[i] = next;
        if (body.output?.annotations !== undefined)
          gh.annotations.set(checkRunId, [
            ...(gh.annotations.get(checkRunId) ?? []),
            ...body.output.annotations,
          ]);
        return next;
      }),
    listCheckRuns: ({ name }) => step("list", () => gh.runs.filter((r) => r.name === name)),
    listAnnotations: ({ checkRunId }) =>
      step("annotations", () => gh.annotations.get(checkRunId) ?? []),
    refreshToken: () =>
      step("refresh", () => {
        gh.tokenRefreshes++;
      }),
  });
  const directory = Layer.succeed(InstallationDirectory, {
    installationFor: (scopeId) => Effect.succeed(installations[scopeId] ?? null),
  });
  const alarms = Layer.succeed(AlarmPort, {
    deliver: (alarm) => Effect.sync(() => void gh.alarms.push(alarm)),
  });
  return Layer.mergeAll(client, directory, alarms);
};

export const row = (
  kind: string,
  payload: unknown,
  overrides: Partial<IntentRow> = {},
): IntentRow => ({
  executionId: "exec-1",
  scopeId: "acme/app",
  intentKey: `cp:${kind.replaceAll(".", ":")}`,
  kind,
  payload,
  payloadDigest: "digest",
  effectClass: "adoptable",
  attempts: 0,
  ...overrides,
});
