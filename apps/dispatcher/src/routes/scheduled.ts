// FlareDispatch Dispatcher — Schedule-mode handler.
//
// The wall-clock dispatch path: a Cloudflare Cron Trigger (declared in
// `wrangler.jsonc` `triggers.crons`) fires the Worker's `scheduled()` handler;
// this module routes the firing `controller.cron` to every run in the registry
// whose `schedules[].cron` matches, applies each match's `gate`, computes the
// `idempotencyKey`, and instantiates a `RunWorkflow` with that key as the
// Workflow id (CF Workflows treats a duplicate `create({ id })` as a no-op —
// that is the free dedup the spec relies on).
//
// Spec: specs/04-gha-integration.md § Schedule mode + § Receiver dedup,
//       specs/03-dsl.md § schedules.
//
// --- Three deliberate departures from the dispatch route ---------------------
//
// 1. No HMAC verify. A cron tick is a Cloudflare-internal signal, not an
//    inbound request — there is no body and no caller to authenticate. The
//    handler trusts `controller.cron` + `controller.scheduledTime` as
//    delivered by the runtime.
//
// 2. No `inputs` Schema validation against the run. `schedules[].inputs(ctx)`
//    is in-process code in the run module — a malformed input is a build-time
//    bug, not a dispatch-time surprise. Validation is what `defineRun`'s load-
//    time check already enforces. (The Workflow itself still decodes against
//    `run.inputs` when it picks up the payload — that catches drift between
//    `schedules.inputs` and the schema.)
//
// 3. No 4xx return shape. The Cron Trigger does not consume a response body;
//    this handler returns `void` after firing whatever matched, logging
//    "warn" if `controller.cron` matched nothing on this deploy (likely a
//    drift between `wrangler.jsonc` and the registered runs' `schedules`).
//
// --- Idempotency / dedup -----------------------------------------------------
//
// The execution's ULID is *also* the Workflow instance id, the same way
// dispatch.ts uses a freshly-minted ULID. For Schedule mode we additionally
// pass `idempotencyKey(ctx)` as the Workflow id — collapsing duplicate cron
// deliveries (CF Cron Triggers can fire twice in pathological cases) and
// any same-window redelivery from a Worker recycle. The `RunWorkflow`'s
// own `executions` D1 row is keyed off the *Workflow instance* id, so a
// dedup-collapsed second call is a literal no-op end-to-end.

import { toInstanceId } from "../instance-id";
import { type ScheduleMatch, schedulesByCron } from "../registry";
import type { Env } from "../env";

/** Trim a long cron to fit inline in a log message. */
const fmt = (cron: string): string =>
  cron.length > 40 ? `${cron.slice(0, 37)}...` : cron;

/**
 * The scheduled-handler entry point — fan one cron tick out across every
 * run that subscribed to that expression. Errors from a single run's
 * `create({ id })` are caught + logged so one bad run does not poison the
 * sibling dispatches for the same tick.
 *
 * @param env             binding env (`RUNS_WORKFLOW`).
 * @param cron            `controller.cron` — the expression that fired.
 * @param scheduledTime   `controller.scheduledTime` — epoch ms.
 */
export const handleScheduled = async (
  env: Env,
  cron: string,
  scheduledTime: number,
): Promise<void> => {
  const matches = schedulesByCron(cron);

  if (matches.length === 0) {
    // `wrangler.jsonc` declared a cron the registry does not bind any run to.
    // Most likely a left-over expression after a run was retired, or a typo
    // between the wrangler entry and the run's `schedules[].cron`.
    console.warn(
      `[scheduled] cron tick "${fmt(cron)}" matched no registered runs`,
    );
    return;
  }

  const ctx = { cron, firedAt: scheduledTime };

  await Promise.all(
    matches.map(async (match) => fireOne(env, match, ctx)),
  );
};

