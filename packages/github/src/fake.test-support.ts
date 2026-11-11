// An in-memory GitHub for the applier tests: check runs and annotations per
// repository, a scripted failure queue, and a record of every call.
import { AlarmPort, type Alarm, type IntentRow } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { InstallationDirectory } from "./applier.ts";
import { ConcludeFacts, ConcludeFactsUnavailable, type ConclusionFacts } from "./conclude-facts.ts";
import {
  GithubClient,
  GithubHttpError,
  type Annotation,
  type CheckRun,
  type CheckRunBody,
  type GithubError,
} from "./client.ts";
import {
  GithubRead,
  GithubUncredentialed,
  type CheckRunSummary,
  type GithubReadError,
  type PullSummary,
} from "./read.ts";

export interface FakeGithub {
  readonly runs: CheckRun[];
  readonly annotations: Map<number, Annotation[]>;
  readonly calls: string[];
  /** Failures the next calls take, in order; a `null` entry lets that call through. */
  readonly failures: (GithubError | null)[];
  /** Errors answered after the next write takes effect: GitHub did the work and the answer failed. */
  readonly lostAnswers: GithubError[];
  readonly alarms: Alarm[];
  /** The control plane's records of each execution, by execution id. */
  readonly facts: Map<string, ConclusionFacts>;
  /** Whether reading those records fails. */
  factsDown: boolean;
  /** The details URL each create or update sent, by check-run id. */
  readonly detailsUrls: Map<number, string>;
  tokenRefreshes: number;
}

export const fakeGithub = (): FakeGithub => ({
  runs: [],
  annotations: new Map(),
  calls: [],
  failures: [],
  lostAnswers: [],
  alarms: [],
  facts: new Map(),
  factsDown: false,
  detailsUrls: new Map(),
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

/** The fake GitHub, its installation directory and its alarm sink, for an applier given its own `ConcludeFacts`. */
export const fakeGithubLayers = (
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
        if (body.details_url !== undefined) gh.detailsUrls.set(run.id, body.details_url);
        return run;
      }),
    updateCheckRun: ({ checkRunId, body }) =>
      step("update", () => {
        const i = gh.runs.findIndex((r) => r.id === checkRunId);
        const next = merge(gh.runs[i]!, body);
        gh.runs[i] = next;
        if (body.details_url !== undefined) gh.detailsUrls.set(checkRunId, body.details_url);
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

/** Every port the check-run applier reads, the control plane's records those the fake holds. */
export const fakeLayers = (
  gh: FakeGithub,
  installations: Record<string, number> = { "acme/app": 7 },
) => Layer.merge(fakeGithubLayers(gh, installations), fakeConcludeFacts(gh));

/** The control plane's records the fake holds in `gh.facts`. */
export const fakeConcludeFacts = (gh: Pick<FakeGithub, "facts" | "factsDown">) =>
  Layer.succeed(ConcludeFacts, {
    of: (executionId) =>
      gh.factsDown
        ? Effect.fail(new ConcludeFactsUnavailable({ message: "D1 unavailable" }))
        : Effect.succeed(gh.facts.get(executionId) ?? null),
  });

/** One repository as the fake reads see it. */
export interface FakeRepo {
  defaultBranch: string;
  /** Branch name to head SHA. */
  branches: Record<string, string>;
  /** `<ref>:<path>` to file text. */
  files: Record<string, string>;
  pulls: PullSummary[];
  /** Head SHA to the check runs on it. */
  checkRuns: Record<string, CheckRunSummary[]>;
  /** Branch name to its required check names. */
  required: Record<string, string[]>;
  /** The refs, `refs/heads/<branch>` or `refs/tags/<tag>`, a ruleset or branch protection protects. */
  protectedRefs: string[];
}

export const fakeRepo = (overrides: Partial<FakeRepo> = {}): FakeRepo => ({
  defaultBranch: "main",
  branches: { main: "a".repeat(40) },
  files: {},
  pulls: [],
  checkRuns: {},
  required: {},
  protectedRefs: [],
  ...overrides,
});

export interface FakeReads {
  readonly repos: Record<string, FakeRepo>;
  readonly installations: Record<string, number>;
  readonly calls: string[];
  /** A failure each named read takes, keyed `<read> <repo>`, until removed. */
  readonly failures: Map<string, GithubReadError>;
  /** How long, in milliseconds of the clock, each named read waits before it answers, keyed as `failures`. */
  readonly delays: Map<string, number>;
}

export const fakeReads = (
  repos: Record<string, FakeRepo> = {},
  installations: Record<string, number> = {},
): FakeReads => ({ repos, installations, calls: [], failures: new Map(), delays: new Map() });

/** `GithubRead` over the fake's tables; a repository without an installation fails `GithubUncredentialed`. */
export const fakeReadLayer = (state: FakeReads) => {
  const read = <A>(name: string, repo: string, f: (r: FakeRepo) => A) =>
    Effect.suspend((): Effect.Effect<A, GithubReadError> => {
      state.calls.push(`${name} ${repo}`);
      const answer = Effect.suspend((): Effect.Effect<A, GithubReadError> => {
        const failure = state.failures.get(`${name} ${repo}`);
        if (failure !== undefined) return Effect.fail(failure);
        const r = state.repos[repo];
        if (state.installations[repo] === undefined || r === undefined)
          return Effect.fail(new GithubUncredentialed({ repo }));
        return Effect.succeed(f(r));
      });
      const delay = state.delays.get(`${name} ${repo}`);
      return delay === undefined ? answer : Effect.andThen(Effect.sleep(delay), answer);
    });
  return Layer.succeed(GithubRead, {
    installation: (repo) => read("installation", repo, () => state.installations[repo]!),
    file: (repo, path, ref) =>
      read("file", repo, (r) => {
        const text = r.files[`${ref}:${path}`];
        return text === undefined ? null : { size: new TextEncoder().encode(text).length, text };
      }),
    defaultBranch: (repo) => read("defaultBranch", repo, (r) => r.defaultBranch),
    branchHead: (repo, branch) =>
      Effect.flatMap(
        read("branchHead", repo, (r) => r.branches[branch]),
        (sha) =>
          sha === undefined
            ? Effect.fail(
                new GithubHttpError({
                  status: 404,
                  message: "Branch not found",
                  rateLimited: false,
                }),
              )
            : Effect.succeed(sha),
      ),
    openPulls: (repo) => read("openPulls", repo, (r) => r.pulls),
    checkRuns: (repo, sha) => read("checkRuns", repo, (r) => r.checkRuns[sha] ?? []),
    requiredChecks: (repo, branch) => read("requiredChecks", repo, (r) => r.required[branch] ?? []),
    refProtected: (repo, ref) => read("refProtected", repo, (r) => r.protectedRefs.includes(ref)),
    repositories: (installation) =>
      Effect.sync(() => {
        state.calls.push(`repositories ${installation}`);
        return Object.keys(state.installations).filter(
          (r) => state.installations[r] === installation,
        );
      }),
  });
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

export * from "./fake-writes.test-support.ts";
