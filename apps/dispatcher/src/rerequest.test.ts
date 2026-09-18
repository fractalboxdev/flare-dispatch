// FlareDispatch Dispatcher — check-run re-run acceptance tests.
//
// Drives `POST /v1/webhooks/github` through the router with signed
// `check_run.rerequested` / `check_suite.rerequested` deliveries against a
// seeded executions table, and asserts what reaches `RUNS_WORKFLOW.create`.

import { describe, expect, it } from "vitest";
import { sign } from "./hmac";
import { MAX_ATTEMPTS, retryExecutionId } from "./rerequest";
import { handleRequest } from "./router";
import { makeFakeD1, makeFakeEnv, makeFakeKv, makeFakeR2, makeFakeWorkflow } from "./test-helpers";

const WEBHOOK_SECRET = "github-webhook-secret-please-rotate";
const APP_ID = "4242";
const REPO = "owner/test-repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ROOT = "check_owner_test-repo_0123456789ab";

/** A recorded `executions` row, snake_case like D1 returns it. */
const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: ROOT,
  run: "check",
  repo: REPO,
  ref: "refs/heads/main",
  sha: SHA,
  status: "failure",
  started_at: 1_000,
  completed_at: 2_000,
  parent_execution_id: null,
  input_json: JSON.stringify({ repo: REPO, sha: SHA, install: false, secrets: [] }),
  summary_json: null,
  check_run_id: 555,
  attempt: 1,
  retry_of: null,
  ...over,
});

const checkRunPayload = (over: { checkRunId?: number; appId?: number } = {}) => ({
  action: "rerequested",
  check_run: {
    id: over.checkRunId ?? 555,
    head_sha: SHA,
    name: "flare-dispatch/check",
    app: { id: over.appId ?? Number(APP_ID) },
  },
  repository: { full_name: REPO },
  installation: { id: 99999 },
});

const deliver = async (
  env: ReturnType<typeof makeFakeEnv>,
  event: string,
  payload: unknown,
  deliveryId = crypto.randomUUID(),
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const bodyText = JSON.stringify(payload);
  const res = await handleRequest(
    new Request("https://dispatcher.example/v1/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": deliveryId,
        "X-Hub-Signature-256": await sign(WEBHOOK_SECRET, new TextEncoder().encode(bodyText)),
      },
      body: bodyText,
    }),
    env,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const fixture = (opts: {
  executions: Record<string, unknown>[];
  /** Workflow instance status per id; unlisted ids have no instance. */
  instances?: Record<string, string>;
}) => {
  const workflow = makeFakeWorkflow({
    instanceStatus: (id) => opts.instances?.[id],
  });
  const metadata = makeFakeD1({ executions: opts.executions });
  const env = makeFakeEnv({
    hmacSecret: "unused",
    workflow,
    storage: makeFakeR2(),
    idempotencyKv: makeFakeKv().binding,
    githubWebhookSecret: WEBHOOK_SECRET,
    githubAppId: APP_ID,
    metadata,
  });
  return { env, workflow };
};

