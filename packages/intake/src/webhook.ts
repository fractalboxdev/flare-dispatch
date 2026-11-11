// `POST /v1/webhooks/github`: the configured secret, the body bound, the
// signature over the raw bytes, the delivery headers, the event allowlist, then
// one path per event (specs/intake.md § Webhook, § Check re-runs,
// specs/github-output.md § Merge queue, FD-GH-066).
import { GithubRead } from "@fractalboxdev/flare-dispatch-github";
import { Clock, Effect, Option, Schema } from "effect";
import { Admission, IntakeConfig, intakeError } from "./config.ts";
import { commitOf, isForkPr, WebhookFields, type WebhookEvent } from "./event.ts";
import { json, parseJson, readBody } from "./http.ts";
import { ExecutionCanceller, InstallationEviction } from "./ports.ts";
import { PROTECTION_EVENTS, ProtectionSnapshots } from "./protection.ts";
import { rerunCheckRun, rerunCheckSuite } from "./rerun.ts";
import { checkName } from "./runs.ts";
import { verifySignature } from "./signature.ts";
import { IntakeStore, TERMINAL_STATUSES } from "./store.ts";
import { shed } from "./submit.ts";
import { nothing, triggerWebhook, type TriggerOutcome } from "./triggers.ts";

export const WEBHOOK_MAX_BYTES = 25 * 1024 * 1024;

/** The events intake acts on; the App subscribes to these (specs/github-output.md § App registration). */
export const SUPPORTED_EVENTS: ReadonlySet<string> = new Set([
  "pull_request",
  "push",
  "merge_group",
  "check_run",
  "check_suite",
  "deployment_status",
  "installation",
  "installation_repositories",
  "repository_ruleset",
  "branch_protection_rule",
  "ping",
]);

const ignored = (reason: string) => json({ ignored: true, reason }, 202);

const answer = (o: TriggerOutcome) =>
  o.unavailable !== null
    ? Effect.fail(o.unavailable)
    : Effect.succeed(
        json({ executions: o.executions, ...(o.duplicate ? { duplicate: true } : {}) }, 202),
      );

const branchOf = (ref: string) =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;

/**
 * `merge_group` `checks_requested`: the base branch's required gating runs open their check runs on the group's head
 * (FD-GH-075). `destroyed`: every non-terminal execution on the head ends `cancelled(merge-group-destroyed)`
 * (FD-GH-076); the mapping concludes its check run `cancelled`.
 */
const mergeGroup = (event: WebhookEvent, fields: WebhookFields, repo: string, sha: string) =>
  Effect.gen(function* () {
    if (event.action === "destroyed") {
      const store = yield* IntakeStore;
      const canceller = yield* ExecutionCanceller;
      const live = (yield* store.atCommit(repo, sha)).filter(
        (r) => r.status !== null && !TERMINAL_STATUSES.has(r.status),
      );
      yield* Effect.forEach(live, (r) => canceller.cancel(r.executionId, "merge-group-destroyed"));
      return nothing;
    }
    if (event.action !== "checks_requested") return nothing;
    const base = branchOf(fields.merge_group?.base_ref ?? "");
    const required = new Set(yield* (yield* GithubRead).requiredChecks(repo, base));
    return yield* triggerWebhook({
      event,
      fields,
      repo,
      sha,
      trigger: "webhook",
      keep: (run, entry) => run.gating && required.has(checkName(run.name, entry.label ?? null)),
    });
  });

/**
 * `pull_request` `closed`: every supersession group of the pull request, `<owner>/<repo>:<number>:*`, is cancelled with
 * cause `pr-closed` through mameko's group cancel (FD-PROF-030, MAMEKO-ADM-064). A closed pull request submits no run.
 */
const pullRequestClosed = (repo: string, number: number) =>
  Effect.gen(function* () {
    const admission = yield* Admission;
    const groups = yield* (yield* IntakeStore).liveSupersessionGroups(repo, `${repo}:${number}:`);
    const cancelled = yield* Effect.forEach(groups, (key) =>
      admission
        .cancelGroup(key, "pr-closed")
        .pipe(
          Effect.catchTag("IntakeUnavailable", (e) =>
            Effect.fail(intakeError(503, "intake_unavailable", `group cancel failed: ${e.cause}`)),
          ),
        ),
    );
    return json({ executions: [], cancelled: cancelled.flat() }, 202);
  });

