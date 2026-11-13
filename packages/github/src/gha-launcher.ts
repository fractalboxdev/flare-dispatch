// FlareDispatch's launcher port for the kind `gha` (specs/executors.md § The GitHub Actions launcher): `start` sends one
// `workflow_dispatch` of the runner workflow, `cancel` cancels that workflow run, and `verify` admits the runner job's
// Actions OIDC token for the one (execution, epoch) its launch named, once.
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Launcher, type LeaseRef } from "@fractalboxdev/mameko-ports";
import { Clock, Effect, Layer, Match, Option, Schema } from "effect";
import { restRequest, type GithubClientOptions } from "./client.ts";
import {
  ACTIONS_ISSUER,
  ACTIONS_JWKS,
  JwksSource,
  verifyWithJwks,
  type Claims,
  type JwtResult,
} from "./jwks.ts";
import { InstallationQuota } from "./rate-limit.ts";

export const GHA_KIND = "gha";
const MINUTE_MS = 60_000;
const CLOCK_SKEW_S = 60;

/** The runner repository and workflow the operator overlay names (`gha.runnerRepo`, `gha.workflow`). */
export interface GhaLauncherConfig {
  /** The GitHub App installation on the runner repository. */
  readonly installation: number;
  /** `<owner>/<repo>`. */
  readonly runnerRepo: string;
  /** The runner workflow's file name under `.github/workflows/`. */
  readonly workflow: string;
  /** The branch the launcher dispatches the runner workflow on. */
  readonly branch: string;
  /** The control plane's audience, which the runner job's OIDC token must carry (FD-EXEC-088). */
  readonly audience: string;
}

/** The `workflow_dispatch` inputs of one launch: the execution id, the epoch and the minutes until `deadline_at`. */
export interface DispatchInputs {
  readonly execution_id: string;
  readonly epoch: string;
  readonly deadline_minutes: string;
}

/**
 * The inputs of a launch (FD-EXEC-086): nothing but the execution id, the epoch and the whole minutes left until
 * `deadline_at`. A lease with less than one minute left answers `undefined`: no job could run in it.
 */
export const dispatchInputs = (lease: LeaseRef, nowMs: number): DispatchInputs | undefined => {
  const minutes = Math.floor((lease.deadlineAt - nowMs) / MINUTE_MS);
  return minutes < 1
    ? undefined
    : {
        execution_id: lease.executionId,
        epoch: String(lease.epoch),
        deadline_minutes: String(minutes),
      };
};

/** What a runner job presents to claim its lease: the launch it names and its Actions OIDC token. */
export const GhaClaim = Schema.Struct({
  executionId: Schema.NonEmptyString,
  epoch: Schema.Number.check(Schema.isInt()),
  token: Schema.NonEmptyString,
});
export type GhaClaim = typeof GhaClaim.Type;

/**
 * Whether verified token claims come from the runner workflow the overlay names (FD-EXEC-089): the repository, and the
 * workflow ref of that repository's runner workflow on the dispatch branch. Repository names compare without case, as
 * GitHub resolves them.
 */
export const fromRunnerWorkflow = (claims: Claims, config: GhaLauncherConfig): boolean => {
  const repository = claims["repository"];
  const workflowRef = claims["workflow_ref"];
  if (typeof repository !== "string" || typeof workflowRef !== "string") return false;
  const repo = config.runnerRepo.toLowerCase();
  return (
    repository.toLowerCase() === repo &&
    workflowRef.slice(0, repo.length).toLowerCase() === repo &&
    workflowRef.slice(repo.length) ===
      `/.github/workflows/${config.workflow}@refs/heads/${config.branch}`
  );
};

export class GhaLaunchesUnavailable extends Schema.TaggedError<GhaLaunchesUnavailable>()(
  "GhaLaunchesUnavailable",
  { message: Schema.String },
) {}

/** The workflow run each (execution, epoch) launched, and whether its runner job has claimed the lease. */
export interface GhaLaunches {
  readonly record: (
    executionId: string,
    epoch: number,
    runId: string,
  ) => Effect.Effect<void, GhaLaunchesUnavailable>;
  readonly runOf: (
    executionId: string,
    epoch: number,
  ) => Effect.Effect<string | undefined, GhaLaunchesUnavailable>;
  /**
   * Marks the launch of (execution, epoch) claimed when workflow run `runId` launched it and nothing claimed it yet;
   * answers whether this call did. Concurrent claims admit at most one.
   */
  readonly claim: (
    executionId: string,
    epoch: number,
    runId: string,
  ) => Effect.Effect<boolean, GhaLaunchesUnavailable>;
}

