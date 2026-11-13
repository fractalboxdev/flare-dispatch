// The `worker-deploy` V-SIM scenario (specs/verification.md § V-SIM, specs/runs/gate.md § `worker-deploy`). A seed
// fixes the manifest's `requireHead`, how many epochs the control plane reclaims before one ends, where in its body
// each reclaimed epoch is lost (the checkout or the deploy command), whether a push moves the branch head before each
// epoch, and the deploy command's exit. Each epoch runs the recipe's body afresh with its own workflow execution id
// `<execution id>:<epoch>`, against one branch whose head the scenario moves; every push, head read and command goes
// into one log. `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts).
import { isDeepStrictEqual } from "node:util";
import { Cause, Effect, Exit, Layer } from "effect";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import {
  CommandExit,
  GateExec,
  WorkspaceReadFailed,
  WorkspaceWriteFailed,
} from "../../src/command.ts";
import { fakeArtifacts, fakeIntents, memoryLedger } from "../../src/gate.test-support.ts";
import { GithubRead } from "../../src/github-read.ts";
import type { WorkerDeployInput } from "../../src/inputs.ts";
import { Outcome } from "../../src/reasons.ts";
import { runWorkerDeploy } from "../../src/worker-deploy.ts";

export const SCENARIO = "worker-deploy";

const EXECUTION = "01JDEPLOY";
const SHA = "a".repeat(40);
const DEPLOY = "pnpm wrangler deploy";
const SUPERSEDED = Outcome.cancelled("superseded: branch head moved");
const shaOf = (n: number) => n.toString(16).padStart(40, "c");

/** Where a reclaimed epoch is lost: during its checkout or during its deploy command. */
export type LostAt = "checkout" | "deploy";

/** What the seed fixes for one run of the scenario. */
export interface Plan {
  readonly requireHead: boolean | undefined;
  /** For each epoch the control plane reclaims, where it is lost; the epoch after the last one ends. */
  readonly reclaims: readonly LostAt[];
  /** Before each epoch, whether a push moves the branch head to a new commit. */
  readonly pushes: readonly boolean[];
  readonly deployExit: number;
}

export const plan = (seed: number): Plan => {
  const random = seededRandom(seed);
  const roll = random();
  const requireHead = roll < 0.5 ? undefined : roll < 0.7;
  const r = random();
  const count = r < 0.15 ? 0 : r < 0.85 ? 1 : 2;
  const reclaims = Array.from({ length: count }, (): LostAt =>
    random() < 0.4 ? "checkout" : "deploy",
  );
  const pushes = Array.from({ length: count + 1 }, (_, i) => random() < (i === 0 ? 0.15 : 0.4));
  return { requireHead, reclaims, pushes, deployExit: random() < 0.8 ? 0 : 1 };
};

/** One entry of the run's log, by the epoch that made it. */
export interface LogEntry {
  readonly epoch: number;
  readonly kind: "push" | "head-read" | "checkout" | "deploy" | "lost";
  /** The head a push moved the branch to, or a read answered. */
  readonly head?: string;
  /** The deploy command's environment. */
  readonly env?: Readonly<Record<string, string>>;
}

/** What one run shows: the log, how each epoch ended, and the intents the run emitted. */
export interface Observation {
  readonly log: readonly LogEntry[];
  /** Each epoch's outcome, or `lost` for a reclaimed one. */
  readonly epochs: readonly (Outcome | "lost")[];
  readonly intents: readonly string[];
}

const workflow = Workflow.make("worker-deploy", { payload: {}, idempotencyKey: () => EXECUTION });

