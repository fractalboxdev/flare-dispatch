// GitHub writes on the cloud path under the shared installation quota: the Worker holds an App key, the fixture server
// answers GitHub from the recorded state of `fixtures/intake-github.json`, and each GitHub App installation's permits and
// budget live in its `InstallationQuota` object, which the test reaches as one more client of that object
// (specs/architecture.md FD-ARCH-003, specs/github-output.md § Installation quota).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QuotaObject } from "@fractalboxdev/flare-dispatch-github";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RATE_LIMIT, type GithubState } from "./fixtures/github-server.ts";
import { startStack, WEBHOOK_SECRET, type Stack } from "./stack.ts";

const STATE = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/intake-github.json"), "utf8"),
) as GithubState;

const WIDGETS = "acme/widgets";
const INSTALLATION = STATE.repositories[WIDGETS]!.installation;
/** How long the object holds the installation's calls back. */
const BLOCK_MS = 2_000;

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ github: STATE });
});

afterAll(async () => {
  await stack?.close();
});

/** The `InstallationQuota` object of `installation`, as the Worker's `INSTALLATION_QUOTA` binding names it. */
const quotaOf = async (installation: number) => {
  const namespace = await stack.mf.getDurableObjectNamespace("INSTALLATION_QUOTA");
  return namespace.get(namespace.idFromName(String(installation))) as unknown as QuotaObject;
};

/** The recorded pull request to acme/widgets with its head at `sha`; answers the execution it admitted. */
const pullRequest = async (sha: string) => {
  const delivery = stack.github.delivery(
    "pull_request",
    "pull_request.opened.json",
    WEBHOOK_SECRET,
    (payload) => {
      const pr = payload["pull_request"] as Record<string, Record<string, unknown>>;
      return { ...payload, pull_request: { ...pr, head: { ...pr["head"], sha } } };
    },
  );
  const r = await fetch(`${stack.url}/v1/webhooks/github`, {
    method: "POST",
    headers: delivery.headers,
    body: delivery.body,
  });
  expect(r.status).toBe(202);
  const { executions } = (await r.json()) as { executions: string[] };
  expect(executions).toHaveLength(1);
  return executions[0]!;
};

/** The 15-minute probes push a canary; a tick outside their minute drains and runs the units only. */
const PROBE_INTERVAL_MS = 15 * 60_000;

/** One minute tick through the Worker's `scheduled` handler, at a time no earlier than any row's insertion. */
const tick = async () => {
  let at = Date.now() + 1_000;
  if (at % PROBE_INTERVAL_MS < 60_000) at += 60_000;
  const worker = await stack.mf.getWorker();
  await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date(at) });
  const db = await stack.mf.getD1Database("DB");
  await expect
    .poll(
      async () => (await db.prepare("select at from fd_liveness where key = 'tick'").all()).results,
    )
    .toEqual([{ at }]);
};

const outboxRowOf = async (executionId: string) => {
  const db = await stack.mf.getD1Database("DB");
  return db
    .prepare("select kind, state, sends, attempts from outbox where execution_id = ?")
    .bind(executionId)
    .first();
};

const checkRunWritesFor = (executionId: string) =>
  stack.github.writes.filter(
    (w) =>
      w.method === "POST" &&
      w.path === `/repos/${WIDGETS}/check-runs` &&
      (w.body as { external_id?: string }).external_id === executionId,
  );

describe("the installation's InstallationQuota object", () => {
  it("[FD-ARCH-003] a check-run write goes out only under a permit from its installation's InstallationQuota object", async () => {
    const executionId = await pullRequest("a".repeat(40));
    // The object holds a `Retry-After` the Worker never saw, which no later response lifts: only an isolate that asks
    // the object for its permit holds the write back.
    const until = Date.now() + BLOCK_MS;
    await (await quotaOf(INSTALLATION)).observe(String(INSTALLATION), { retryAfterAt: until });
    await tick();
    expect(checkRunWritesFor(executionId)).toEqual([]);
    expect(await outboxRowOf(executionId)).toEqual({
      kind: "check.open",
      state: "pending",
      sends: 0,
      attempts: 0,
    });

    // Once the instant passes, the next tick's drainer takes its permit and writes under the installation token.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now()) + 50));
    await tick();
    expect(checkRunWritesFor(executionId)).toHaveLength(1);
    expect(await outboxRowOf(executionId)).toMatchObject({
      kind: "check.open",
      state: "applied",
      sends: 1,
    });
  });

  it("[FD-ARCH-003] every response to the installation's token reports its budget to the installation's InstallationQuota object", async () => {
    const executionId = await pullRequest("b".repeat(40));
    await tick();
    expect(checkRunWritesFor(executionId)).toHaveLength(1);
    // The fixture's budget starts below the object's own default, so only the observed headers explain this share.
    const share = await (await quotaOf(INSTALLATION)).remainingShare(String(INSTALLATION), Date.now());
    expect(share * RATE_LIMIT).toBe(stack.github.remaining(INSTALLATION));
    expect(share).toBeLessThan(0.8);
  });
});
