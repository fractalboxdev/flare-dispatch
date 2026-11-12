// Test doubles of the gate recipes' services: each records what a recipe asked for and answers from a script.
import { intentList } from "@fractalboxdev/mameko-run";
import { Effect, Layer, Ref } from "effect";
import {
  CommandExit,
  GateExec,
  WorkspaceReadFailed,
  WorkspaceWriteFailed,
  type CommandOptions,
} from "./command.ts";
import { GithubRead, GithubReadFailed } from "./github-read.ts";
import {
  ArtifactUploadFailed,
  GateArtifacts,
  MatrixChildren,
  type ChildHandle,
  type ChildRequest,
  type ChildVerdict,
  type DiscoveryResult,
} from "./ports.ts";
import { DeployLedger } from "./worker-deploy.ts";

export const SHA = "a".repeat(40);
export const OTHER_SHA = "b".repeat(40);

export const ctx = {
  repo: "https://github.com/o/r.git",
  sha: SHA,
  ref: "refs/heads/main",
} as const;

const encoder = new TextEncoder();

/** A scripted answer to a command: matched by a substring of the command. */
export interface Scripted {
  readonly match: string;
  readonly exit?: CommandExit;
  readonly output?: string;
}

/** `GateExec` that answers each command from a script, exit 0 by default, and records every command it ran. */
export const fakeExec = (
  script: readonly Scripted[] = [],
  files: Readonly<Record<string, string>> = {},
) => {
  const ran: CommandOptions[] = [];
  let workspaces = 0;
  const layer = Layer.succeed(GateExec, {
    workspace: Effect.sync(() => `/ws/${++workspaces}`),
    run: (options) =>
      Effect.sync(() => {
        ran.push(options);
        const hit = script.find((s) => options.command.includes(s.match));
        return {
          exit: hit?.exit ?? CommandExit.Exited({ code: 0 }),
          output: encoder.encode(hit?.output ?? ""),
        };
      }),
    readFile: (path) => {
      const key = Object.keys(files).find((f) => path.endsWith(f));
      return key === undefined
        ? Effect.fail(new WorkspaceReadFailed({ path, detail: "absent" }))
        : Effect.succeed(encoder.encode(files[key]!));
    },
    writeFile: (path) => Effect.fail(new WorkspaceWriteFailed({ path, detail: "read-only" })),
  });
  return { layer, ran, workspaces: () => workspaces };
};

export const fakeArtifacts = (options: { readonly fail?: boolean } = {}) => {
  const uploads = new Map<string, string>();
  const layer = Layer.succeed(GateArtifacts, {
    upload: (name, bytes) =>
      options.fail === true
        ? Effect.fail(new ArtifactUploadFailed({ name, detail: "store down" }))
        : Effect.sync(() => void uploads.set(name, new TextDecoder().decode(bytes))),
  });
  return { layer, uploads };
};

/** mameko's `Intents` over the runner's intent list; `emitted` reads each intent as `{ kind, key, payload }`. */
export const fakeIntents = () => {
  const list = intentList();
  return {
    layer: list.layer,
    get emitted() {
      return list.intents().map((i) => ({ kind: i.kind, key: i.intent_key, payload: i.payload }));
    },
  };
};

export const fakeGithub = (answers: {
  readonly head?: string;
  readonly tag?: string;
  readonly reachable?: boolean;
  readonly fail?: boolean;
}) => {
  const reads: string[] = [];
  const failed = (what: string) => new GithubReadFailed({ what, detail: "down" });
  const layer = Layer.succeed(GithubRead, {
    branchHead: (_repo, branch) =>
      answers.fail === true
        ? Effect.fail(failed(branch))
        : Effect.sync(() => (reads.push(`head ${branch}`), answers.head ?? SHA)),
    tagCommit: (_repo, tag) => Effect.sync(() => (reads.push(`tag ${tag}`), answers.tag ?? SHA)),
    reachableFrom: (_repo, sha, branch) =>
      Effect.sync(() => (reads.push(`reachable ${sha} ${branch}`), answers.reachable ?? true)),
  });
  return { layer, reads };
};

export const memoryLedger = () => {
  const claimed = new Set<string>();
  return Layer.succeed(DeployLedger, {
    claim: (key) =>
      Effect.sync(() => {
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      }),
  });
};

/** A job's scripted end: an outcome after some milliseconds, or no verdict. */
export type ChildScript = (
  request: ChildRequest,
  attempt: number,
) => {
  readonly verdict: ChildVerdict;
  readonly afterMs?: number;
};

/**
 * `MatrixChildren` that answers each job from a script. It records every start, cancel and the most jobs running at
 * once, which is what the window bounds.
 */
export const fakeChildren = (
  script: ChildScript,
  discovery: (request: ChildRequest) => DiscoveryResult = () => ({
    _tag: "Exited",
    code: 0,
    output: "[]",
  }),
) =>
  Effect.gen(function* () {
    const started: ChildRequest[] = [];
    const cancelled: string[] = [];
    const discovered: ChildRequest[] = [];
    const running = yield* Ref.make(0);
    let peak = 0;
    const attempts = new Map<string, number>();
    const layer = Layer.succeed(MatrixChildren, {
      start: (request) =>
        Effect.gen(function* () {
          started.push(request);
          const n = yield* Ref.updateAndGet(running, (r) => r + 1);
          peak = Math.max(peak, n);
          return { key: request.key, executionId: `${request.dedupKey}` } satisfies ChildHandle;
        }),
      await: (handle) =>
        Effect.gen(function* () {
          const request = [...started].reverse().find((r) => r.dedupKey === handle.executionId)!;
          const attempt = attempts.get(request.key) ?? 0;
          attempts.set(request.key, attempt + 1);
          const answer = script(request, attempt);
          yield* Effect.sleep(answer.afterMs ?? 1);
          yield* Ref.update(running, (r) => r - 1);
          return answer.verdict;
        }),
      cancel: (handle) => Effect.sync(() => void cancelled.push(handle.key)),
      discover: (request) =>
        Effect.sync(() => {
          discovered.push(request);
          return discovery(request);
        }),
    });
    return { layer, started, cancelled, discovered, peak: () => peak };
  });