/** Runs the scenario for one seed: one epoch after another until an epoch ends with an outcome. */
export const runScenario = async (seed: number): Promise<Observation> => {
  const p = plan(seed);
  const log: LogEntry[] = [];
  const epochs: (Outcome | "lost")[] = [];
  let head = SHA;
  let pushed = 0;
  // One deploy ledger and one outbox across epochs, as the execution's own; each epoch claims under its own key.
  const ledger = memoryLedger();
  const intents = fakeIntents();
  const input: WorkerDeployInput = {
    repo: "https://github.com/o/r.git",
    sha: SHA,
    ref: "refs/heads/main",
    scope: "o/r",
    branch: "main",
    entry: {
      command: DEPLOY,
      grants: ["cf-api"],
      ...(p.requireHead === undefined ? {} : { requireHead: p.requireHead }),
    },
  };
  for (let epoch = 1; epoch <= p.reclaims.length + 1; epoch++) {
    if (p.pushes[epoch - 1] === true) {
      head = shaOf(++pushed);
      log.push({ epoch, kind: "push", head });
    }
    const lostAt = p.reclaims[epoch - 1];
    /** The control plane reclaims the epoch's lease: the fiber running its body is interrupted where it stands. */
    const lose = Effect.sync(() => log.push({ epoch, kind: "lost" })).pipe(
      Effect.andThen(Effect.interrupt),
    );
    const github = Layer.succeed(GithubRead, {
      branchHead: () =>
        Effect.sync(() => {
          log.push({ epoch, kind: "head-read", head });
          return head;
        }),
      tagCommit: () => Effect.die("worker-deploy reads no tag"),
      reachableFrom: () => Effect.die("worker-deploy reads no reachability"),
    });
    let workspaces = 0;
    const exec = Layer.succeed(GateExec, {
      workspace: Effect.sync(() => `/ws/${epoch}/${++workspaces}`),
      run: (options) =>
        Effect.gen(function* () {
          const deploy = options.command === DEPLOY;
          log.push(
            deploy
              ? { epoch, kind: "deploy", env: options.env ?? {} }
              : { epoch, kind: "checkout" },
          );
          if (lostAt === (deploy ? "deploy" : "checkout")) return yield* lose;
          return {
            exit: CommandExit.Exited({ code: deploy ? p.deployExit : 0 }),
            output: new Uint8Array(),
          };
        }),
      runArgv: () => Effect.die("worker-deploy runs no argv command"),
      readFile: (path) => Effect.fail(new WorkspaceReadFailed({ path, detail: "absent" })),
      writeFile: (path) => Effect.fail(new WorkspaceWriteFailed({ path, detail: "read-only" })),
    });
    const instance = Layer.succeed(
      WorkflowEngine.WorkflowInstance,
      WorkflowEngine.WorkflowInstance.initial(workflow, `${EXECUTION}:${epoch}`),
    );
    const exit = await Effect.runPromiseExit(
      runWorkerDeploy(input).pipe(
        Effect.provide(
          Layer.mergeAll(exec, github, ledger, intents.layer, fakeArtifacts().layer, instance),
        ),
      ),
    );
    if (Exit.isSuccess(exit)) {
      epochs.push(exit.value);
      break;
    }
    if (!Cause.hasInterrupts(exit.cause))
      throw new Error(`epoch ${epoch} failed: ${Cause.pretty(exit.cause)}`);
    epochs.push("lost");
  }
  return { log, epochs, intents: intents.emitted.map((i) => i.kind) };
};

/** The paths a seed took, for a run over many seeds to show it reached each. */
export interface SeedOutcome {
  /** An epoch after a reclaimed one read the head again and found it moved. */
  readonly supersededAfterReclaim: boolean;
  /** An epoch after one lost during its deploy command deployed again with the head it read. */
  readonly redeployedAfterReclaim: boolean;
  /** `requireHead: false` let a deploy run with a moved head. */
  readonly deployedMovedHead: boolean;
}

/** One seed's violations, each naming the requirement it breaks, and the paths it took. */
export interface SeedResult {
  readonly violations: readonly SimViolation[];
  readonly reached: SeedOutcome;
}

