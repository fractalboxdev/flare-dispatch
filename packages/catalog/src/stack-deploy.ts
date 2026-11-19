// The `stack-deploy` run (FD-GATE-133 to FD-GATE-141): re-read the branch head, wait for the stack's approval where its
// entry requires one, run the apply in the stack's CodeBuild project, wait for the ECS rollout and probe the health
// URLs. Every wait is a durable sleep in the `control` pool. This module imports no process or file API.
import { Intents } from "@fractalboxdev/mameko-run";
import { Effect } from "effect";
import { AwsBuilds, Pause, StackApprovals, type AwsTarget, type ServiceRollout } from "./aws.ts";
import {
  POLL_INTERVAL_MS,
  awsFailure,
  buildSummaryText,
  runBuild,
  withRetries,
} from "./aws-build.ts";
import { SmokeHttp } from "./deploy-smoke.ts";
import { ExecutionLease } from "./execution-lease.ts";
import { GithubRead } from "./github-read.ts";
import { awsConfigProblem, buildEnv } from "./image-publish.ts";
import type { StackDeployInput } from "./inputs.ts";
import { Outcome, isSuccess } from "./reasons.ts";

/** `approvalTimeoutSec` bounds and default (FD-GATE-137). */
export const APPROVAL_TIMEOUT_SEC = { min: 60, max: 43_200, default: 14_400 } as const;
/** `rollout.timeoutSec` bounds and default (FD-GATE-139). */
export const ROLLOUT_TIMEOUT_SEC = { min: 60, max: 3600, default: 1800 } as const;
/** The health probe: 3 attempts 10 s apart, each within 10 s (FD-GATE-141, as FD-GATE-071 and FD-GATE-072). */
export const HEALTH_ATTEMPTS = 3;
export const HEALTH_INTERVAL_MS = 10_000;
export const HEALTH_REQUEST_TIMEOUT_MS = 10_000;

/** The approval route an operator posts the decision to (FD-IFC-104). */
export const STACK_APPROVAL_ROUTE = "/v1/ops/stack-approvals";

export const stackCheckName = (stack: string): string => `flare-dispatch/stack-deploy:${stack}`;

const inRange = (value: number | undefined, range: { min: number; max: number }) =>
  value === undefined || (Number.isInteger(value) && value >= range.min && value <= range.max);

/** The first out-of-range field of a stack's entry as its `config: <field>` reason, or `undefined`. */
export const stackConfigProblem = (input: StackDeployInput): Outcome | undefined => {
  const entry = input.entry;
  const aws = awsConfigProblem(entry);
  if (aws !== undefined) return aws;
  if (!inRange(entry.approvalTimeoutSec, APPROVAL_TIMEOUT_SEC))
    return Outcome.failure("config: approvalTimeoutSec");
  if (entry.rollout !== undefined) {
    if (entry.rollout.cluster.trim() === "") return Outcome.failure("config: rollout.cluster");
    if (entry.rollout.services.length === 0) return Outcome.failure("config: rollout.services");
    if (!inRange(entry.rollout.timeoutSec, ROLLOUT_TIMEOUT_SEC))
      return Outcome.failure("config: rollout.timeoutSec");
  }
  for (const url of entry.health?.urls ?? []) {
    try {
      if (new URL(url).protocol !== "https:") return Outcome.failure("config: health.urls");
    } catch {
      return Outcome.failure("config: health.urls");
    }
  }
  return undefined;
};

/** Whether every service has rolled out, or the first one that cannot (FD-GATE-139, FD-GATE-140). */
export const rolloutState = (
  services: readonly ServiceRollout[],
  names: readonly string[],
):
  | { readonly _tag: "Done" }
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Failed"; readonly outcome: Outcome } => {
  for (const name of names) {
    const found = services.find((s) => s.name === name);
    if (found === undefined || found._tag === "Missing")
      return { _tag: "Failed", outcome: Outcome.failure(`rollout: ${name} missing`) };
    if (found.rolloutState === "FAILED")
      return { _tag: "Failed", outcome: Outcome.failure(`rollout: ${name} failed`) };
  }
  const done = names.every((name) => {
    const s = services.find((x) => x.name === name);
    return (
      s?._tag === "Found" && s.rolloutState === "COMPLETED" && s.runningCount === s.desiredCount
    );
  });
  return done ? { _tag: "Done" } : { _tag: "Waiting" };
};