/** Fire a single (run, schedule-spec) match, swallowing individual failures. */
const fireOne = async (
  env: Env,
  match: ScheduleMatch,
  ctx: { cron: string; firedAt: number },
): Promise<void> => {
  const { run, schedule } = match;

  // Optional caller-side gate — freeze windows, holiday skips, etc.
  if (schedule.gate && !schedule.gate(ctx)) {
    console.info(
      `[scheduled] gate skipped run="${run.name}" cron="${fmt(ctx.cron)}"`,
    );
    return;
  }

  const id = toInstanceId(schedule.idempotencyKey(ctx));
  const inputs = schedule.inputs(ctx);

  // The Workflow `params` shape `RunWorkflow.run` decodes — same as dispatch.ts.
  // Schedule mode has no GitHub event; the run's own `inputs` carries the
  // target repo/ref/sha (e.g. `product-demo` records against a deployed URL).
  // `payload.github` here is just executions-row metadata + the optional
  // check-run hint — installation_id is omitted, so `Checks` falls through to
  // the no-op Layer (the run still records its rows, only the PR check-run is
  // skipped). An operator who wants a check-run on a tracking repo sets
  // `SCHEDULED_CHECK_RUN_*` env vars — deferred to a follow-up.
  const target = scheduleGithubTarget(inputs);
  const params = {
    executionId: id,
    run: run.name,
    github: target,
    inputs,
  };

  try {
    await env.RUNS_WORKFLOW.create({ id, params });
    console.info(
      `[scheduled] fired run="${run.name}" id="${id}" cron="${fmt(ctx.cron)}"`,
    );
  } catch (cause) {
    // CF Workflows throws on a duplicate `create({ id })` — that is the dedup
    // path. Treat it as success and move on.
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/already exists|duplicate/i.test(message)) {
      console.info(
        `[scheduled] dedup run="${run.name}" id="${id}" cron="${fmt(ctx.cron)}"`,
      );
      return;
    }
    console.error(
      `[scheduled] create failed run="${run.name}" id="${id}": ${message}`,
    );
  }
};

/**
 * Synthesize the `github` block `RunWorkflow` expects. The cron tick carries
 * no GitHub payload, so we lift `repo` / `ref` / `sha` from the run's own
 * inputs when they are present. The fallback is a placeholder — the Workflow
 * uses these fields only for the executions D1 row and the (no-op) check-run
 * Layer when no `installation_id` is wired.
 *
 * A run that wants a real check-run on its tracking repo should put
 * `installation_id` in its `inputs` and the operator should set
 * `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`; that path is wired but no
 * shipped Schedule-mode run uses it yet.
 */
const scheduleGithubTarget = (
  inputs: unknown,
): { repo: string; ref: string; sha: string; installation_id?: number } => {
  const obj = (inputs ?? {}) as Record<string, unknown>;
  const repo = typeof obj.repo === "string" ? obj.repo : "schedule/unknown";
  const ref = typeof obj.ref === "string" ? obj.ref : "refs/heads/main";
  const sha = typeof obj.sha === "string" ? obj.sha : (typeof obj.ref === "string" ? obj.ref : "main");
  const installation_id =
    typeof obj.installation_id === "number" ? obj.installation_id : undefined;

  // Warn when the run's `schedules[].inputs()` returned a shape without
  // the fields the `executions` row expects — a Schema mismatch between
  // the schedule inputs and the run's own `inputs` schema. The Workflow
  // will validate again at decode time, but surfacing the mismatch here
  // gives the operator a faster diagnosis path.
  if (typeof obj.repo !== "string") {
    console.warn(
      `[scheduled] scheduleGithubTarget: inputs.repo is not a string (got ${typeof obj.repo}), falling back to "schedule/unknown"`,
    );
  }
  if (typeof obj.ref !== "string") {
    console.warn(
      `[scheduled] scheduleGithubTarget: inputs.ref is not a string (got ${typeof obj.ref}), falling back to "refs/heads/main"`,
    );
  }

  return installation_id !== undefined
    ? { repo, ref, sha, installation_id }
    : { repo, ref, sha };
};
