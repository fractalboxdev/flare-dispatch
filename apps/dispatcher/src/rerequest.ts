// FlareDispatch Dispatcher — re-run a check from GitHub's "Re-run" button.
//
// GitHub sends `check_run.rerequested` when someone clicks "Re-run" on a
// check-run this App posted, and `check_suite.rerequested` for "Re-run all
// checks" on its suite. Both re-dispatch work this deploy already ran, so a
// check that went red because the platform killed its container is retried
// with one click instead of a new commit.
//
// --- A re-run is a new execution ---------------------------------------------
//
// The retried execution's id cannot be reused: Cloudflare Workflows refuses
// `create({ id })` for every id it has seen, terminated or not. So attempt N
// gets its own deterministic id, `<root>:attempt-<N>` through `toInstanceId`,
// and carries `attempt` + `retryOf` (the root's id) into the Workflow, which
// records them on the `executions` row (infra/migrations/0007) and shows the
// attempt in the check-run title. The check-run NAME is unchanged, so the new
// check-run supersedes the red one under the same branch-protection rule.
//
// Everything the retry needs comes from the prior execution's own row — run,
// repo, ref, sha, and the decoded inputs in `input_json` — plus the
// installation id on the webhook. Metadata that row does not hold (the Slack
// origin, completion-notify recipients) is not replayed: a re-run reports on
// the check-run only.
//
// --- Guards ------------------------------------------------------------------
//
//   * foreign_app       — the check-run / suite belongs to another GitHub App.
//   * unknown_check_run — no execution on this deploy posted that check-run.
//   * in_progress       — an attempt of the same family is still live, per the
//                         Workflow instance's own status (a D1 `running` row
//                         whose instance errored does not block). This is the
//                         click-storm guard: N clicks while attempt 2 runs
//                         dispatch nothing more.
//   * attempts_exhausted — the family reached MAX_ATTEMPTS.
//   * run_not_registered / inputs_unreplayable — the run left the registry, or
//                         its recorded inputs no longer decode against it.
//
// A re-run deliberately bypasses the run's cooldown: cooldown caps what a push
// storm can dispatch, and a re-run is one explicit request on a finished
// check, bounded by `in_progress` and `MAX_ATTEMPTS` instead.

import { Either, Option, Schema } from "effect";
import type { Env } from "./env";
import {
  type ExecutionRow,
  getAttemptFamily,
  getExecutionByCheckRun,
  listExecutionsAtSha,
} from "./executions-read";
import { toInstanceId } from "./instance-id";
import { instantiateRun } from "./instantiate";
import { lookupRun } from "./registry";

/** Attempts per execution family, the first dispatch included. */
export const MAX_ATTEMPTS = 5;

/** Workflow instance states that mean an attempt is still live. */
const ACTIVE_STATES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
]);

/** D1 execution statuses that are final without asking the platform. */
const TERMINAL_ROW_STATES: ReadonlySet<string> = new Set([
  "success",
  "failure",
  "skipped",
  "cancelled",
]);

const App = Schema.Struct({ id: Schema.Number });
const Repository = Schema.Struct({ full_name: Schema.String });
const Installation = Schema.Struct({ id: Schema.Number });

const CheckRunRerequested = Schema.Struct({
  action: Schema.Literal("rerequested"),
  check_run: Schema.Struct({
    id: Schema.Number,
    head_sha: Schema.String,
    app: Schema.optional(App),
  }),
  repository: Repository,
  installation: Schema.optional(Installation),
});

const CheckSuiteRerequested = Schema.Struct({
  action: Schema.Literal("rerequested"),
  check_suite: Schema.Struct({
    head_sha: Schema.String,
    app: Schema.optional(App),
  }),
  repository: Repository,
  installation: Schema.optional(Installation),
});

/** A decoded re-run request — one check-run, or every check of a commit. */
export type Rerequest =
  | {
      readonly kind: "check_run";
      readonly repo: string;
      readonly checkRunId: number;
      readonly appId?: number;
      readonly installationId?: number;
    }
  | {
      readonly kind: "check_suite";
      readonly repo: string;
      readonly headSha: string;
      readonly appId?: number;
      readonly installationId?: number;
    };