/** A signed, parsed delivery, routed by event. */
const route = (event: WebhookEvent, fields: WebhookFields) =>
  Effect.gen(function* () {
    if (event.event === "ping") return json({ ok: true }, 200);
    if (event.event === "installation") {
      const id = fields.installation?.id;
      if (id !== undefined && (event.action === "deleted" || event.action === "suspend"))
        yield* (yield* InstallationEviction).installation(id);
      return json({ executions: [] }, 202);
    }
    if (event.event === "installation_repositories") {
      const removed = (fields.repositories_removed ?? []).map((r) => r.full_name);
      if (removed.length > 0) yield* (yield* InstallationEviction).repositories(removed);
      return json({ executions: [] }, 202);
    }
    // A ruleset or branch-protection change drops the repository's cached protection; an organization ruleset names
    // no repository and drops every one (FD-PROF-014).
    if (PROTECTION_EVENTS.has(event.event)) {
      yield* (yield* ProtectionSnapshots).refresh(
        event.event,
        fields.repository?.full_name ?? null,
      );
      return json({ executions: [] }, 202);
    }

    const repo = fields.repository?.full_name;
    if (repo === undefined) return ignored("no_repository");
    if (event.event === "check_run" || event.event === "check_suite") {
      if (event.action !== "rerequested") return json({ executions: [] }, 202);
      return yield* answer(
        yield* event.event === "check_run"
          ? rerunCheckRun(fields, repo)
          : rerunCheckSuite(fields, repo),
      );
    }
    if (
      event.event === "pull_request" &&
      event.action === "closed" &&
      fields.pull_request !== undefined
    )
      return yield* pullRequestClosed(repo, fields.pull_request.number);
    const sha = commitOf(fields);
    if (Option.isNone(sha)) {
      yield* shed(repo, null, "intake: no commit");
      return ignored("no_commit");
    }
    if (event.event === "merge_group")
      return yield* answer(yield* mergeGroup(event, fields, repo, sha.value));
    return yield* answer(
      yield* triggerWebhook({
        event,
        fields,
        repo,
        sha: sha.value,
        trigger: isForkPr(fields) ? "fork-pr" : "webhook",
      }),
    );
  });

/** The webhook route. Everything before the signature check reads no JSON (FD-INT-022 to FD-INT-027). */
export const handleWebhook = (request: Request) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const secret = config.webhookSecret;
    if (secret === undefined || secret === "")
      return yield* Effect.fail(
        intakeError(503, "webhook_unconfigured", "this deployment holds no webhook secret"),
      );
    const body = yield* readBody(request, WEBHOOK_MAX_BYTES);
    const signed = yield* verifySignature(secret, request.headers.get("x-hub-signature-256"), body);
    if (!signed)
      return yield* Effect.fail(
        intakeError(401, "unauthenticated", "the webhook signature does not match"),
      );
    const deliveryId = request.headers.get("x-github-delivery");
    const name = request.headers.get("x-github-event");
    if (deliveryId === null || deliveryId === "" || name === null || name === "")
      return yield* Effect.fail(
        intakeError(400, "invalid_body", "a webhook carries X-GitHub-Delivery and X-GitHub-Event"),
      );
    const payload = yield* parseJson(body);
    const fields = yield* Schema.decodeUnknownEffect(WebhookFields)(payload).pipe(
      Effect.mapError((e) => intakeError(400, "invalid_body", e.message)),
    );
    const installation = fields.installation?.id;
    if (installation !== undefined)
      yield* (yield* IntakeStore).recordDelivery(installation, yield* Clock.currentTimeMillis);
    if (config.webhookEvents !== undefined && !config.webhookEvents.includes(name))
      return ignored("event_not_allowed");
    if (!SUPPORTED_EVENTS.has(name)) return ignored("event_not_supported");
    const event: WebhookEvent = {
      _tag: "webhook",
      event: name,
      action: fields.action ?? null,
      deliveryId,
      payload,
    };
    return yield* route(event, fields).pipe(
      Effect.catchTags({
        GithubHttpError: (e) => Effect.fail(githubUnavailable(e.message)),
        GithubNetworkError: (e) => Effect.fail(githubUnavailable(e.message)),
        GithubUncredentialed: (e) =>
          Effect.fail(githubUnavailable(`no installation serves ${e.repo}`)),
        GithubUnexpected: (e) => Effect.fail(githubUnavailable(e.message)),
      }),
    );
  });

const githubUnavailable = (message: string) =>
  intakeError(503, "unavailable", `a GitHub read failed: ${message}`);
