// The installation quota's key on the composed control plane: the control plane Worker under workerd through
// Miniflare with the GitHub App and the recorded GitHub fixture server. A pull request's admission inserts its
// `check.open` row under the profile's `delivery.limit_key` binding, `installationOf`, so the row carries the id of the
// installation that serves its repository, and the minute tick's drain takes the row's permit under that key and opens
// the check run (specs/github-output.md § Installation quota).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GithubState } from "../../../apps/control-plane/test/e2e-local/fixtures/github-server.ts";
import {
  startStack,
  WEBHOOK_SECRET,
  type Stack,
} from "../../../apps/control-plane/test/e2e-local/stack.ts";

const STATE = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "../../../apps/control-plane/test/e2e-local/fixtures/intake-github.json",
    ),
    "utf8",
  ),
) as GithubState;

const WIDGETS = "acme/widgets";
const BASE = STATE.repositories[WIDGETS]!.branches["main"]!;
const HEAD = "9".repeat(40);

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ github: STATE });
}, 120_000);

afterAll(async () => {
  await stack?.close();
});

/** A pull request opened against `main` of acme/widgets; answers the executions it admitted. */
const openPullRequest = async () => {
  const delivery = stack.github.delivery(
    "pull_request",
    "pull_request.opened.json",
    WEBHOOK_SECRET,
    (p) => {
      const pr = p["pull_request"] as Record<string, Record<string, unknown>>;
      return {
        ...p,
        pull_request: {
          ...pr,
          head: { ...pr["head"], sha: HEAD },
          base: { ...pr["base"], sha: BASE },
        },
      };
    },
  );
  const r = await fetch(`${stack.url}/v1/webhooks/github`, {
    method: "POST",
    headers: delivery.headers,
    body: delivery.body,
  });
  expect(r.status).toBe(202);
  return ((await r.json()) as { executions: string[] }).executions;
};

describe("the installation quota's key", () => {
  it("[FD-GH-056] admission keys a repository's rows by the installation that serves it, and the drain opens the check run under that key", async () => {
    const [executionId] = await openPullRequest();
    expect(executionId).toBeDefined();
    const db = await stack.mf.getD1Database("DB");
    const rows = async () =>
      (
        await db
          .prepare("select kind, limit_key, state from outbox where execution_id = ?")
          .bind(executionId)
          .all<{ kind: string; limit_key: string; state: string }>()
      ).results;
    const installation = String(STATE.repositories[WIDGETS]!.installation);
    expect(await rows()).toEqual([
      { kind: "check.open", limit_key: installation, state: "pending" },
    ]);

    const worker = await stack.mf.getWorker();
    await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date() });
    await expect.poll(async () => (await rows()).map((r) => r.state)).toEqual(["applied"]);
    expect(
      stack.github.writes.filter((w) => w.path === `/repos/${WIDGETS}/check-runs`),
    ).toHaveLength(1);
  });
});
