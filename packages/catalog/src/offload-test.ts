// The `offload-test` run: the manifest entry as a job matrix (FD-GATE-025 to FD-GATE-028), discovered or declared,
// optionally a release matrix (FD-GATE-054 to FD-GATE-060).
import { Effect } from "effect";
import { GATE_JOB_MAX_DURATION_SEC, type OffloadTestInput } from "./inputs.ts";
import { MatrixJobSchema, pullRequestSkip, timeoutProblem, type MatrixJob } from "./manifest.ts";
import {
  discoverJobs,
  entryJobs,
  expandMatrix,
  runMatrix,
  runRelease,
  windowOf,
} from "./matrix.ts";
import { Outcome } from "./reasons.ts";

/** The parent's body. It needs no `GateExec`: the parent makes no sandbox call (FD-GATE-045). */
export const runOffloadTest = (input: OffloadTestInput, run = "offload-test") =>
  Effect.gen(function* () {
    const skip = pullRequestSkip(input);
    if (skip !== undefined) return skip;
    const entry = input.entry;
    const window = windowOf(entry);
    if (window === undefined) return Outcome.failure("config: window");
    const ctx = {
      repo: input.repo,
      sha: input.sha,
      ref: input.ref,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
    };
    let jobs: readonly MatrixJob[] | undefined;
    if (entry.discover !== undefined && entry.discover.trim() !== "") {
      const found = yield* discoverJobs({
        parentDedupKey: input.parentDedupKey,
        ctx,
        baseSha: input.baseSha ?? input.sha,
        command: entry.discover,
      });
      if ("failure" in found) return found.failure;
      jobs = found.jobs;
    } else jobs = entryJobs(entry);
    if (jobs === undefined) return Outcome.failure("config: no command");
    for (const job of jobs) {
      const bad = timeoutProblem(job.timeoutSec, GATE_JOB_MAX_DURATION_SEC);
      if (bad !== undefined) return bad;
    }
    const expanded = expandMatrix(jobs, input.trigger, { release: entry.release === true });
    if ("failure" in expanded) return expanded.failure;
    const plan = {
      run,
      parentDedupKey: input.parentDedupKey,
      ctx,
      jobs: expanded.jobs,
      window,
      failFast: entry.failFast === true,
      checkPerJob: entry.checkPerJob === true,
      ...(entry.install === undefined || entry.install.trim() === ""
        ? {}
        : { install: entry.install }),
      ...(input.trigger === "push-default" ? { heavyClass: "interactive" } : {}),
    };
    if (entry.release === true)
      return yield* runRelease(plan, {
        scope: input.scope ?? "",
        defaultBranch: input.defaultBranch ?? "main",
      });
    return (yield* runMatrix(plan)).outcome;
  });

/**
 * The request a default-branch push makes for a manifest's `warm` job (FD-GATE-053): class `batch`, the protected
 * namespace of the executor kind, no check, superseded by the next default-branch head.
 */
export const warmRequest = (
  warm: typeof MatrixJobSchema.Type,
  push: { readonly repo: string; readonly sha: string; readonly executorKind: "cloud" | "device" },
) => ({
  run: "gate-job",
  className: "batch",
  cacheTier: push.executorKind === "cloud" ? "protected-cloud" : "protected-device",
  postsCheck: false,
  supersede: true,
  supersessionKey: `warm:${push.repo}`,
  input: { key: warm.key, command: warm.command, sha: push.sha },
});
