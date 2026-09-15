// FlareDispatch Dispatcher — GitlabReviewWorkflow (GitLab MR-review adapter).
//
// A deliberately SLIM Workflow — the `RunWorkflow` (workflow.ts) machinery
// (admission gates, container leases, check-runs, sandbox, writeback, notify)
// is all GitHub/container-shaped and NONE of it applies to a Worker-only GitLab
// review. Durable steps:
//
//   1. insert-execution — a minimal `executions` D1 row (status running).
//   2. post-placeholder — a short provisional note ("review started"), so the
//                         MR shows something is happening before the model
//                         fan-out finishes. Its note id is threaded through so
//                         `post-review` can UPDATE it in place.
//   3. review           — build the 3-Layer stack (modelGateway + config + the
//                         GitLab `scm`) and run `mrReviewCompute` (fetch + model
//                         fan-out + render — but NOT post). Yields the verdict +
//                         the rendered note body.
//   4. mark-reviewed-at — durably captures the instant the review step
//                         concluded, so a replay between here and `finalize`
//                         can never inflate the wall time the timing footer
//                         and `summary_json` report.
//   5. post-review      — update the placeholder note with the finished result
//                         (falling back to a fresh note when there was no
//                         placeholder id, the placeholder was deleted, or the
//                         update failed for any other reason) — its OWN step,
//                         so a mid-flight replay re-runs neither the model
//                         fan-out NOR the post/update twice. When the row is
//                         already `superseded` (a newer head cancelled this
//                         run), it posts nothing and reports `superseded: true`.
//   6. notify-failure   — on a `failure` / `skipped-quota` outcome, or a
//                         `success` whose MR note never posted, an optional
//                         Slack alert (SLACK_WEBHOOK_URL) — best-effort, never
//                         fails the Workflow. Always runs as a step (a no-op
//                         when there is nothing to notify), so it always
//                         counts toward `stepsRun`.
//   7. finalize         — update the row's terminal status + summary. A
//                         `superseded` run keeps the status the route wrote and
//                         only stamps `completed_at`.
//
// Each step is idempotent: a Workflow resume replays the memoized result rather
// than re-running the body. NO container / browser imports live here — a
// GitLab-mode deploy binds neither.

import { WorkflowEntrypoint, type WorkflowStepConfig } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Effect, Layer, Schedule } from "effect";
import { ScmError } from "@fractalboxdev/flare-dispatch-core";
import {
  ConfigDeferred,
  makeConfigKvLive,
  makeGitlabScmLive,
  makeModelGatewayLive,
  ModelGatewayDeferred,
} from "@fractalboxdev/flare-dispatch-runtime-cf";
import {
  mrPostNote,
  mrReviewCompute,
  mrUpdateNote,
  type MrReviewInput,
} from "@fractalboxdev/flare-dispatch-runs/mr-review";
import {
  placeholderNoteBody,
  reconcilePostedStatus,
  reviewOutcome,
  reviewStepFailedOutcome,
  skippedQuotaNoteBody,
  withTimingFooter,
  type ReviewOutcome,
} from "./gitlab-review-outcome";
import {
  REVIEW_STEP_ATTEMPTS,
  REVIEW_STEP_RETRY_LIMIT,
  REVIEW_STEP_TIMEOUT,
} from "./gitlab-review-step-config";
import { buildSlackFailureMessage, postSlackFailureNotification } from "./gitlab-slack-notify";
import { gitlabScmConfig } from "./gitlab-scm-config";
import type { Env } from "./env";

/** The Workflow params the GitLab webhook route creates each instance with. */
export type GitlabReviewParams = {
  /** Doubles as the instance id AND the `executions` row id. */
  readonly executionId: string;
  /** The `mr-review` run inputs. */
  readonly input: MrReviewInput;
};

/** Narrow the CF `step.do` overloads to the simple `(name, cb)` view we use. */
type StepDo = <T>(name: string, cb: () => Promise<T>) => Promise<T>;
type StepDoWith = <T>(name: string, config: WorkflowStepConfig, cb: () => Promise<T>) => Promise<T>;