/**
 * Decode a webhook into a re-run request, or `undefined` when it is not one
 * (any other event or action, or a `rerequested` body missing the fields a
 * re-run needs).
 */
export const decodeRerequest = (event: string, payload: unknown): Rerequest | undefined => {
  if (event === "check_run") {
    return Option.getOrUndefined(
      Option.map(Schema.decodeUnknownOption(CheckRunRerequested)(payload), (p) => ({
        kind: "check_run" as const,
        repo: p.repository.full_name,
        checkRunId: p.check_run.id,
        ...(p.check_run.app !== undefined ? { appId: p.check_run.app.id } : {}),
        ...(p.installation !== undefined ? { installationId: p.installation.id } : {}),
      })),
    );
  }
  if (event === "check_suite") {
    return Option.getOrUndefined(
      Option.map(Schema.decodeUnknownOption(CheckSuiteRerequested)(payload), (p) => ({
        kind: "check_suite" as const,
        repo: p.repository.full_name,
        headSha: p.check_suite.head_sha,
        ...(p.check_suite.app !== undefined ? { appId: p.check_suite.app.id } : {}),
        ...(p.installation !== undefined ? { installationId: p.installation.id } : {}),
      })),
    );
  }
  return undefined;
};

/** Why a re-run dispatched nothing. */
export type RerunRefusal =
  | "foreign_app"
  | "unknown_check_run"
  | "in_progress"
  | "attempts_exhausted"
  | "run_not_registered"
  | "inputs_unreplayable";

/** What one re-run request did for one execution family. */
export type RerunOutcome =
  | {
      readonly kind: "dispatched";
      readonly run: string;
      readonly executionId: string;
      readonly attempt: number;
      readonly retryOf: string;
    }
  | {
      readonly kind: "refused";
      readonly reason: RerunRefusal;
      /** The execution the refusal is about, when there is one. */
      readonly executionId?: string;
    }
  | {
      /** `check_suite` only: the family's latest attempt already succeeded. */
      readonly kind: "succeeded";
      readonly executionId: string;
    };

/** The Workflow instance id of attempt `attempt` of the family rooted at `rootId`. */
export const retryExecutionId = (rootId: string, attempt: number): string =>
  toInstanceId(`${rootId}:attempt-${attempt}`);

/** The id of attempt 1 of the family `row` belongs to. */
const rootOf = (row: ExecutionRow): string => row.retry_of ?? row.id;

/** A family's latest attempt — the highest `attempt` number. */
const latestOf = (family: readonly ExecutionRow[]): ExecutionRow =>
  family.reduce((a, b) => ((b.attempt ?? 1) > (a.attempt ?? 1) ? b : a));

/**
 * The Workflow instance's status, or `undefined` when the platform knows no
 * instance by that id (never created, or past retention). The binding's `get`
 * is async on the platform and rejects for an unknown id.
 */
const instanceStatus = async (env: Env, id: string): Promise<string | undefined> => {
  try {
    const instance = await env.RUNS_WORKFLOW.get(id);
    return (await instance.status()).status;
  } catch {
    return undefined;
  }
};

const isActive = (status: string | undefined): boolean =>
  status !== undefined && ACTIVE_STATES.has(status);

/**
 * Re-dispatch the next attempt of one execution family. `family` holds every
 * recorded attempt (attempt 1 first-class among them).
 */
