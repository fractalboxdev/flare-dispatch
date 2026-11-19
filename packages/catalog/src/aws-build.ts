// One CodeBuild build of `image-publish` or `stack-deploy` (FD-GATE-120 to FD-GATE-127): start it once per execution
// and target, poll it with durable sleeps, stop it at the deadline or on cancel, and map its end to a verdict. This
// module imports no process or file API.
import { Clock, Effect } from "effect";
import {
  AwsBuilds,
  BuildLedger,
  Pause,
  type AwsError,
  type AwsTarget,
  type BuildState,
} from "./aws.ts";
import { Outcome } from "./reasons.ts";

/** The interval between two status reads (FD-GATE-122, FD-GATE-136, FD-GATE-139). */
export const POLL_INTERVAL_MS = 30_000;
/** How long before `deadline_at` a running build is stopped (FD-GATE-124). */
export const STOP_BEFORE_DEADLINE_MS = 60_000;
/** Consecutive transient failures of one call before the recipe gives up (FD-GATE-125). */
export const TRANSIENT_ATTEMPTS = 3;
/** The wait between two attempts of a call that failed transiently. */
export const RETRY_INTERVAL_MS = 5_000;

/** A failed AWS call as the verdict names it (FD-GATE-119, FD-GATE-125). */
export const awsFailure = (e: AwsError): Outcome =>
  e._tag === "AwsAssumeRoleFailed"
    ? Outcome.failure(`aws: assume-role ${e.code}`)
    : e.transient
      ? Outcome.failure(`infra: aws ${e.service} ${e.operation}`)
      : Outcome.failure(`aws: ${e.service} ${e.operation} ${e.code}`);

/**
 * `call` retried while it fails transiently, up to `TRANSIENT_ATTEMPTS` attempts with a durable wait between them
 * (FD-GATE-125). `name` keeps each wait's durable name unique within the execution.
 */
export const withRetries = <A, R>(
  name: string,
  call: Effect.Effect<A, AwsError, R>,
): Effect.Effect<A, AwsError, R | Pause> =>
  Effect.gen(function* () {
    const pause = yield* Pause;
    for (let attempt = 1; ; attempt++) {
      const result = yield* Effect.result(call);
      if (result._tag === "Success") return result.success;
      const error = result.failure;
      if (error._tag !== "AwsCallFailed" || !error.transient || attempt >= TRANSIENT_ATTEMPTS)
        return yield* Effect.fail(error);
      yield* pause.sleep(`${name}:retry-${attempt}`, RETRY_INTERVAL_MS);
    }
  });

/** A build's end as the verdict names it (FD-GATE-123); `undefined` while it runs or once it succeeded. */
export const buildOutcome = (state: BuildState, stopRequested: boolean): Outcome | undefined => {
  switch (state.status) {
    case "IN_PROGRESS":
    case "SUCCEEDED":
      return undefined;
    case "FAILED": {
      const failed = state.phases.find(
        (p) => p.status !== undefined && p.status !== "SUCCEEDED" && p.status !== "IN_PROGRESS",
      );
      return Outcome.failure(`build: ${failed?.type ?? "BUILD"} failed`);
    }
    case "TIMED_OUT":
      return Outcome.failure("timeout: build");
    case "FAULT":
      return Outcome.failure("infra: build fault");
    case "STOPPED":
      return stopRequested ? Outcome.failure("deadline") : Outcome.failure("build: stopped");
  }
};

export interface BuildRequest {
  /** The ledger key: `image-publish[:<label>]` or `stack:<stack>`. */
  readonly key: string;
  readonly target: AwsTarget;
  readonly project: string;
  readonly sha: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executionId: string;
  /** The execution's `deadline_at`, epoch milliseconds. */
  readonly deadlineAt: number | undefined;
}

/** How a build ended: its last state and the verdict, `success` where it succeeded. */
export interface BuildEnd {
  readonly state: BuildState | undefined;
  readonly outcome: Outcome;
}

/**
 * The build of `request`, started once per execution and key (FD-GATE-121) and read every `POLL_INTERVAL_MS` until it
 * ends (FD-GATE-122). A build still running `STOP_BEFORE_DEADLINE_MS` before the deadline is stopped and records
 * `deadline`; an interrupt, the execution's cancel, stops it too (FD-GATE-124).
 */
export const runBuild = (request: BuildRequest) =>
  Effect.gen(function* () {
    const builds = yield* AwsBuilds;
    const ledger = yield* BuildLedger;
    const pause = yield* Pause;
    const recorded = yield* ledger.recorded(request.key);
    const buildId =
      recorded ??
      (yield* withRetries(
        `${request.key}:start`,
        builds.start(request.target, {
          project: request.project,
          sourceVersion: request.sha,
          env: request.env,
          idempotencyToken: `${request.executionId}:${request.key}`,
        }),
      ).pipe(Effect.tap((id) => ledger.record(request.key, id))));
    const stop = withRetries(`${request.key}:stop`, builds.stop(request.target, buildId));
    return yield* Effect.gen(function* () {
      let stopRequested = false;
      for (let poll = 0; ; poll++) {
        const state = yield* withRetries(
          `${request.key}:get-${poll}`,
          builds.get(request.target, buildId),
        );
        if (state.status === "SUCCEEDED") return { state, outcome: Outcome.success() } as BuildEnd;
        const ended = buildOutcome(state, stopRequested);
        if (ended !== undefined) return { state, outcome: ended } as BuildEnd;
        const now = yield* Clock.currentTimeMillis;
        if (
          !stopRequested &&
          request.deadlineAt !== undefined &&
          now >= request.deadlineAt - STOP_BEFORE_DEADLINE_MS
        ) {
          yield* stop;
          stopRequested = true;
          return { state, outcome: Outcome.failure("deadline") } as BuildEnd;
        }
        yield* pause.sleep(`${request.key}:poll-${poll}`, POLL_INTERVAL_MS);
      }
    }).pipe(Effect.onInterrupt(() => stop.pipe(Effect.ignore)));
  });

/** The phases, status and log location of a build, as its check summary lists them (FD-GATE-126). */
export const buildSummaryText = (state: BuildState | undefined): string => {
  if (state === undefined) return "No build ran.";
  const lines = [`Build \`${state.id}\`: **${state.status}**`, "", "| Phase | Status | Seconds |"];
  lines.push("| --- | --- | --- |");
  for (const p of state.phases)
    lines.push(`| ${p.type} | ${p.status ?? ""} | ${p.durationSec ?? ""} |`);
  if (state.logs !== undefined)
    lines.push(
      "",
      `CloudWatch log group \`${state.logs.group}\`, stream \`${state.logs.stream}\`.`,
    );
  return lines.join("\n");
};
