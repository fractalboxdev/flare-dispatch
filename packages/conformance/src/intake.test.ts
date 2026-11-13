// Intake's one door on the composed control plane: the control plane Worker under workerd through Miniflare, with its
// D1 database, mameko's admission and the repository a `development` deployment captures. Each trigger path the Worker
// serves without the App reaches admission (a signed webhook, an operator dispatch, a check re-run), and the Worker's
// bundle names the `executions`, dedup-key and `placements` writes of mameko's modules only (specs/intake.md § One door).
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUD,
  OPERATOR,
  PLANE,
  startAccessTeam,
  type AccessTeam,
} from "../../../apps/control-plane/test/support.ts";

const REPO = "acme/app";
const HEAD = "e".repeat(40);
const WEBHOOK_SECRET = "webhook-secret-for-conformance";
const APP_ID = 4242;

const MANIFEST = {
  version: 1,
  runs: [
    {
      recipe: "check",
      triggers: ["pull_request", "dispatch"],
      params: { steps: [{ label: "test", command: "pnpm test", timeoutSec: 600 }] },
    },
  ],
};

const DEV_REPOSITORY = {
  repository: REPO,
  installation: 7,
  default_branch: "main",
  head: HEAD,
  confidentiality: "non-confidential",
  files: {
    ".github/flare-dispatch.json": Buffer.from(JSON.stringify(MANIFEST)).toString("base64"),
  },
};

const WORKER = join(import.meta.dirname, "../../../apps/control-plane/src/worker.ts");

let team: AccessTeam;
let script: string;
let plane: Miniflare;

beforeAll(async () => {
  team = await startAccessTeam();
  const bundle = await build({
    entryPoints: [WORKER],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  script = bundle.outputFiles[0]!.text;
  plane = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: script }],
    compatibilityDate: "2026-05-01",
    d1Databases: { DB: "control-plane" },
    durableObjects: {
      CHANNEL: { className: "ExecutorChannel", useSQLite: true },
      EXECUTION: { className: "ExecutionEngine", useSQLite: true },
      EPOCH_ANCHOR: { className: "EpochAnchor", useSQLite: true },
      MONITOR: { className: "LivenessMonitor", useSQLite: true },
    },
    r2Buckets: ["CACHE"],
    bindings: {
      DEPLOYMENT: "development",
      PLANE_ID: PLANE,
      PUBLIC_ORIGIN: "https://ci.example.com",
      ACCESS_TEAM_DOMAIN: team.teamDomain,
      ACCESS_AUD: AUD,
      OPERATORS: JSON.stringify([OPERATOR]),
      DISPATCHERS: JSON.stringify([OPERATOR]),
      WEBHOOK_SECRET,
      // The App's id without its key: check runs of this App are ours, and no GitHub call is made.
      GITHUB_APP_ID: String(APP_ID),
      GITHUB_APP_SLUG: "flare-dispatch-test",
      FD_DEV_REPOSITORY: JSON.stringify(DEV_REPOSITORY),
    },
  });
  await plane.ready;
  // Any route but `/health` migrates the database first.
  await plane.dispatchFetch("http://x/v1/dispatch/check", { method: "POST" });
}, 120_000);

afterAll(async () => {
  await plane?.dispose();
  await team?.close();
});

const db = async () => (await plane.getD1Database("DB")) as unknown as D1Database;

const rows = async <T = Record<string, unknown>>(sql: string, ...params: unknown[]) =>
  ((await (await db()).prepare(sql).bind(...params).all()).results ?? []) as T[];

/** How many rows each table admission owns holds, and intake's own records. */
const counts = async () => {
  const [row] = await rows<Record<string, number>>(
    `select (select count(*) from executions) as executions,
            (select count(*) from dedup_keys) as dedup_keys,
            (select count(*) from placements) as placements,
            (select count(*) from intake_records) as intake_records`,
  );
  return row!;
};

/** Every execution has the dedup-key row and the placement row admission writes beside it in its one transaction. */
const admittedShape = async (id: string) => ({
  executions: (await rows("select scope_id, run from executions where id = ?", id)).length,
  dedup_keys: (await rows("select sha256 from dedup_keys where execution_id = ?", id)).length,
  placements: (await rows("select state from placements where execution_id = ?", id)).length,
  intake_records: (await rows("select run from intake_records where execution_id = ?", id)).length,
});

const ADMITTED = { executions: 1, dedup_keys: 1, placements: 1, intake_records: 1 };

let deliveries = 0;
const webhook = async (event: string, payload: unknown) => {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
  return plane.dispatchFetch("http://x/v1/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `conf-intake-${++deliveries}`,
      "x-hub-signature-256": signature,
    },
    body,
  }) as unknown as Promise<Response>;
};

const pullRequest = (number: number, head: string) => ({
  action: "synchronize",
  repository: { full_name: REPO },
  installation: { id: 7 },
  pull_request: {
    number,
    draft: false,
    user: { login: "octocat" },
    head: { sha: head, ref: `feature-${number}`, repo: { full_name: REPO } },
    base: { sha: HEAD, ref: "main", repo: { full_name: REPO } },
  },
});

const dispatch = async (sha: string, headers: Record<string, string> = {}, extra: object = {}) =>
  plane.dispatchFetch("http://x/v1/dispatch/check", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": await team.jwt(OPERATOR),
      ...headers,
    },
    body: JSON.stringify({
      repository: REPO,
      sha,
      inputs: {
        repo: `https://github.com/${REPO}`,
        sha,
        ref: "main",
        steps: [{ label: "test", command: "pnpm test" }],
        ...extra,
      },
    }),
  }) as unknown as Promise<Response>;