/** The decision, read every `POLL_INTERVAL_MS` until it is recorded or the window ends (FD-GATE-136, FD-GATE-137). */
const awaitApproval = (input: StackDeployInput, timeoutSec: number) =>
  Effect.gen(function* () {
    const approvals = yield* StackApprovals;
    const pause = yield* Pause;
    yield* approvals.request(input.stack, input.sha);
    const intents = yield* Intents;
    const lease = yield* ExecutionLease;
    yield* intents.emit("approval", {
      kind: "check.summary",
      payload: {
        name: stackCheckName(input.stack),
        head_sha: input.sha,
        title: `Waiting for approval to apply ${input.stack}`,
        markdown: [
          `Stack \`${input.stack}\` applies only after an operator approves execution \`${lease.executionId}\`.`,
          "",
          `\`POST ${STACK_APPROVAL_ROUTE}\` with \`{ "execution_id": "${lease.executionId}", "decision": "approve" | "reject", "reason": "..." }\`.`,
          "",
          `The request expires after ${timeoutSec} s.`,
        ].join("\n"),
      },
    });
    const polls = Math.ceil((timeoutSec * 1000) / POLL_INTERVAL_MS);
    for (let poll = 0; poll <= polls; poll++) {
      const decision = yield* approvals.decision();
      if (decision === "approve") return undefined;
      if (decision === "reject") return Outcome.failure("approval: rejected");
      if (poll < polls) yield* pause.sleep(`approval:poll-${poll}`, POLL_INTERVAL_MS);
    }
    return Outcome.failure("approval: timeout");
  });

/** The ECS rollout, read every `POLL_INTERVAL_MS` within `rollout.timeoutSec` (FD-GATE-139, FD-GATE-140). */
const awaitRollout = (
  target: AwsTarget,
  rollout: NonNullable<StackDeployInput["entry"]["rollout"]>,
) =>
  Effect.gen(function* () {
    const builds = yield* AwsBuilds;
    const pause = yield* Pause;
    const timeoutMs = (rollout.timeoutSec ?? ROLLOUT_TIMEOUT_SEC.default) * 1000;
    const polls = Math.ceil(timeoutMs / POLL_INTERVAL_MS);
    let pending: readonly string[] = rollout.services;
    for (let poll = 0; poll <= polls; poll++) {
      const services = yield* withRetries(
        `rollout:get-${poll}`,
        builds.services(target, rollout.cluster, rollout.services),
      );
      const state = rolloutState(services, rollout.services);
      if (state._tag === "Done") return undefined;
      if (state._tag === "Failed") return state.outcome;
      pending = rollout.services.filter((name) => {
        const s = services.find((x) => x.name === name);
        return !(
          s?._tag === "Found" &&
          s.rolloutState === "COMPLETED" &&
          s.runningCount === s.desiredCount
        );
      });
      if (poll < polls) yield* pause.sleep(`rollout:poll-${poll}`, POLL_INTERVAL_MS);
    }
    return Outcome.failure(`rollout: ${pending[0] ?? rollout.services[0]} timeout`);
  });

/** One health request, healthy only on a 2xx or 3xx within the timeout; no redirect is followed (FD-GATE-141). */
const probe = (url: string) =>
  Effect.gen(function* () {
    const http = yield* SmokeHttp;
    return yield* Effect.tryPromise({
      try: () =>
        http.fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
        }),
      catch: (cause) =>
        cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")
          ? "timeout"
          : "error",
    }).pipe(
      Effect.map((r) => (r.status >= 200 && r.status < 400 ? undefined : String(r.status))),
      Effect.catch((detail) => Effect.succeed<string | undefined>(detail)),
    );
  });