/**
 * Runs one seed and checks FD-GATE-064 and FD-GATE-065 on it:
 * - every epoch reads the branch head before any command, and an epoch's deploy command gets the head that epoch
 *   read, not one an earlier epoch read;
 * - an epoch that reads a head other than the execution's commit, without `requireHead: false`, records `cancelled`
 *   with `superseded: branch head moved`, runs no command and the run emits no intent; with `requireHead: false`, or
 *   with the head at the commit, the epoch goes on to its checkout.
 */
export const observeSeed = async (seed: number): Promise<SeedResult> => {
  const p = plan(seed);
  const o = await runScenario(seed);
  const violations: SimViolation[] = [];
  const v = (id: string, message: string) => violations.push({ id, message });
  let supersededAfterReclaim = false;
  let redeployedAfterReclaim = false;
  let deployedMovedHead = false;

  o.epochs.forEach((ended, i) => {
    const epoch = i + 1;
    const own = o.log.filter((e) => e.epoch === epoch && e.kind !== "push");
    const deploys = own.filter((e) => e.kind === "deploy");
    // FD-GATE-064: the epoch's first act is a head read, and its deploy command carries what that read answered.
    if (own[0]?.kind !== "head-read")
      v("FD-GATE-064", `epoch ${epoch} began with ${own[0]?.kind ?? "nothing"}, not a head read`);
    const read = own.find((e) => e.kind === "head-read")?.head;
    for (const d of deploys)
      if (d.env?.["FD_BRANCH_HEAD_SHA"] !== read)
        v(
          "FD-GATE-064",
          `epoch ${epoch} deployed with FD_BRANCH_HEAD_SHA ${d.env?.["FD_BRANCH_HEAD_SHA"]}, but read ${read}`,
        );
    if (read === undefined) return;

    // FD-GATE-065: a moved head supersedes the epoch unless the manifest sets requireHead: false.
    const moved = read !== SHA;
    const commands = own.filter((e) => e.kind === "checkout" || e.kind === "deploy");
    if (moved && p.requireHead !== false) {
      if (!isDeepStrictEqual(ended, SUPERSEDED))
        v(
          "FD-GATE-065",
          `epoch ${epoch} read moved head ${read} and ended ${JSON.stringify(ended)}`,
        );
      if (commands.length > 0)
        v(
          "FD-GATE-065",
          `epoch ${epoch} read moved head ${read} and ran ${commands.map((c) => c.kind).join(", ")}`,
        );
      if (o.intents.length > 0)
        v(
          "FD-GATE-065",
          `epoch ${epoch} was superseded and the run emitted ${o.intents.join(", ")}`,
        );
      if (epoch > 1) supersededAfterReclaim = true;
    } else {
      if (commands.length === 0)
        v(
          "FD-GATE-065",
          `epoch ${epoch} read ${moved ? "a moved head with requireHead: false" : "the commit"} and ran no command`,
        );
      if (isDeepStrictEqual(ended, SUPERSEDED))
        v("FD-GATE-065", `epoch ${epoch} read ${read} and was superseded`);
      if (moved && deploys.length > 0) deployedMovedHead = true;
      if (epoch > 1 && p.reclaims[epoch - 2] === "deploy" && deploys.length > 0)
        redeployedAfterReclaim = true;
    }
  });

  return {
    violations,
    reached: { supersededAfterReclaim, redeployedAfterReclaim, deployedMovedHead },
  };
};

/** Runs one seed and throws on any violation, as the `sim` job requires of each scenario. */
export const checkSeed = async (seed: number): Promise<SeedOutcome> => {
  const { violations, reached } = await observeSeed(seed);
  throwOnViolations(violations);
  return reached;
};

export const scenarios: readonly SimScenario[] = [
  {
    name: SCENARIO,
    ids: ["FD-GATE-064", "FD-GATE-065"],
    run: async (seed) => {
      await checkSeed(seed);
    },
  },
];
