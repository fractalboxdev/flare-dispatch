// GitHub output on the cloud path with the GitHub App: the Worker holds an App key and the fixture server answers GitHub
// from the recorded state of `fixtures/intake-github.json`, with acme/widgets' manifest listing both `check` entries for
// `merge_group` too. A webhook only inserts outbox rows; every REST write the fixture server receives is the drainer
// applying one row on the minute tick (specs/github-output.md § Write authority, § Merge queue).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GithubState } from "./fixtures/github-server.ts";
import { startStack, WEBHOOK_SECRET, type Stack } from "./stack.ts";

const RECORDED = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/intake-github.json"), "utf8"),
) as GithubState;

const WIDGETS = "acme/widgets";
/** The check the `ci` entry owns; the base branch requires it. */
const REQUIRED = "flare-dispatch/check:ci";

interface Entry {
  readonly label: string;
  readonly triggers: readonly string[];
}

/** The recorded state, with every entry of acme/widgets' manifest also listed for `merge_group`. */
const STATE: GithubState = (() => {
  const widgets = RECORDED.repositories[WIDGETS]!;
  const manifest = widgets.files[".github/flare-dispatch.json"] as { runs: readonly Entry[] };
  return {
    ...RECORDED,
    repositories: {
      ...RECORDED.repositories,
      [WIDGETS]: {
        ...widgets,
        files: {
          ...widgets.files,
          ".github/flare-dispatch.json": {
            ...manifest,
            runs: manifest.runs.map((r) => ({ ...r, triggers: [...r.triggers, "merge_group"] })),
          },
        },
      },
    },
  };
})();

const RECORDING = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures/recordings/merge_group.checks_requested.json"),
    "utf8",
  ),
) as { merge_group: { head_sha: string; base_sha: string } };
const GROUP_HEAD = RECORDING.merge_group.head_sha;

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ github: STATE });
  stack.github.requireChecks(WIDGETS, "main", [REQUIRED]);
});

afterAll(async () => {
  await stack?.close();
});

const query = async (sql: string, ...params: unknown[]) => {
  const db = await stack.mf.getD1Database("DB");
  return (
    await db
      .prepare(sql)
      .bind(...params)
      .all()
  ).results;
};

const checksRequested = async () => {
  const delivery = stack.github.delivery(
    "merge_group",
    "merge_group.checks_requested.json",
    WEBHOOK_SECRET,
  );
  const r = await fetch(`${stack.url}/v1/webhooks/github`, {
    method: "POST",
    headers: delivery.headers,
    body: delivery.body,
  });
  expect(r.status).toBe(202);
  return ((await r.json()) as { executions: string[] }).executions;
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

const checkRunWrites = () =>
  stack.github.writes.filter(
    (w) => w.method === "POST" && w.path === `/repos/${WIDGETS}/check-runs`,
  );

interface OutboxRow {
  readonly execution_id: string | null;
  readonly kind: string;
  readonly state: string;
  readonly sends: number;
  readonly external_ref: string | null;
  readonly payload_json: string;
}

const outbox = async () =>
  (await query(
    "select execution_id, kind, state, sends, external_ref, payload_json from outbox order by inserted_at, id",
  )) as unknown as OutboxRow[];

describe("a merge group's checks_requested", () => {
  let executions: readonly string[] = [];

  it("[FD-GH-075] opens the check run of each required gating run of the base branch on merge_group.head_sha", async () => {
    executions = await checksRequested();
    // Only the entry whose check the base branch requires is submitted; it runs on the group's head commit.
    expect(executions).toHaveLength(1);
    expect(
      await query(
        "select run, label, sha from intake_records where repo = ? order by created_at",
        WIDGETS,
      ),
    ).toEqual([{ run: "check", label: "ci", sha: GROUP_HEAD }]);
    // The required set came from the base branch's rules, read through the App.
    expect(stack.github.calls).toContainEqual({
      method: "GET",
      host: "api.github.com",
      path: `/repos/${WIDGETS}/rules/branches/main`,
    });

    await tick();
    const opened = checkRunWrites();
    // Exactly one check run: none for the `release` entry, which no rule requires, and none on the group's
    // base commit, which GitHub tests nothing on.
    expect(opened.map((w) => w.body)).toEqual([
      {
        name: REQUIRED,
        head_sha: GROUP_HEAD,
        external_id: executions[0],
        status: "queued",
      },
    ]);
  });
});

describe("write authority", () => {
  it("[FD-GH-001] every GitHub write for an execution is the drainer applying one outbox row, made on the tick and not by the webhook", async () => {
    const before = stack.github.writes.length;
    const delivery = stack.github.delivery(
      "merge_group",
      "merge_group.checks_requested.json",
      WEBHOOK_SECRET,
      (p) => ({
        ...p,
        merge_group: { ...(p["merge_group"] as object), head_sha: "a".repeat(40) },
      }),
    );
    const r = await fetch(`${stack.url}/v1/webhooks/github`, {
      method: "POST",
      headers: delivery.headers,
      body: delivery.body,
    });
    expect(r.status).toBe(202);
    const [executionId] = ((await r.json()) as { executions: string[] }).executions;
    // Admission wrote the row; the webhook sent nothing to GitHub.
    expect(stack.github.writes.length).toBe(before);
    expect((await outbox()).filter((row) => row.execution_id === executionId)).toEqual([
      expect.objectContaining({
        kind: "check.open",
        state: "pending",
        sends: 0,
        external_ref: null,
      }),
    ]);

    await tick();
    const rows = await outbox();
    const row = rows.find((x) => x.execution_id === executionId)!;
    expect(row).toMatchObject({ kind: "check.open", state: "applied", sends: 1 });
    const written = stack.github.writes.slice(before);
    expect(written).toHaveLength(1);
    expect(written[0]!.body).toMatchObject({ external_id: executionId, head_sha: "a".repeat(40) });

    // Every write the fixture server received is one send of one row; a repeat tick sends nothing more.
    const sends = () => rows.reduce((n, x) => n + x.sends, 0);
    expect(stack.github.writes).toHaveLength(sends());
    expect(
      stack.github.writes.map((w) => (w.body as { external_id: string }).external_id).sort(),
    ).toEqual(
      rows
        .filter((x) => x.sends > 0)
        .map((x) => x.execution_id)
        .sort(),
    );
    // No other write reached GitHub: every non-GET REST call besides token minting is a recorded write.
    expect(
      stack.github.calls.filter(
        (c) =>
          c.host === "api.github.com" &&
          c.method !== "GET" &&
          !/^\/app\/installations\/\d+\/access_tokens$/.test(c.path),
      ),
    ).toHaveLength(stack.github.writes.length);
    const total = stack.github.writes.length;
    await tick();
    expect(stack.github.writes).toHaveLength(total);
  });
});