/** A SQL statement that writes one of the tables admission owns. */
const ADMISSION_WRITE =
  /\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update|delete\s+from)\s+["`]?(executions|dedup_keys|placements)\b/gi;

/** The writes of each admission table in the bundle, by the module esbuild marks each section with. */
const admissionWritesByModule = (bundle: string) => {
  const writes = new Map<string, Set<string>>();
  let module = "<prelude>";
  for (const line of bundle.split("\n")) {
    const marker = /^\/\/ (\S+\.(?:ts|js|mjs))$/.exec(line);
    if (marker !== null) {
      module = marker[1]!;
      continue;
    }
    for (const m of line.matchAll(ADMISSION_WRITE)) {
      const tables = writes.get(module) ?? new Set<string>();
      tables.add(m[1]!.toLowerCase());
      writes.set(module, tables);
    }
  }
  return writes;
};

const isMameko = (module: string) => module.includes("vendor/mameko/");

describe("intake's one door on the composed control plane", () => {
  it(
    "[FD-INT-001] the control plane Worker writes executions, dedup-key and placements rows only in mameko's modules",
    () => {
      const writes = admissionWritesByModule(script);
      // The scan finds admission's own writes, so an empty answer below is not a scan that matched nothing.
      const mameko = new Set([...writes].filter(([m]) => isMameko(m)).flatMap(([, t]) => [...t]));
      expect([...mameko].sort()).toEqual(["dedup_keys", "executions", "placements"]);
      // No FlareDispatch module (intake, its sweep, its re-runs, the follow-on applier, the tick) writes one itself.
      expect([...writes.keys()].filter((m) => !isMameko(m))).toEqual([]);
    },
  );

  it(
    "[FD-INT-001] a webhook, an operator dispatch and a check re-run each reach admission, which writes the execution, its dedup key and its placement",
    async () => {
      const before = await counts();

      const pr = await webhook("pull_request", pullRequest(41, "1".repeat(40)));
      expect(pr.status).toBe(202);
      const { executions } = (await pr.json()) as { executions: string[] };
      expect(executions).toHaveLength(1);
      const fromWebhook = executions[0]!;

      const dispatched = await dispatch("2".repeat(40));
      expect(dispatched.status).toBe(202);
      const fromDispatch = ((await dispatched.json()) as { execution_id: string }).execution_id;

      // The webhook's execution ends failed, so its check run's re-run is the family's next attempt.
      await (await db())
        .prepare("update executions set status = 'failure', finished_at = ? where id = ?")
        .bind(Date.now(), fromWebhook)
        .run();
      const rerun = await webhook("check_run", {
        action: "rerequested",
        repository: { full_name: REPO },
        installation: { id: 7 },
        check_run: {
          id: 99,
          head_sha: "1".repeat(40),
          external_id: fromWebhook,
          name: "flare-dispatch/check",
          app: { id: APP_ID },
        },
      });
      expect(rerun.status).toBe(202);
      const reran = ((await rerun.json()) as { executions: string[] }).executions;
      expect(reran).toHaveLength(1);
      const fromRerun = reran[0]!;
      expect(new Set([fromWebhook, fromDispatch, fromRerun]).size).toBe(3);

      for (const id of [fromWebhook, fromDispatch, fromRerun])
        expect(await admittedShape(id)).toEqual(ADMITTED);
      const after = await counts();
      expect({
        executions: after.executions! - before.executions!,
        dedup_keys: after.dedup_keys! - before.dedup_keys!,
        placements: after.placements! - before.placements!,
        intake_records: after.intake_records! - before.intake_records!,
      }).toEqual({ executions: 3, dedup_keys: 3, placements: 3, intake_records: 3 });
      const [attempt] = await rows<{ attempt: number; family_root: string }>(
        "select attempt, family_root from intake_records where execution_id = ?",
        fromRerun,
      );
      expect(attempt).toEqual({ attempt: 2, family_root: fromWebhook });
    },
    60_000,
  );

  it(
    "[FD-INT-003] a reused Idempotency-Key answers 202 with the existing execution and duplicate: true, and with another body 409 conflict naming it",
    async () => {
      const headers = { "idempotency-key": "conf-build-7" };
      const sha = "3".repeat(40);
      const first = await dispatch(sha, headers);
      expect(first.status).toBe(202);
      const firstBody = (await first.json()) as { execution_id: string; duplicate?: boolean };
      expect(firstBody.duplicate).toBeUndefined();
      const before = await counts();

      const same = await dispatch(sha, headers);
      expect(same.status).toBe(202);
      expect(await same.json()).toMatchObject({
        execution_id: firstBody.execution_id,
        duplicate: true,
      });

      const other = await dispatch(sha, headers, { note: "another body" });
      expect(other.status).toBe(409);
      expect(await other.json()).toMatchObject({
        error: "conflict",
        execution_id: firstBody.execution_id,
      });

      // Neither answer admitted a second execution, and intake kept no record of either.
      expect(await counts()).toEqual(before);
      expect(await admittedShape(firstBody.execution_id)).toEqual(ADMITTED);
    },
    60_000,
  );

  it(
    "[FD-INT-003] a redelivered webhook answers 202 with the existing execution and duplicate: true",
    async () => {
      const payload = pullRequest(42, "4".repeat(40));
      const first = await webhook("pull_request", payload);
      expect(first.status).toBe(202);
      const firstBody = (await first.json()) as { executions: string[]; duplicate?: boolean };
      expect(firstBody.executions).toHaveLength(1);
      expect(firstBody.duplicate).toBeUndefined();
      const before = await counts();

      const again = await webhook("pull_request", payload);
      expect(again.status).toBe(202);
      expect(await again.json()).toEqual({ executions: firstBody.executions, duplicate: true });
      expect(await counts()).toEqual(before);
    },
    60_000,
  );
});