/** The launches in D1, so a claim accepted by one isolate is refused by every other (FD-EXEC-090). */
export const d1GhaLaunches = (db: D1Like, now: () => number = Date.now): GhaLaunches => {
  let ready: Promise<unknown> | undefined;
  const run = <A>(f: () => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        await (ready ??= db
          .prepare(`create table if not exists fd_gha_launches (
        execution_id text not null, epoch integer not null, run_id text not null, claimed_at integer,
        primary key (execution_id, epoch)
      )`)
          .run()
          .catch((e: unknown) => {
            ready = undefined;
            throw e;
          }));
        return f();
      },
      catch: (e) => new GhaLaunchesUnavailable({ message: String(e) }),
    });
  return {
    record: (executionId, epoch, runId) =>
      run(async () => {
        await db
          .prepare(`insert into fd_gha_launches (execution_id, epoch, run_id) values (?, ?, ?)
        on conflict (execution_id, epoch) do nothing`)
          .bind(executionId, epoch, runId)
          .run();
      }),
    runOf: (executionId, epoch) =>
      run(async () => {
        const { results } = await db
          .prepare("select run_id from fd_gha_launches where execution_id = ? and epoch = ?")
          .bind(executionId, epoch)
          .all();
        const row = results[0] as { readonly run_id?: unknown } | undefined;
        return typeof row?.run_id === "string" ? row.run_id : undefined;
      }),
    claim: (executionId, epoch, runId) =>
      run(async () => {
        const { results } = await db
          .prepare(`update fd_gha_launches set claimed_at = ?
        where execution_id = ? and epoch = ? and run_id = ? and claimed_at is null returning run_id`)
          .bind(now(), executionId, epoch, runId)
          .all();
        return results.length === 1;
      }),
  };
};

const validClaims = (result: JwtResult): Claims | undefined =>
  Match.value(result).pipe(
    Match.tag("Valid", ({ claims }) => claims),
    Match.orElse(() => undefined),
  );

export interface GhaLauncherOptions extends GithubClientOptions {
  readonly config: GhaLauncherConfig;
  readonly launches: GhaLaunches;
}

/**
 * The `gha` launcher port. The port's methods carry no error channel: a `start` or `cancel` GitHub refuses is logged
 * and leaves the lease to the coordinator's reclaim, and `verify` answers `false` for anything it cannot check.
 */
export const ghaLauncherLayer = (
  options: GhaLauncherOptions,
): Layer.Layer<Launcher, never, InstallationQuota | JwksSource> =>
  Layer.effect(
    Launcher,
    Effect.gen(function* () {
      const request = restRequest(options, yield* InstallationQuota);
      const jwks = yield* JwksSource;
      const { config, launches } = options;
      const repo = config.runnerRepo;
      const workflowPath = `/repos/${repo}/actions/workflows/${encodeURIComponent(config.workflow)}`;
      return Launcher.of({
        kind: GHA_KIND,
        start: (lease) =>
          Effect.gen(function* () {
            const inputs = dispatchInputs(lease, yield* Clock.currentTimeMillis);
            if (inputs === undefined)
              return yield* Effect.logWarning(
                "gha launch skipped: deadline_at is under a minute away",
                {
                  executionId: lease.executionId,
                  epoch: lease.epoch,
                },
              );
            const answer = yield* request<{ readonly workflow_run_id?: unknown }>(
              config.installation,
              "POST",
              `${workflowPath}/dispatches`,
              { ref: config.branch, inputs, return_run_details: true },
            );
            if (typeof answer.workflow_run_id !== "number")
              return yield* Effect.logWarning("gha launch answered no workflow run id", {
                executionId: lease.executionId,
                epoch: lease.epoch,
              });
            yield* launches.record(lease.executionId, lease.epoch, String(answer.workflow_run_id));
          }).pipe(
            Effect.catch((e) =>
              Effect.logWarning("gha launch failed", {
                executionId: lease.executionId,
                epoch: lease.epoch,
                error: e.message,
              }),
            ),
          ),
        cancel: (executionId, epoch) =>
          Effect.gen(function* () {
            const runId = yield* launches.runOf(executionId, epoch);
            if (runId === undefined)
              return yield* Effect.logWarning("gha cancel found no launch", { executionId, epoch });
            yield* request(
              config.installation,
              "POST",
              `/repos/${repo}/actions/runs/${runId}/cancel`,
            );
          }).pipe(
            Effect.catch((e) =>
              Effect.logWarning("gha cancel failed", { executionId, epoch, error: e.message }),
            ),
          ),
        verify: (claims) =>
          Effect.gen(function* () {
            const claim = Option.getOrUndefined(Schema.decodeUnknownOption(GhaClaim)(claims));
            if (claim === undefined) return false;
            const nowMs = yield* Clock.currentTimeMillis;
            const verified = validClaims(
              yield* verifyWithJwks(claim.token, ACTIONS_JWKS, {
                issuer: ACTIONS_ISSUER,
                audience: config.audience,
                nowSeconds: Math.floor(nowMs / 1000),
                clockSkewSeconds: CLOCK_SKEW_S,
              }),
            );
            if (verified === undefined || !fromRunnerWorkflow(verified, config)) return false;
            const runId = verified["run_id"];
            if (typeof runId !== "string") return false;
            return yield* launches.claim(claim.executionId, claim.epoch, runId);
          }).pipe(
            Effect.provideService(JwksSource, jwks),
            Effect.catch((e) =>
              Effect.logWarning("gha claim refused: a check could not run", {
                error: e.message,
              }).pipe(Effect.as(false)),
            ),
          ),
      });
    }),
  );