/**
 * The review step fans out every persona, naive seat and verifier in one attempt. CF's
 * default (5 retries, 10-minute timeout) turned one slow full-tier review into a 37-minute
 * run and two silent errored instances on a live deployment. Wall-clock per step is
 * unlimited on Workers Paid; the timeout here only decides when a slow review is killed.
 * A full-tier review over a 30k-char diff needed more than ten minutes, so the step gets
 * 25 minutes and finishes (the duration lands in D1 for later measurement) instead of dying
 * unmeasured. One retry covers a transient platform error; a second timeout is never
 * worth a third attempt.
 */
// The retry limit and the timeout string both come from
// gitlab-review-step-config.ts — the ONE place that number and that text are
// defined, shared with gitlab-review-outcome.ts's "after N attempts" /
// "timed out after <timeout> each" wording (it cannot import this file,
// which pulls in `cloudflare:workers`).
const REVIEW_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: REVIEW_STEP_RETRY_LIMIT, delay: "30 seconds", backoff: "constant" },
  timeout: REVIEW_STEP_TIMEOUT,
};

export class GitlabReviewWorkflow extends WorkflowEntrypoint<Env, GitlabReviewParams> {
  override async run(
    event: WorkflowEvent<GitlabReviewParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { executionId, input } = event.payload;
    // CF types `step.do<T extends Rpc.Serializable<T>>`; our step results are
    // plain JSON records, so bridge through the simple `(name, cb)` view — the
    // same narrowing workflow.ts uses. NOTE: `step` is an RPC stub — `step.do`
    // must be invoked as a property call (receiver preserved); extracting it
    // via `.bind(step)` throws `The RPC receiver does not implement "bind"`.
    const stepDo: StepDo = (name, cb) =>
      (step.do as unknown as StepDo)(name, cb);
    const stepDoWith: StepDoWith = (name, config, cb) =>
      (step.do as unknown as StepDoWith)(name, config, cb);
    const db = this.env.RUNS_METADATA;

    // 1. Minimal executions row. GitLab has no GitHub-style repo slug — use the
    //    project web URL as `repo`, the source branch as `ref`, the head sha.
    //    `startedAt` is captured HERE (not read back from D1, and not a plain
    //    `Date.now()` at the top of `run()`) so it survives a Workflow replay:
    //    `step.do` memoizes this step's result the first time it completes, so
    //    a resumed run gets the SAME `startedAt` back rather than a fresh one —
    //    the timing footer's wall time must measure from the execution's true
    //    start, not from whenever `run()` happened to be re-entered.
    const { startedAt } = await stepDo("insert-execution", async () => {
      const startedAt = Date.now();
      await db
        .prepare(
          `INSERT OR IGNORE INTO executions (id, run, repo, ref, sha, status, started_at, input_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          executionId,
          "mr-review",
          input.projectWebUrl || `gitlab:${input.projectId}`,
          input.sourceBranch ?? "refs/merge-requests",
          input.headSha,
          "running",
          startedAt,
          JSON.stringify(input),
        )
        .run();
      return { inserted: true, startedAt };
    });

    // The GitLab `scm` Layer — built once, reused by the placeholder + review +
    // post steps. `gitlabScmConfig` treats a blank/whitespace token or base URL
    // as absent (never a valid credential/override) and passes GITLAB_BASE_URL
    // through for a self-hosted GitLab instance.
    const scmLayer = makeGitlabScmLive(gitlabScmConfig(this.env));

    // 2. Post a short "review started" placeholder note right away, so the MR
    //    shows something before the (possibly multi-minute) model fan-out
    //    finishes. Its noteId (null if posting failed, or there is no token)
    //    is threaded into `post-review`, which UPDATES this same note instead
    //    of posting a second one. NO retries here (limit 0): the placeholder is
    //    cosmetic — a retry after a LOST response (the note posted, the
    //    response never arrived) would post a duplicate placeholder that
    //    nothing ever updates, while a transient failure just means no
    //    placeholder — `post-review` creates a fresh note when noteId is null.
    //    The id is ALSO written to the row's `summary_json`
    //    (`$.placeholderNoteId`, no schema change) once it is known, so the
    //    webhook route can find the note and rewrite it when a newer head
    //    supersedes this run. `finalize` merges its summary in with `json_patch`,
    //    so the field survives the terminal update.
    const placeholder = await stepDoWith("post-placeholder", { retries: { limit: 0, delay: "1 second", backoff: "constant" } }, async () => {
      const body = placeholderNoteBody({ headSha: input.headSha, postedAtMs: Date.now() });
      const noteId = await Effect.runPromise(
        mrPostNote(input, body).pipe(
          Effect.map((r) => r.noteId),
          Effect.provide(scmLayer),
          Effect.catchAll((e) =>
            Effect.logWarning(`gitlab-review: placeholder note failed — ${String(e)}`).pipe(
              Effect.as<string | null>(null),
            ),
          ),
        ),
      );
      if (noteId !== null) {
        try {
          await db
            .prepare(
              "UPDATE executions SET summary_json = json_set(coalesce(summary_json, '{}'), '$.placeholderNoteId', ?) WHERE id = ?",
            )
            .bind(noteId, executionId)
            .run();
        } catch (e) {
          console.warn(`[gitlab-review] placeholder note id not persisted — ${String(e)}`);
        }
      }
      return { noteId };
    });

    // 3. The review COMPUTE (no post). Build the 3-Layer stack, each Layer
    //    degrading when its binding/secret is absent (config dies on read, model
    //    fails typed, scm fails auth-failed) — `mrReviewCompute` catches those
    //    into a failure note and never itself fails. `reviewOutcome` maps the
    //    Exit to the row fields + note body, logging the Cause on any defect.
    let outcome: ReviewOutcome;
    // 1 unless the step's own retries were exhausted (a timeout, typically) —
    // the Slack failure notification reports this as "N attempts".
    let attempts = 1;
    try {
      outcome = await stepDoWith("review", REVIEW_STEP_CONFIG, async () => {
      const modelLayer =
        this.env.AI === undefined
          ? ModelGatewayDeferred
          : makeModelGatewayLive(
              this.env.AI,
              this.env.AI_GATEWAY_ID !== undefined && this.env.AI_GATEWAY_ID.length > 0
                ? this.env.AI_GATEWAY_ID
                : undefined,
            );
      const configLayer =
        this.env.CONFIG_KV === undefined
          ? ConfigDeferred
          : makeConfigKvLive(this.env.CONFIG_KV);
      const layer = Layer.mergeAll(modelLayer, configLayer, scmLayer);

      const exit = await Effect.runPromiseExit(
        mrReviewCompute(input).pipe(Effect.provide(layer)),
      );
      return reviewOutcome(exit);
      });
    } catch (cause) {
      // Retries exhausted (timeouts, or a defect the compute did not catch). Finalize as
      // failure and say so on the MR instead of erroring the Workflow silently.
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[gitlab-review] review step failed after retries: ${message}`);
      outcome = reviewStepFailedOutcome(message);
      attempts = REVIEW_STEP_ATTEMPTS;
    }

    // Capture the "review finished" instant as its OWN tiny durable step —
    // NOT a plain `Date.now()` here, which would recompute on every replay of
    // `run()` (this line is outside any `step.do`, so a Workflow that
    // hibernates and wakes between here and `finalize` completing would
    // re-read a LATER `Date.now()` each time, inflating `elapsedMs` by
    // however long the Workflow sat idle). `step.do` memoizes this the first
    // time it completes, so a replay always gets the SAME `reviewedAt` back —
    // the same reasoning `insert-execution`'s `startedAt` already relies on.
    const { reviewedAt } = await stepDo("mark-reviewed-at", async () => ({ reviewedAt: Date.now() }));

    // Wall time + step count for the timing/infra-cost footer AND the D1
    // summary — computed ONCE, right here (not literally inside `finalize`),
    // so the SAME numbers appear in the posted note and in `summary_json`;
    // computing them at `finalize` instead would need a second note update to
    // add the footer after `post-review` already posted. The gap between here
    // and `finalize` completing is a few D1/HTTP round-trips (no model calls),
    // so this slightly UNDER-counts true wall time rather than over-counting —
    // the note already marks the figure "est.". `stepsRun` is the FIXED count
    // of steps this method always runs, in order: insert-execution,
    // post-placeholder, review, mark-reviewed-at, post-review, notify-failure,
    // finalize — seven. `notify-failure` always executes as a step (it just
    // no-ops internally when there is nothing to notify), so it is never
    // conditional here.
    const elapsedMs = reviewedAt - startedAt;
    const stepsRun = 7;

    // 4. Post the result — its OWN durable step, so a replay after a completed
    //    post/update never re-posts the model fan-out's note. Best-effort: a
    //    post/update failure is logged, never fails the (already-computed)
    //    review. `skipped-quota`'s `noteBody` is `null` (nothing was rendered
    //    by the review) — {@link skippedQuotaNoteBody} still gives the MR a
    //    short, honest terminal status instead of leaving the "review
    //    started … results replace this note" placeholder standing forever.
    //
    //    When the placeholder posted (noteId present), UPDATE it in place —
    //    this is what keeps a Workflow replay idempotent on the note (a
    //    replayed post-review updates the same note rather than duplicating
    //    it) and what stops an MR ending up with both the placeholder AND a
    //    separate result note. Creates a fresh note when there was no
    //    placeholder id (posting it failed, or GITLAB_TOKEN is absent) or the
    //    placeholder was deleted out from under us (`ScmError.reason ===
    //    "not-found"`). A transient GitLab error, an auth failure or a rate
    //    limit retries the (idempotent) update instead; when that is
    //    exhausted the review reports `posted: false` — an alert, never a
    //    second note next to the placeholder.
    const postResult = await stepDo("post-review", async () => {
      const rawBody = outcome.noteBody ?? (outcome.status === "skipped-quota" ? skippedQuotaNoteBody() : null);
      if (rawBody === null) return { posted: false, noteId: placeholder.noteId, superseded: false };
      // The webhook route already cancelled this run when a newer head
      // superseded it — a race can still reach this step, and posting now
      // would put a stale review next to the newer head's note.
      const row = await db.prepare("SELECT status FROM executions WHERE id = ?").bind(executionId).first<{ status: string }>();
      if (row?.status === "superseded") {
        return { posted: false, noteId: placeholder.noteId, superseded: true };
      }
      // A `failure` outcome's `calls: 0` can be a LOST count (a retry-exhausted
      // step's usage never made it out), not a true zero — render "unknown"
      // rather than asserting a number the review never actually confirmed.
      const body = withTimingFooter(rawBody, {
        elapsedMs,
        modelCalls: outcome.status === "failure" ? "unknown" : outcome.calls,
        steps: stepsRun,
      });
      const program =
        placeholder.noteId !== null
          ? mrUpdateNote(input, placeholder.noteId, body).pipe(
              // A PUT is idempotent, a POST is not: ride out a transient
              // failure (a lost response after a server-side write included)
              // by repeating the UPDATE, never by creating a second note.
              Effect.retry({
                while: (e) => !(e instanceof ScmError && e.reason === "not-found"),
                schedule: Schedule.exponential("2 seconds").pipe(Schedule.compose(Schedule.recurs(2))),
              }),
              Effect.as(placeholder.noteId as string | null),
              // Create a fresh note ONLY when the placeholder is gone; any other
              // exhausted failure surfaces as `posted: false` (finalize downgrades
              // the row, notify-failure alerts) rather than a duplicate note.
              Effect.catchTag("ScmError", (e) =>
                e.reason === "not-found" ? mrPostNote(input, body).pipe(Effect.map((r) => r.noteId)) : Effect.fail(e),
              ),
            )
          : mrPostNote(input, body).pipe(Effect.map((r) => r.noteId));
      const noteId = await Effect.runPromise(
        program.pipe(
          Effect.provide(scmLayer),
          Effect.catchAll((e) =>
            Effect.logWarning(`gitlab-review: posting MR note failed — ${String(e)}`).pipe(
              Effect.as<string | null>(null),
            ),
          ),
        ),
      );
      // `posted` deliberately means "a note id came back": the degraded no-token
      // Layer resolves with `noteId: null` and must count as NOT posted
      // (finalize downgrades the row, notify-failure alerts), and GitLab's notes
      // API always returns an `id`, so a successful POST is never misread here.
      return { posted: noteId !== null, noteId, superseded: false };
    });

    // 5. Alert the operator on Slack — when the review degraded OR finished
    //    without the MR note (a `success` row that finalize's
    //    `reconcilePostedStatus` downgrades to `failure`), AND the deploy opted
    //    in (SLACK_WEBHOOK_URL set). A Slack failure is logged inside
    //    postSlackFailureNotification and never thrown, so this step itself can
    //    never fail the Workflow.
    const slackWebhookUrl = this.env.SLACK_WEBHOOK_URL;
    await stepDo("notify-failure", async () => {
      // A `superseded` run was cancelled by a newer head — not an incident.
      if (postResult.superseded) {
        return { notified: false };
      }
      // `success` here can still mean the MR never got the note: finalize's
      // `reconcilePostedStatus` downgrades that row to `failure`, but without
      // this branch Slack stays silent, which defeats the alert.
      const noteNotPosted = outcome.status === "success" && !postResult.posted;
      if (
        outcome.status !== "failure" &&
        outcome.status !== "skipped-quota" &&
        !noteNotPosted
      ) {
        return { notified: false };
      }
      if (slackWebhookUrl === undefined || slackWebhookUrl.trim().length === 0) {
        return { notified: false };
      }
      const message = buildSlackFailureMessage({
        projectId: input.projectId,
        iid: input.iid,
        projectWebUrl: input.projectWebUrl,
        ...(input.title !== undefined ? { title: input.title } : {}),
        headSha: input.headSha,
        noteId: postResult.noteId,
        // The early return above already excluded a posted `success`; spell the
        // narrowing out for the type (a `success` here IS the note-not-posted case).
        status: noteNotPosted ? "note-not-posted" : outcome.status === "skipped-quota" ? "skipped-quota" : "failure",
        reason: noteNotPosted
          ? "review completed but the MR note could not be posted (no GITLAB_TOKEN, or GitLab rejected the note — see the Worker logs)"
          : outcome.reason ?? "unknown",
        attempts,
        executionId,
        ...(this.env.WORKFLOW_NAME !== undefined ? { workflowName: this.env.WORKFLOW_NAME } : {}),
        ...(this.env.CLOUDFLARE_ACCOUNT_ID !== undefined ? { accountId: this.env.CLOUDFLARE_ACCOUNT_ID } : {}),
      });
      const notified = await postSlackFailureNotification(slackWebhookUrl, message);
      return { notified };
    });

    // 6. Terminal status + summary — elapsedMs + the model-call count are
    //    folded into summary_json here (alongside whatever reviewOutcome
    //    already put there) so the D1 row always carries the timing/infra
    //    inputs, even on a compute-level failure whose own summaryJson is null.
    //    `reconcilePostedStatus` downgrades a `success` whose note never made
    //    it out (post-review's `posted: false`) to `failure` — the row must
    //    not claim success for a note nobody saw.
    //    A `superseded` run keeps the status the route already wrote and only
    //    stamps `completed_at`; its summary still carries elapsedMs/calls.
    await stepDo("finalize", async () => {
      const prevSummary = outcome.summaryJson !== null
        ? (JSON.parse(outcome.summaryJson) as Record<string, unknown>)
        : {};
      const { status: finalStatus, summaryExtra } = reconcilePostedStatus(outcome, postResult.posted);
      const summaryJson = JSON.stringify({
        ...prevSummary,
        // Spreading `null` in an object literal is a documented no-op — no
        // `?? {}` fallback needed.
        ...summaryExtra,
        elapsedMs,
        // Same rule as the note footer: a `failure` outcome's `calls` can be a
        // LOST count (retry-exhausted step), so D1 records `null`, never a `0`
        // the note itself refuses to assert.
        calls: outcome.status === "failure" ? null : outcome.calls,
      });
      // `json_patch` MERGES into the column instead of replacing it: keys other
      // steps and the webhook route wrote there (`$.placeholderNoteId` from
      // post-placeholder, `$.supersededBy` from the route) survive the terminal
      // update — `summaryJson` here is built from the in-memory outcome and
      // knows nothing about them.
      if (postResult.superseded) {
        // The route already set `status = 'superseded'`; never overwrite it.
        await db
          .prepare(
            `UPDATE executions SET completed_at = ?, summary_json = json_patch(coalesce(summary_json, '{}'), ?) WHERE id = ?`,
          )
          .bind(Date.now(), summaryJson, executionId)
          .run();
        return { finalized: true, superseded: true };
      }
      await db
        .prepare(
          `UPDATE executions SET status = ?, completed_at = ?, summary_json = json_patch(coalesce(summary_json, '{}'), ?) WHERE id = ?`,
        )
        .bind(finalStatus, Date.now(), summaryJson, executionId)
        .run();
      return { finalized: true, superseded: false };
    });
  }
}