const probeHealth = (urls: readonly string[]) =>
  Effect.gen(function* () {
    const pause = yield* Pause;
    const unhealthy: string[] = [];
    for (const [i, url] of urls.entries()) {
      let detail: string | undefined = "not probed";
      for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
        if (attempt > 0) yield* pause.sleep(`health:${i}:retry-${attempt}`, HEALTH_INTERVAL_MS);
        detail = yield* probe(url);
        if (detail === undefined) break;
      }
      if (detail !== undefined) unhealthy.push(`${url} ${detail}`);
    }
    return unhealthy.length === 0 ? undefined : Outcome.failure(`health: ${unhealthy.join("; ")}`);
  });

export const runStackDeploy = (input: StackDeployInput) =>
  Effect.gen(function* () {
    const bad = stackConfigProblem(input);
    if (bad !== undefined) return bad;
    const entry = input.entry;
    const github = yield* GithubRead;
    // The head is read before the approval and again before the apply, so an approval granted while the branch moved
    // never applies a superseded commit (FD-GATE-135).
    const headMoved = Effect.map(
      github.branchHead(input.scope, input.branch),
      (head) => head !== input.sha && entry.requireHead !== false,
    );
    if (yield* headMoved) return Outcome.cancelled("superseded: branch head moved");
    if (entry.approval === "required") {
      const refused = yield* awaitApproval(
        input,
        entry.approvalTimeoutSec ?? APPROVAL_TIMEOUT_SEC.default,
      );
      if (refused !== undefined) return refused;
      if (yield* headMoved) return Outcome.cancelled("superseded: branch head moved");
    }
    const lease = yield* ExecutionLease;
    const key = `stack:${input.stack}`;
    const target: AwsTarget = {
      region: entry.region,
      roleArn: entry.roleArn,
      target: key,
    };
    const end = yield* runBuild({
      key,
      target,
      project: entry.project,
      sha: input.sha,
      env: {
        ...buildEnv(input, lease.executionId),
        FD_STACK: input.stack,
        FD_IMAGES: JSON.stringify(input.images),
      },
      executionId: lease.executionId,
      deadlineAt: lease.deadlineAt,
    });
    const intents = yield* Intents;
    yield* intents.emit("summary", {
      kind: "check.summary",
      payload: {
        name: stackCheckName(input.stack),
        head_sha: input.sha,
        title: isSuccess(end.outcome)
          ? `Applied ${input.stack}`
          : `Apply of ${input.stack} did not succeed`,
        markdown: buildSummaryText(end.state),
      },
    });
    if (!isSuccess(end.outcome)) return end.outcome;
    if (entry.rollout !== undefined) {
      const rolled = yield* awaitRollout(target, entry.rollout);
      if (rolled !== undefined) return rolled;
    }
    const unhealthy = yield* probeHealth(entry.health?.urls ?? []);
    if (unhealthy !== undefined) return unhealthy;
    return Outcome.success();
  }).pipe(
    Effect.catchTags({
      AwsAssumeRoleFailed: (e) => Effect.succeed(awsFailure(e)),
      AwsCallFailed: (e) => Effect.succeed(awsFailure(e)),
      LedgerUnavailable: () => Effect.succeed(Outcome.failure("infra: LedgerUnavailable")),
      GithubReadFailed: () => Effect.succeed(Outcome.failure("infra: GithubReadFailed")),
      GithubUncredentialed: () => Effect.succeed(Outcome.failure("infra: GithubUncredentialed")),
      DuplicateIntentKey: () => Effect.succeed(Outcome.failure("infra: DuplicateIntentKey")),
      IntentLimitExceeded: () => Effect.succeed(Outcome.failure("infra: IntentLimitExceeded")),
    }),
  );