describe("check_run.rerequested", () => {
  it("re-dispatches the execution that posted the check as attempt 2", async () => {
    const { env, workflow } = fixture({
      executions: [row({})],
      instances: { [ROOT]: "errored" },
    });

    const { status, body } = await deliver(env, "check_run", checkRunPayload());

    expect(status).toBe(202);
    const expectedId = retryExecutionId(ROOT, 2);
    expect(body["rerun"]).toEqual([
      { kind: "dispatched", run: "check", executionId: expectedId, attempt: 2, retryOf: ROOT },
    ]);
    expect(workflow.calls).toHaveLength(1);
    expect(workflow.calls[0]).toEqual({
      id: expectedId,
      params: {
        executionId: expectedId,
        run: "check",
        github: {
          repo: REPO,
          ref: "refs/heads/main",
          sha: SHA,
          installation_id: 99999,
        },
        inputs: { repo: REPO, sha: SHA, install: false, secrets: [] },
        origin: "https://dispatcher.example",
        attempt: 2,
        retryOf: ROOT,
      },
    });
  });

  it("numbers past every recorded attempt, whichever check-run was clicked", async () => {
    // The OLD (attempt-1) check-run is re-run after attempt 2 already failed.
    const second = retryExecutionId(ROOT, 2);
    const { env, workflow } = fixture({
      executions: [row({}), row({ id: second, attempt: 2, retry_of: ROOT, check_run_id: 556 })],
      instances: { [ROOT]: "complete", [second]: "complete" },
    });

    const { body } = await deliver(env, "check_run", checkRunPayload({ checkRunId: 555 }));

    expect(body["rerun"]).toMatchObject([{ kind: "dispatched", attempt: 3, retryOf: ROOT }]);
    expect(workflow.calls.map((c) => c.id)).toEqual([retryExecutionId(ROOT, 3)]);
  });

  it("refuses while an attempt is live — a click storm dispatches once", async () => {
    const second = retryExecutionId(ROOT, 2);
    const { env, workflow } = fixture({
      executions: [row({})],
      instances: { [ROOT]: "complete" },
    });

    // First click dispatches attempt 2; the platform now reports it queued.
    await deliver(env, "check_run", checkRunPayload());
    const statuses = { [ROOT]: "complete", [second]: "queued" };
    const stormEnv = {
      ...env,
      RUNS_WORKFLOW: makeFakeWorkflow({ instanceStatus: (id) => statuses[id] }).binding,
    };
    const results = await Promise.all(
      [1, 2, 3].map(() => deliver(stormEnv, "check_run", checkRunPayload())),
    );

    expect(workflow.calls).toHaveLength(1);
    for (const { body } of results) {
      expect(body["rerun"]).toEqual([
        { kind: "refused", reason: "in_progress", executionId: second },
      ]);
    }
  });

  it("refuses while the recorded execution's Workflow is still running", async () => {
    const { env, workflow } = fixture({
      executions: [row({ status: "running", completed_at: null })],
      instances: { [ROOT]: "running" },
    });

    const { body } = await deliver(env, "check_run", checkRunPayload());

    expect(body["rerun"]).toEqual([{ kind: "refused", reason: "in_progress", executionId: ROOT }]);
    expect(workflow.calls).toHaveLength(0);
  });

  it("retries a row stuck at `running` whose Workflow died with its container", async () => {
    const { env, workflow } = fixture({
      executions: [row({ status: "running", completed_at: null })],
      instances: { [ROOT]: "errored" },
    });

    const { body } = await deliver(env, "check_run", checkRunPayload());

    expect(body["rerun"]).toMatchObject([{ kind: "dispatched", attempt: 2 }]);
    expect(workflow.calls).toHaveLength(1);
  });

  it("steps past an attempt the platform accepted but that never recorded a row", async () => {
    const second = retryExecutionId(ROOT, 2);
    const { env, workflow } = fixture({
      executions: [row({})],
      instances: { [ROOT]: "complete", [second]: "errored" },
    });

    const { body } = await deliver(env, "check_run", checkRunPayload());

    expect(body["rerun"]).toMatchObject([{ kind: "dispatched", attempt: 3 }]);
    expect(workflow.calls.map((c) => c.id)).toEqual([retryExecutionId(ROOT, 3)]);
  });

  it(`refuses after ${MAX_ATTEMPTS} attempts`, async () => {
    const last = retryExecutionId(ROOT, MAX_ATTEMPTS);
    const { env, workflow } = fixture({
      executions: [row({}), row({ id: last, attempt: MAX_ATTEMPTS, retry_of: ROOT })],
    });

    const { body } = await deliver(env, "check_run", checkRunPayload());

    expect(body["rerun"]).toEqual([
      { kind: "refused", reason: "attempts_exhausted", executionId: last },
    ]);
    expect(workflow.calls).toHaveLength(0);
  });

  it("refuses a check-run another App posted", async () => {
    const { env, workflow } = fixture({ executions: [row({})] });

    const { body } = await deliver(env, "check_run", checkRunPayload({ appId: 7 }));

    expect(body["rerun"]).toEqual([{ kind: "refused", reason: "foreign_app" }]);
    expect(workflow.calls).toHaveLength(0);
  });

  it("refuses a check-run no execution on this deploy posted", async () => {
    const { env, workflow } = fixture({ executions: [row({})] });

    const { body } = await deliver(env, "check_run", checkRunPayload({ checkRunId: 1 }));

    expect(body["rerun"]).toEqual([{ kind: "refused", reason: "unknown_check_run" }]);
    expect(workflow.calls).toHaveLength(0);
  });

  it("refuses when the recorded inputs no longer decode against the run", async () => {
    const { env, workflow } = fixture({
      executions: [row({ input_json: JSON.stringify({ repo: "not a repo" }) })],
    });

    const { body } = await deliver(env, "check_run", checkRunPayload());

    expect(body["rerun"]).toEqual([
      { kind: "refused", reason: "inputs_unreplayable", executionId: ROOT },
    ]);
    expect(workflow.calls).toHaveLength(0);
  });

  it("leaves other check_run actions to the trigger fan-out", async () => {
    const { env, workflow } = fixture({ executions: [row({})] });

    const { body } = await deliver(env, "check_run", { ...checkRunPayload(), action: "completed" });

    expect(body["rerun"]).toBeUndefined();
    expect(body["dispatched"]).toEqual([]);
    expect(workflow.calls).toHaveLength(0);
  });
});

describe("check_suite.rerequested", () => {
  const suitePayload = {
    action: "rerequested",
    check_suite: { head_sha: SHA, app: { id: Number(APP_ID) } },
    repository: { full_name: REPO },
    installation: { id: 99999 },
  };

  it("re-runs each check at the commit whose latest attempt did not pass", async () => {
    const lint = "check_lint_owner_test-repo_0123456789ab";
    const deploy = "worker-deploy_owner_test-repo_0123456789ab";
    const { env, workflow } = fixture({
      executions: [
        row({}),
        row({
          id: lint,
          check_run_id: 600,
          input_json: JSON.stringify({ repo: REPO, sha: SHA, checkLabel: "lint" }),
        }),
        row({ id: deploy, run: "worker-deploy", status: "success", check_run_id: 700 }),
        // A spawned child reports through its parent — never re-run on its own.
        row({ id: "child", parent_execution_id: ROOT, check_run_id: 800 }),
        // An uncredentialed execution posted no check.
        row({ id: "silent", check_run_id: "noop" }),
      ],
    });

    const { body } = await deliver(env, "check_suite", suitePayload);

    expect(body["rerun"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "dispatched", retryOf: ROOT, attempt: 2 }),
        expect.objectContaining({ kind: "dispatched", retryOf: lint, attempt: 2 }),
        { kind: "succeeded", executionId: deploy },
      ]),
    );
    expect((body["rerun"] as unknown[]).length).toBe(3);
    expect(workflow.calls.map((c) => c.id).sort()).toEqual(
      [retryExecutionId(ROOT, 2), retryExecutionId(lint, 2)].sort(),
    );
  });
});