const rerunFamily = async (
  env: Env,
  family: readonly ExecutionRow[],
  installationId: number | undefined,
  origin: string,
): Promise<RerunOutcome> => {
  const latest = latestOf(family);
  const rootId = rootOf(latest);

  // A row whose D1 status is not final may still be live — ask the platform,
  // which is authoritative: a container kill that took the Workflow down
  // leaves the row `running` forever, and that must not block the retry.
  for (const row of family) {
    if (TERMINAL_ROW_STATES.has(row.status)) continue;
    if (isActive(await instanceStatus(env, row.id))) {
      return { kind: "refused", reason: "in_progress", executionId: row.id };
    }
  }

  const run = lookupRun(latest.run);
  if (run === undefined) {
    return { kind: "refused", reason: "run_not_registered", executionId: latest.id };
  }
  const inputs: unknown = (() => {
    try {
      return JSON.parse(latest.input_json);
    } catch {
      return undefined;
    }
  })();
  if (Either.isLeft(Schema.decodeUnknownEither(run.inputs)(inputs))) {
    return { kind: "refused", reason: "inputs_unreplayable", executionId: latest.id };
  }

  // The next free attempt number. An instance that exists with no D1 row is
  // an attempt the platform accepted but that never recorded itself: live →
  // someone else's click already dispatched it; finished → it died before
  // `startExecution`, so step past it rather than collapse onto a dead id.
  for (let attempt = (latest.attempt ?? 1) + 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const executionId = retryExecutionId(rootId, attempt);
    const status = await instanceStatus(env, executionId);
    if (isActive(status)) {
      return { kind: "refused", reason: "in_progress", executionId };
    }
    if (status !== undefined) continue;

    await instantiateRun(env, {
      executionId,
      run: latest.run,
      github: {
        repo: latest.repo,
        ref: latest.ref,
        sha: latest.sha,
        ...(installationId !== undefined ? { installation_id: installationId } : {}),
      },
      inputs,
      origin,
      attempt,
      retryOf: rootId,
    });
    return { kind: "dispatched", run: latest.run, executionId, attempt, retryOf: rootId };
  }
  return { kind: "refused", reason: "attempts_exhausted", executionId: latest.id };
};

/** True when the request names an App other than this deploy's. */
const isForeignApp = (env: Env, appId: number | undefined): boolean =>
  appId !== undefined && env.GITHUB_APP_ID !== undefined && String(appId) !== env.GITHUB_APP_ID;

/**
 * Handle a decoded re-run request: one outcome for a `check_run` re-run, one
 * per check-posting execution family at the commit for a `check_suite` re-run.
 */
export const handleRerequest = async (
  env: Env,
  request: Rerequest,
  origin: string,
): Promise<readonly RerunOutcome[]> => {
  if (isForeignApp(env, request.appId)) {
    return [{ kind: "refused", reason: "foreign_app" }];
  }

  if (request.kind === "check_run") {
    const prior = await getExecutionByCheckRun(env.RUNS_METADATA, request.repo, request.checkRunId);
    if (prior === null) return [{ kind: "refused", reason: "unknown_check_run" }];
    const family = await getAttemptFamily(env.RUNS_METADATA, rootOf(prior));
    return [
      await rerunFamily(env, family.length > 0 ? family : [prior], request.installationId, origin),
    ];
  }

  // `check_suite`: every top-level execution that posted a check at this
  // commit, grouped into families. A family whose latest attempt succeeded is
  // left alone — "re-run all" is for the checks that did not pass, and
  // re-running a green review or deploy would repeat its side effects. A
  // numeric `check_run_id` is what "posted a check" means: an uncredentialed
  // execution records the no-op sentinel (`"noop"`) there, and a spawned child
  // reports through its parent.
  const rows = (await listExecutionsAtSha(env.RUNS_METADATA, request.repo, request.headSha)).filter(
    (row) => typeof row.check_run_id === "number" && row.parent_execution_id == null,
  );
  const families = new Map<string, ExecutionRow[]>();
  for (const row of rows) {
    const root = rootOf(row);
    families.set(root, [...(families.get(root) ?? []), row]);
  }
  const outcomes: RerunOutcome[] = [];
  for (const family of families.values()) {
    const latest = latestOf(family);
    outcomes.push(
      latest.status === "success"
        ? { kind: "succeeded", executionId: latest.id }
        : await rerunFamily(env, family, request.installationId, origin),
    );
  }
  return outcomes;
};
