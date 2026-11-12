// Triggers reaching the control plane Worker: a signed GitHub webhook delivery and an Actions dispatch over HTTP, and a
// cron tick through its `scheduled` handler. Each is accepted by the Worker and recorded in its D1 database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HEAD,
  OIDC_AUDIENCE,
  REPOSITORY,
  startStack,
  WEBHOOK_SECRET,
  type Stack,
} from "./stack.ts";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.close();
});

const intakeRecord = async (id: string) => {
  const db = await stack.mf.getD1Database("DB");
  return (
    await db
      .prepare("select trigger, run, repo, sha, caller from intake_records where execution_id = ?")
      .bind(id)
      .all()
  ).results;
};

describe("triggers reaching the Worker", () => {
  it("[FD-ARCH-002] the Worker accepts a recorded pull request delivery signed with the webhook secret", async () => {
    const delivery = stack.github.delivery(
      "pull_request",
      "pull_request.opened.json",
      WEBHOOK_SECRET,
    );
    const r = await fetch(`${stack.url}/v1/webhooks/github`, {
      method: "POST",
      headers: delivery.headers,
      body: delivery.body,
    });
    expect(r.status).toBe(202);
    const { executions } = (await r.json()) as { executions: string[] };
    expect(executions).toHaveLength(1);
    expect(await intakeRecord(executions[0]!)).toEqual([
      { trigger: "webhook", run: "check", repo: REPOSITORY, sha: HEAD, caller: null },
    ]);

    // The same bytes under another secret's signature reach no route logic.
    const forged = stack.github.delivery(
      "pull_request",
      "pull_request.opened.json",
      "another-secret",
    );
    const refused = await fetch(`${stack.url}/v1/webhooks/github`, {
      method: "POST",
      headers: forged.headers,
      body: forged.body,
    });
    expect(refused.status).toBe(401);
  });

  it("[FD-ARCH-002] the Worker accepts an Actions dispatch carrying the job's OIDC token", async () => {
    const sha = "3".repeat(40);
    const token = await stack.github.oidcToken({ repository: REPOSITORY, sha }, OIDC_AUDIENCE);
    const r = await fetch(`${stack.url}/v1/dispatch/check`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        repository: REPOSITORY,
        sha,
        inputs: {
          repo: `https://github.com/${REPOSITORY}`,
          sha,
          ref: "refs/heads/main",
          steps: [{ label: "test", command: "pnpm test" }],
        },
      }),
    });
    expect(r.status).toBe(202);
    const { execution_id: id } = (await r.json()) as { execution_id: string };
    expect(await intakeRecord(id)).toEqual([
      {
        trigger: "dispatch",
        run: "check",
        repo: REPOSITORY,
        sha,
        // The caller is the token's repository and workflow ref claims, not its `sub`.
        caller: `actions:${REPOSITORY}:${REPOSITORY}/.github/workflows/ci.yml@refs/heads/main`,
      },
    ]);
    // The Worker read the issuer's keys from GitHub, and nothing else.
    expect(stack.github.calls).toContainEqual({
      method: "GET",
      host: "token.actions.githubusercontent.com",
      path: "/.well-known/jwks",
    });
    expect(stack.github.unrecorded).toEqual([]);
  });

  it("[FD-ARCH-002] the Worker's scheduled handler accepts a cron tick and records it", async () => {
    const worker = await stack.mf.getWorker();
    const at = Date.now();
    await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date(at) });
    const db = await stack.mf.getD1Database("DB");
    await expect
      .poll(
        async () =>
          (await db.prepare("select at from fd_liveness where key = 'tick'").all()).results,
      )
      .toEqual([{ at }]);
  });
});

describe("security-gate on a pull request the other gates skip", () => {
  let scanned: Stack;

  beforeAll(async () => {
    scanned = await startStack({
      manifest: {
        version: 1,
        runs: [
          { recipe: "security-gate", triggers: ["pull_request", "merge_group"], params: {} },
          {
            recipe: "check",
            triggers: ["pull_request"],
            params: { steps: [{ label: "test", command: "pnpm test", timeoutSec: 600 }] },
          },
        ],
      },
    });
  });

  afterAll(async () => {
    await scanned?.close();
  });

  const recorded = async (ids: readonly string[]) => {
    const db = await scanned.mf.getD1Database("DB");
    const rows = (
      await db
        .prepare(
          `select execution_id, trigger, run, sha, inputs_json from intake_records
           where execution_id in (${ids.map(() => "?").join(", ")}) order by run`,
        )
        .bind(...ids)
        .all<{ execution_id: string; trigger: string; run: string; sha: string; inputs_json: string }>()
    ).results;
    return rows.map((r) => ({ ...r, inputs: JSON.parse(r.inputs_json) as Record<string, unknown> }));
  };

  it("[FD-GATE-085] the Worker admits security-gate for a draft pull request from dependabot[bot], with no skip fact in its input", async () => {
    const delivery = scanned.github.delivery(
      "pull_request",
      "pull_request.opened.json",
      WEBHOOK_SECRET,
      (payload) => {
        const pr = payload["pull_request"] as Record<string, unknown>;
        return {
          ...payload,
          pull_request: { ...pr, draft: true, user: { login: "dependabot[bot]", id: 49699333, type: "Bot" } },
          sender: { login: "dependabot[bot]", id: 49699333, type: "Bot" },
        };
      },
    );
    const r = await fetch(`${scanned.url}/v1/webhooks/github`, {
      method: "POST",
      headers: delivery.headers,
      body: delivery.body,
    });
    expect(r.status).toBe(202);
    const { executions } = (await r.json()) as { executions: string[] };
    const rows = await recorded(executions);
    const gate = rows.find((row) => row.run === "security-gate");
    expect(gate).toMatchObject({ trigger: "webhook", sha: HEAD });
    expect(gate!.inputs).toMatchObject({
      repo: `https://github.com/${REPOSITORY}.git`,
      sha: HEAD,
      ref: "refs/pull/7/head",
      base: { _tag: "TargetBranch", branch: "main" },
    });
    expect(gate!.inputs).not.toHaveProperty("pullRequest");
    expect(gate!.inputs).not.toHaveProperty("skipAuthors");
    // `check` answers the same delivery with the draft state and author its body skips on.
    const check = rows.find((row) => row.run === "check");
    expect(check?.inputs).toMatchObject({ pullRequest: { draft: true, author: "dependabot[bot]" } });
  });
});
