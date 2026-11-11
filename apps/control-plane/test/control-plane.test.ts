// The control plane Worker on workerd through Miniflare: the bindings of `wrangler.jsonc`, the router, admission, the
// lease path and the record. The executor here is the test's own signed WebSocket; `pnpm ci:local` proves the real
// device executor.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errorBody } from "@fractalboxdev/flare-dispatch-api/errors";
import { checkLinkToken } from "@fractalboxdev/flare-dispatch-api/link-token";
import { intakeError } from "@fractalboxdev/flare-dispatch-intake";
import { Effect, Schema } from "effect";
import {
  FleetEntry,
  FlareDispatchApi,
  PhaseGateRecords,
  SpendViewBody,
} from "@fractalboxdev/flare-dispatch-api/declaration";
import { mintLinkToken, type LinkPurpose } from "@fractalboxdev/flare-dispatch-api/link-token";
import { ARTIFACT_SCHEMA, logObjectName, stepKey } from "@fractalboxdev/flare-dispatch-cache";
import { HttpApi } from "effect/http-api";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUD,
  connect,
  endStandingClaim,
  hello,
  newDevice,
  OPERATOR,
  PLANE,
  registration,
  startAccessTeam,
  type AccessTeam,
} from "./support.ts";
import { authenticatedOf, refusalOf } from "../src/intake-port.ts";

const SHA = "a".repeat(40);

/** The link key and epoch of every deployment with an Access team. */
const LINK_KEY = "link-key-for-control-plane-tests";
const LINK_EPOCH = 1;

/** The repository the development deployment reads: this one, at one commit. */
const DEV_REPOSITORY = {
  repository: "fractalboxdev/flare-dispatch",
  installation: 1,
  default_branch: "main",
  head: "f".repeat(40),
  confidentiality: "non-confidential",
  files: {
    ".github/flare-dispatch.json": readFileSync(
      join(import.meta.dirname, "../../../.github/flare-dispatch.json"),
    ).toString("base64"),
  },
};

let team: AccessTeam;
let script: string;
let development: Miniflare;
let production: Miniflare;
let unconfigured: Miniflare;

const miniflare = (
  deployment: string,
  access: boolean,
  repository: object = DEV_REPOSITORY,
  extra: Record<string, string> = {},
) =>
  new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: script }],
    compatibilityDate: "2026-05-01",
    d1Databases: { DB: "control-plane" },
    durableObjects: {
      CHANNEL: { className: "ExecutorChannel", useSQLite: true },
      EXECUTION: { className: "ExecutionEngine", useSQLite: true },
      EPOCH_ANCHOR: { className: "EpochAnchor", useSQLite: true },
      MONITOR: { className: "LivenessMonitor", useSQLite: true },
      CACHE_LEDGER: { className: "CacheLedger", useSQLite: true },
    },
    r2Buckets: ["CACHE"],
    bindings: {
      DEPLOYMENT: deployment,
      PLANE_ID: PLANE,
      ...extra,
      ...(access
        ? {
            ACCESS_TEAM_DOMAIN: team.teamDomain,
            ACCESS_AUD: AUD,
            OPERATORS: JSON.stringify([OPERATOR]),
            DISPATCHERS: JSON.stringify([OPERATOR]),
            FD_DEV_REPOSITORY: JSON.stringify(repository),
            LINK_KEY,
            LINK_EPOCH: String(LINK_EPOCH),
          }
        : {}),
    },
  });

beforeAll(async () => {
  team = await startAccessTeam();
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "../src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  script = bundle.outputFiles[0]!.text;
  development = miniflare("development", true);
  production = miniflare("production", true);
  unconfigured = miniflare("production", false);
  await Promise.all([development.ready, production.ready, unconfigured.ready]);
});

afterAll(async () => {
  await Promise.all([development?.dispose(), production?.dispose(), unconfigured?.dispose()]);
  await team?.close();
});

/** `identity` is an Access identity, `null` for none, or `invalid` for a token no key of the team signed. */
const headersFor = async (identity: string | null): Promise<Record<string, string>> =>
  identity === null
    ? {}
    : {
        "cf-access-jwt-assertion":
          identity === "invalid" ? "e30.e30.c2ln" : await team.jwt(identity),
      };

const post = async (
  mf: Miniflare,
  path: string,
  body: unknown,
  identity: string | null = OPERATOR,
) =>
  mf.dispatchFetch(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await headersFor(identity)) },
    body: JSON.stringify(body),
  });

const execution = async (mf: Miniflare, id: string) => {
  const r = await mf.dispatchFetch(`http://x/v1/executions/${id}`, {
    headers: await headersFor(OPERATOR),
  });
  return (await r.json()) as Record<string, unknown>;
};

const dispatchBody = (sha: string) => ({
  repository: "fractalboxdev/flare-dispatch",
  sha: /^[0-9a-f]{40}$/.test(sha) ? sha : SHA,
  inputs: {
    repo: "https://github.com/fractalboxdev/flare-dispatch",
    sha,
    ref: "main",
    steps: [{ label: "test", command: "pnpm test" }],
  },
});

describe("the identity gate", () => {
  it("[FD-IFC-014] answers not_configured with no Access team set", async () => {
    const r = await post(unconfigured, "/v1/dispatch/check", dispatchBody(SHA));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "not_configured" });
  });

  it("[FD-IFC-027] refuses a dispatch with no identity and with a token the team did not sign", async () => {
    expect((await post(development, "/v1/dispatch/nothing", {}, null)).status).toBe(401);
    expect((await post(development, "/v1/dispatch/nothing", {}, "invalid")).status).toBe(401);
  });

  it("[FD-IFC-088] refuses executor registration from an Access identity outside operators", async () => {
    const { identity } = await newDevice();
    const r = await post(
      development,
      "/v1/executors/register",
      registration("stranger", identity),
      "member@example.com",
    );
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "forbidden" });
  });

  it("serves health without identity and names the deployment", async () => {
    const r = await unconfigured.dispatchFetch("http://x/health");
    expect(await r.json()).toEqual({ status: "ok", deployment: "production", plane_id: PLANE });
  });
});

describe("the minute tick", () => {
  it("[FD-INT-050] records the tick and starts the liveness monitor", async () => {
    const worker = await unconfigured.getWorker();
    const at = Date.now();
    await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date(at) });
    const db = await unconfigured.getD1Database("DB");
    await expect
      .poll(
        async () =>
          (await db.prepare("select at from fd_liveness where key = 'tick'").all()).results,
      )
      .toEqual([{ at }]);
  });

  it("[FD-OPS-036] serves the liveness report to an operator", async () => {
    const r = await development.dispatchFetch("http://x/v1/ops/health", {
      headers: await headersFor(OPERATOR),
    });
    expect(r.status).toBe(200);
    expect(Object.keys((await r.json()) as Record<string, unknown>).sort()).toEqual(
      [
        "control_state",
        "executors",
        "installations",
        "oldest_open_execution_age_ms",
        "outbox_depth",
        "probes",
        "tick_age_ms",
      ].sort(),
    );
    const member = await development.dispatchFetch("http://x/v1/ops/health", {
      headers: await headersFor("member@example.com"),
    });
    expect(member.status).toBe(403);
  });
});

describe("the operability routes", () => {
  const ROUTES = [
    "/v1/ops/health",
    "/v1/ops/fleet",
    "/v1/ops/phase-gate?gate=0",
    "/v1/spend",
    "/v1/github/install/new",
    "/v1/github/install/callback?state=s&code=c",
  ];
  const as = async (identity: string | null, path: string, init: RequestInit = {}) =>
    development.dispatchFetch(`http://x${path}`, {
      ...init,
      headers: await headersFor(identity),
    } as never);
  const bodyOf = async (r: { json(): Promise<unknown> }) =>
    (await r.json()) as Record<string, unknown>;

  it("[FD-IFC-001] serves the fleet view, the phase gate's records, the spend view and the install flow as declared endpoints", async () => {
    const declared: string[] = [];
    HttpApi.reflect(FlareDispatchApi, {
      onGroup: () => {},
      onEndpoint: ({ endpoint }) => declared.push(`${endpoint.method} ${endpoint.path}`),
    });
    for (const path of ROUTES) expect(declared).toContain(`GET ${path.split("?")[0]}`);

    const fleet = await as(OPERATOR, "/v1/ops/fleet");
    expect(fleet.status).toBe(200);
    Schema.decodeUnknownSync(Schema.Array(FleetEntry))(await fleet.json());
    expect((await as("member@example.com", "/v1/ops/fleet")).status).toBe(403);

    const records = await as(OPERATOR, "/v1/ops/phase-gate?gate=0");
    expect(records.status).toBe(200);
    expect(Schema.decodeUnknownSync(PhaseGateRecords)(await records.json()).gate).toBe(0);
    const badGate = await as(OPERATOR, "/v1/ops/phase-gate?gate=4");
    expect(badGate.status).toBe(400);
    const badGateBody = await bodyOf(badGate);
    expect(badGateBody).toMatchObject({ error: "invalid_body" });
    expect(String(badGateBody["message"])).toContain("query.gate");

    const spend = await as("member@example.com", "/v1/spend");
    expect(spend.status).toBe(200);
    expect(Schema.decodeUnknownSync(SpendViewBody)(await spend.json()).month).toBe(
      new Date().toISOString().slice(0, 7),
    );

    const start = await as(OPERATOR, "/v1/github/install/new");
    expect(start.status).toBe(200);
    expect(start.headers.get("cache-control")).toBe("no-store");
    const form = await start.text();
    expect(form).toContain("https://github.com/settings/apps/new?state=");
    expect((await as("member@example.com", "/v1/github/install/new")).status).toBe(403);

    // A state the deploy never issued is refused before anything else (FD-OPS-074).
    const unknown = await as(OPERATOR, "/v1/github/install/callback?state=s&code=c");
    expect(unknown.status).toBe(403);
    const unknownBody = await bodyOf(unknown);
    expect(unknownBody).toMatchObject({ error: "forbidden" });
    expect(typeof unknownBody["request_id"]).toBe("string");

    // An issued state is accepted, and this deploy supplies no manifest conversion to exchange the code.
    const state = /state=([^"&]+)/.exec(form)![1]!;
    const issued = await as(OPERATOR, `/v1/github/install/callback?state=${state}&code=c`);
    expect(issued.status).toBe(503);
    expect(await bodyOf(issued)).toMatchObject({ error: "not_configured" });
  });

  it("[FD-IFC-005] [FD-IFC-003] answers another method on each operability route with 405 method_not_allowed, after the identity gate", async () => {
    for (const path of ROUTES)
      for (const method of ["POST", "DELETE"]) {
        const anonymous = await as(null, path, { method });
        expect(anonymous.status, `${method} ${path}`).toBe(401);
        expect(await bodyOf(anonymous)).toMatchObject({ error: "unauthenticated" });
        const refused = await as(OPERATOR, path, { method });
        expect(refused.status, `${method} ${path}`).toBe(405);
        const body = await bodyOf(refused);
        expect(body).toMatchObject({ error: "method_not_allowed" });
        expect(typeof body["request_id"]).toBe("string");
      }
  });
});

describe("the cache, artifact and log routes", () => {
  const EXECUTION = "01LOGSANDARTIFACTS";
  const ARTIFACT = "0123456789abcdef0123456789abcdef";
  const OTHER_ARTIFACT = "fedcba9876543210fedcba9876543210";
  let logFile: string;

  const get = async (mf: Miniflare, path: string, init: RequestInit = {}) =>
    mf.dispatchFetch(`http://x${path}`, init as never);
  const asMember = async (path: string, init: RequestInit = {}) =>
    get(development, path, { ...init, headers: await headersFor("member@example.com") });
  const link = (
    purpose: LinkPurpose,
    objectId: string,
    grant: { expiresAtS?: number; epoch?: number } = {},
  ) =>
    mintLinkToken(LINK_KEY, {
      purpose,
      objectId,
      expiresAtS: grant.expiresAtS ?? Math.floor(Date.now() / 1000) + 600,
      epoch: grant.epoch ?? LINK_EPOCH,
    });
  const errorOf = async (r: { json(): Promise<unknown> }) =>
    (await r.json()) as Record<string, unknown>;

  beforeAll(async () => {
    // Any request past `/health` runs the migrations the rows below need.
    await asMember("/v1/executions");
    const db = await development.getD1Database("DB");
    await db
      .prepare(
        `insert into executions (id, scope_id, run, class, status, enqueued_at)
         values (?, 'fractalboxdev/flare-dispatch', 'check', 'batch', 'success', ?)`,
      )
      .bind(EXECUTION, Date.now())
      .run();
    const name = await logObjectName({
      executionId: EXECUTION,
      epoch: 1,
      journalName: "step:test",
      stream: "stdout",
      start: 0,
      end: 17,
    });
    logFile = name!.slice(`logs/${EXECUTION}/`.length);
    const bucket = await development.getR2Bucket("CACHE");
    await bucket.put(name!, '{"line":"hello"}\n', {
      customMetadata: { executor_id: "mac-logs", executor_kind: "device" },
    });
    for (const sql of ARTIFACT_SCHEMA) await db.prepare(sql).run();
    await db
      .prepare(
        `insert into artifacts (artifact_id, execution_id, epoch, name, size, sha256, content_type,
           producer_executor_id, producer_executor_kind, repo, private, r2_path, browse, created_at, expires_at)
         values (?, ?, 1, 'report.txt', 11, ?, 'text/plain', 'mac-logs', 'device', 'fractalboxdev/flare-dispatch',
           1, ?, 1, ?, ?)`,
      )
      .bind(
        ARTIFACT,
        EXECUTION,
        "0".repeat(64),
        `artifacts/${EXECUTION}/1/report.txt`,
        Date.now(),
        Date.now() + 3_600_000,
      )
      .run();
    await bucket.put(`artifacts/${EXECUTION}/1/report.txt`, "report body");
    await bucket.put(`artifacts/${EXECUTION}/1/report.txt.browse/a/b.txt`, "browse body");
  });

  const logsPath = () => `/v1/executions/${EXECUTION}/logs/${encodeURIComponent(logFile)}`;
  const artifactPath = `/v1/artifacts/${ARTIFACT}`;

  it("[FD-IFC-001] serves every declared log and artifact endpoint through the router's gate", async () => {
    const declared: string[] = [];
    HttpApi.reflect(FlareDispatchApi, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint }) => {
        if (group.identifier === "logs" || group.identifier === "artifacts")
          declared.push(endpoint.path);
      },
    });
    expect(declared.length).toBe(4);
    for (const path of declared) {
      const concrete = path
        .replace(":artifact_id", ARTIFACT)
        .replace(":id", EXECUTION)
        .replace(":file", encodeURIComponent(logFile))
        .replace("/*", "");
      const r = await get(development, concrete);
      expect(r.status, concrete).toBe(401);
      expect(await errorOf(r)).toMatchObject({ error: "unauthenticated" });
    }
    const page = await asMember(`/v1/executions/${EXECUTION}/artifacts`);
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      artifacts: [{ artifact_id: ARTIFACT, name: "report.txt" }],
      cursor: null,
    });
  });

  it("[FD-IFC-017] serves an execution's logs to an Access identity or a link token bound to that execution only", async () => {
    const member = await asMember(logsPath());
    expect(member.status).toBe(200);
    expect(await member.text()).toBe('{"line":"hello"}\n');
    const aggregate = await get(
      development,
      `/v1/executions/${EXECUTION}/logs?format=text&t=${await link("logs", EXECUTION)}`,
    );
    expect(aggregate.status).toBe(200);
    expect(await aggregate.text()).toBe("hello");
    expect(
      (await get(development, `${logsPath()}?t=${await link("logs", EXECUTION)}`)).status,
    ).toBe(200);
    for (const token of [await link("logs", "01OTHER"), await link("artifact", EXECUTION)]) {
      const refused = await get(development, `${logsPath()}?t=${token}`);
      expect(refused.status).toBe(403);
      expect(await errorOf(refused)).toMatchObject({ error: "forbidden" });
    }
  });

  it("[FD-IFC-017] serves an artifact and its browse paths to an Access identity or a link token bound to that artifact only", async () => {
    const member = await asMember(artifactPath);
    expect(member.status).toBe(200);
    expect(await member.text()).toBe("report body");
    const token = await link("artifact", ARTIFACT);
    const linked = await get(development, `${artifactPath}?t=${token}`);
    expect(linked.status).toBe(200);
    expect(await linked.text()).toBe("report body");
    const browse = await get(development, `${artifactPath}/a/b.txt?t=${token}`);
    expect(browse.status).toBe(200);
    expect(await browse.text()).toBe("browse body");
    for (const other of [await link("artifact", OTHER_ARTIFACT), await link("logs", ARTIFACT)]) {
      const refused = await get(development, `${artifactPath}?t=${other}`);
      expect(refused.status).toBe(403);
      expect(await errorOf(refused)).toMatchObject({ error: "forbidden" });
    }
  });

  it("[FD-IFC-020] answers 403 link_expired for an expired log or artifact link", async () => {
    const past = Math.floor(Date.now() / 1000) - 5;
    for (const path of [
      `${logsPath()}?t=${await link("logs", EXECUTION, { expiresAtS: past })}`,
      `${artifactPath}?t=${await link("artifact", ARTIFACT, { expiresAtS: past })}`,
    ]) {
      const r = await get(development, path);
      expect(r.status).toBe(403);
      expect(await errorOf(r)).toMatchObject({ error: "link_expired" });
    }
  });

  it("[FD-IFC-021] answers 403 link_revoked for a link minted below the current link epoch", async () => {
    for (const path of [
      `${logsPath()}?t=${await link("logs", EXECUTION, { epoch: LINK_EPOCH - 1 })}`,
      `${artifactPath}?t=${await link("artifact", ARTIFACT, { epoch: LINK_EPOCH - 1 })}`,
    ]) {
      const r = await get(development, path);
      expect(r.status).toBe(403);
      expect(await errorOf(r)).toMatchObject({ error: "link_revoked" });
    }
  });

  it("[FD-OPS-067] [FD-IFC-019] the execution page's log link opens that execution's logs with no Access identity", async () => {
    const page = await asMember(`/executions/${EXECUTION}`);
    expect(page.status).toBe(200);
    const href = /<a href="([^"]+)">check<\/a>/
      .exec(await page.text())?.[1]
      ?.replace(/&amp;/g, "&");
    expect(href).toBeDefined();
    const url = new URL(href!);
    expect(url.pathname).toBe(`/v1/executions/${EXECUTION}/logs`);
    const token = url.searchParams.get("t")!;
    const expiry = Number(token.split(".")[0]) - Math.floor(Date.now() / 1000);
    expect(expiry).toBeGreaterThan(3_600 - 10);
    expect(expiry).toBeLessThanOrEqual(3_600);
    const opened = await get(
      development,
      `${url.pathname}?format=text&t=${encodeURIComponent(token)}`,
    );
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe("hello");
    const other = await get(
      development,
      `/v1/executions/01OTHER/logs?t=${encodeURIComponent(token)}`,
    );
    expect(other.status).toBe(403);
  });

  it("[FD-IFC-013] answers 401 with neither identity nor link, and redirects a browser to the Access login", async () => {
    for (const path of [logsPath(), artifactPath]) {
      const r = await get(development, path);
      expect(r.status).toBe(401);
      expect(await errorOf(r)).toMatchObject({ error: "unauthenticated" });
      const browser = await get(development, path, {
        headers: { accept: "text/html" },
        redirect: "manual",
      });
      expect(browser.status).toBe(302);
      expect(browser.headers.get("location")).toMatch(
        new RegExp(`^${team.teamDomain}/cdn-cgi/access/login/`),
      );
    }
  });

  it("[FD-IFC-014] answers 503 not_configured on the log and artifact routes with no Access team set", async () => {
    for (const path of [
      logsPath(),
      `/v1/executions/${EXECUTION}/logs`,
      artifactPath,
      `${artifactPath}?t=${await link("artifact", ARTIFACT)}`,
    ]) {
      const r = await get(unconfigured, path);
      expect(r.status, path).toBe(503);
      const body = await errorOf(r);
      expect(body).toMatchObject({ error: "not_configured" });
      expect(typeof body["request_id"]).toBe("string");
    }
  });

  it("[FD-IFC-003] runs the identity gate before the method check on the log and artifact routes", async () => {
    for (const path of [logsPath(), artifactPath]) {
      expect((await get(development, path, { method: "DELETE" })).status).toBe(401);
      const r = await asMember(path, { method: "DELETE" });
      expect(r.status).toBe(405);
      expect(await errorOf(r)).toMatchObject({ error: "method_not_allowed" });
    }
  });

  it("[FD-IFC-009] answers an unknown execution, log file or artifact with the error model's JSON", async () => {
    for (const [path, code] of [
      ["/v1/executions/01NOSUCH/logs", "execution_not_found"],
      [`/v1/executions/${EXECUTION}/logs/${encodeURIComponent("1/nothing.ndjson")}`, "not_found"],
      [`/v1/artifacts/${OTHER_ARTIFACT}`, "not_found"],
      [`${artifactPath}/a/missing.txt`, "not_found"],
    ] as const) {
      const r = await asMember(path);
      expect(r.status, path).toBe(404);
      expect(r.headers.get("content-type")).toContain("application/json");
      const body = await errorOf(r);
      expect(body).toMatchObject({ error: code });
      expect(typeof body["message"]).toBe("string");
      expect(typeof body["request_id"]).toBe("string");
    }
  });

  it("[FD-CACHE-051] refuses a compile-cache request without a signing secret", async () => {
    const r = await development.dispatchFetch("http://x/v1/compile-cache/acme/widgets/ns/key");
    expect(r.status).toBe(503);
  });
});

describe("the failure summary", () => {
  const FAILED = "01FAILEDWITHLOGS";
  const SILENT = "01FAILEDNOLOGS";
  const ACCEPTED = "01FAILEDACCEPTEDEPOCH";
  const RECLAIMED = "01FAILEDRECLAIMED";
  const LONG_RUN = `check-${"r".repeat(3000)}`;
  const REASON = `exit 1: ${"why ".repeat(1000)}`;

  const summaryOf = async (id: string) => {
    const r = await development.dispatchFetch(`http://x/v1/executions/${id}/failure-summary`, {
      headers: await headersFor("member@example.com"),
    });
    return { status: r.status, text: await r.text() };
  };

  /** One NDJSON segment of a step, written after the previous one so step order follows upload order. */
  const segment = async (
    epoch: number,
    step: string,
    start: number,
    lines: readonly string[],
    executionId: string = FAILED,
  ) => {
    const body = lines.map((line) => JSON.stringify({ line })).join("\n");
    const name = await logObjectName({
      executionId,
      epoch,
      journalName: step,
      stream: "stdout",
      start,
      end: start + body.length,
    });
    await (await development.getR2Bucket("CACHE")).put(name!, body);
    await new Promise((resolve) => setTimeout(resolve, 5));
  };

  beforeAll(async () => {
    await development.dispatchFetch("http://x/v1/executions", {
      headers: await headersFor("member@example.com"),
    });
    const db = await development.getD1Database("DB");
    for (const [id, run] of [
      [FAILED, "check"],
      [SILENT, LONG_RUN],
      [ACCEPTED, "check"],
      [RECLAIMED, "check"],
    ] as const)
      await db
        .prepare(
          `insert into executions (id, scope_id, run, class, status, reason, enqueued_at)
           values (?, 'fractalboxdev/flare-dispatch', ?, 'batch', 'failure', ?, ?)`,
        )
        .bind(id, run, REASON, Date.now())
        .run();
    await segment(1, "step:test", 0, ["epoch-one attempt"]);
    await segment(2, "step:install", 0, ["install-output"]);
    await segment(
      2,
      "step:test",
      0,
      Array.from({ length: 300 }, (_, i) => `early ${i} ${"a".repeat(80)}`),
    );
    await segment(2, "step:test", 30_000, [
      ...Array.from({ length: 300 }, () => "b".repeat(80)),
      "LAST-LINE",
    ]);
    // ACCEPTED's record names epoch 2 and accepts epoch 1; RECLAIMED's names epoch 2, which wrote no log.
    for (const [id, epoch, accepted] of [
      [ACCEPTED, 2, 1],
      [RECLAIMED, 2, null],
    ] as const)
      await db
        .prepare(
          `insert into placements (execution_id, state, epoch, accepted_epoch) values (?, 'failed', ?, ?)`,
        )
        .bind(id, epoch, accepted)
        .run();
    await segment(1, "step:test", 0, ["epoch-one attempt"], ACCEPTED);
    await segment(2, "step:test", 0, ["epoch-two test"], ACCEPTED);
    await segment(2, "step:lint", 0, ["epoch-two lint"], ACCEPTED);
    await segment(1, "step:test", 0, ["reclaimed attempt"], RECLAIMED);
  });

  it("[FD-IFC-042] serves the failing step's log tail and the reason, bounded to the incident/v1 caps and 16 KiB", async () => {
    const { status, text } = await summaryOf(FAILED);
    expect(status, text).toBe(200);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(16_384);
    const pack = JSON.parse(text) as {
      incidentId: string;
      repo: string;
      ciFailures: { kind: string; name: string; conclusion: string; logTail: string }[];
    };
    expect(pack).toMatchObject({ incidentId: FAILED, repo: "fractalboxdev/flare-dispatch" });
    const [failure] = pack.ciFailures;
    expect(failure!.kind).toBe("run-step");
    // The failing step is the last one at the highest epoch, named by the run and its step key.
    expect(failure!.name).toBe(`check/${await stepKey("step:test")}`);
    expect(failure!.conclusion.length).toBeLessThanOrEqual(200);
    expect(REASON.startsWith(failure!.conclusion)).toBe(true);
    expect(failure!.logTail.length).toBe(4000);
    expect(failure!.logTail.endsWith("LAST-LINE")).toBe(true);
    for (const other of ["epoch-one", "install-output", "early"])
      expect(failure!.logTail).not.toContain(other);
  });

  it("[FD-IFC-042] names the run alone, cut to the 2000-character text cap, for a failed execution with no step log", async () => {
    const { status, text } = await summaryOf(SILENT);
    expect(status, text).toBe(200);
    const pack = JSON.parse(text) as { ciFailures: Record<string, unknown>[] };
    expect(pack.ciFailures).toHaveLength(1);
    expect(pack.ciFailures[0]!["name"]).toBe(LONG_RUN.slice(0, 2000));
    expect(pack.ciFailures[0]!["conclusion"]).toBe(REASON.slice(0, 200));
    expect(pack.ciFailures[0]).not.toHaveProperty("logTail");
  });

  it("[FD-IFC-042] takes the failing step at the record's accepted epoch over its placement epoch and higher epochs with logs", async () => {
    const { status, text } = await summaryOf(ACCEPTED);
    expect(status, text).toBe(200);
    const pack = JSON.parse(text) as { ciFailures: Record<string, unknown>[] };
    expect(pack.ciFailures[0]).toMatchObject({
      name: `check/${await stepKey("step:test")}`,
      logTail: "epoch-one attempt",
    });
  });

  it("[FD-IFC-042] names the run alone when the epoch the record names wrote no log, over a reclaimed epoch's logs", async () => {
    const { status, text } = await summaryOf(RECLAIMED);
    expect(status, text).toBe(200);
    const pack = JSON.parse(text) as { ciFailures: Record<string, unknown>[] };
    expect(pack.ciFailures[0]!["name"]).toBe("check");
    expect(pack.ciFailures[0]).not.toHaveProperty("logTail");
  });
});

describe("a production deployment", () => {
  it("MAMEKO-ISO-001 leaves a host execution out of the catalogue", async () => {
    const r = await post(production, "/v1/dispatch/check", dispatchBody(SHA));
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "run_not_found" });
  });

  it("[FD-IFC-087] at phase 0 refuses a key that claims a hardware store nothing attests, and writes no executor row", async () => {
    const { identity } = await newDevice();
    const claimed = { ...identity, key_store: "secure-enclave" };
    const r = await post(production, "/v1/executors/register", registration("mac", claimed));
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string; message: string };
    expect(body.error).toBe("registration_refused");
    expect(body.message).toContain("key-store");
    const db = await production.getD1Database("DB");
    expect((await db.prepare("select * from executors").all()).results).toEqual([]);
  });
});

describe("a development deployment", () => {
  it("[FD-IFC-028] answers run_not_found for a run outside the catalogue", async () => {
    const r = await post(development, "/v1/dispatch/nothing", dispatchBody(SHA));
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "run_not_found" });
  });

  it("[FD-IFC-028] answers run_not_found for a run and label the repository's manifest does not list", async () => {
    const r = await post(development, "/v1/dispatch/check", {
      ...dispatchBody(SHA),
      label: "nightly",
    });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "run_not_found" });
  });

  it("[FD-INT-022] refuses a webhook on a deployment that holds no webhook secret", async () => {
    const r = await development.dispatchFetch("http://x/v1/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "ping" },
      body: "{}",
    });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "webhook_unconfigured" });
  });

  it("[FD-IFC-029] answers invalid_inputs for a body that fails the run's schema", async () => {
    const r = await post(development, "/v1/dispatch/check", dispatchBody("not-a-sha"));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "invalid_inputs" });
  });

  it("[FD-IFC-086] enrolls a software key, and an upgrade with another key is refused", async () => {
    const { identity } = await newDevice();
    const stranger = await newDevice();
    const r = await post(development, "/v1/executors/register", registration("mac-1", identity));
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ executor_id: "mac-1", posture_tier: "unmanaged" });
    await expect(connect(development, "mac-1", stranger.keys)).rejects.toThrow("no socket: 403");
  });

  it("carries one execution from dispatch through the lease to the record, and a duplicate reuses it", async () => {
    const device = await newDevice();
    await post(development, "/v1/executors/register", registration("mac-2", device.identity));
    const sha = "b".repeat(40);
    const admitted = await post(development, "/v1/dispatch/check", dispatchBody(sha));
    expect(admitted.status).toBe(202);
    const { execution_id: id, class: className } = (await admitted.json()) as {
      execution_id: string;
      class: string;
    };
    expect(className).toBe("batch");
    expect(await execution(development, id)).toMatchObject({ status: "queued", verdict: null });
    const repeat = await post(development, "/v1/dispatch/check", dispatchBody(sha));
    expect(await repeat.json()).toMatchObject({ execution_id: id, duplicate: true });

    const socket = await connect(development, "mac-2", device.keys);
    socket.send(hello("mac-2"));
    await socket.next("session.welcome");
    socket.send({ type: "exec.claim", id: "c1", free: { batch: 1 } });
    const lease = await socket.next("exec.lease");
    expect(lease).toMatchObject({
      execution_id: id,
      run: "check",
      run_version: "2.0.0",
      class: "batch",
      scope_id: "fractalboxdev/flare-dispatch",
      inputs: dispatchBody(sha).inputs,
      credentials: {},
    });
    // The lease carries the deadline admission wrote on the execution and placement rows, and the gate run's input
    // carries it too (FD-GATE-007).
    const [deadlines] = (
      await (
        await development.getD1Database("DB")
      )
        .prepare(
          `select e.deadline_at as execution, p.deadline_at as placement from executions e
           join placements p on p.execution_id = e.id where e.id = ?`,
        )
        .bind(id)
        .all()
    ).results as { execution: number; placement: number }[];
    expect(deadlines!.placement).toBe(deadlines!.execution);
    expect(lease["deadline_at"]).toBe(deadlines!.execution);
    expect((lease["inputs"] as { deadlineAt: unknown }).deadlineAt).toBe(deadlines!.execution);
    const epoch = lease["epoch"];
    // A device restores the device and content tiers and writes none for a dispatch (FD-CACHE-016).
    expect(lease["upload_grant"]).toMatchObject({
      cache_prefix: null,
      artifact_prefix: `artifacts/${id}/${String(epoch)}/`,
      log_prefix: `logs/${id}/${String(epoch)}/`,
      compile_cache: null,
    });
    expect((lease["cache_namespaces"] as { write: unknown }).write).toBeNull();
    await expect.poll(() => execution(development, id)).toMatchObject({ status: "running" });
    socket.send({
      type: "exec.result",
      id: "r1",
      execution_id: id,
      epoch,
      result_id: `${id}:${String(epoch)}`,
      outcome: { status: "failure", reason: "finding: test: exit 1" },
      usage: {},
      artifacts: [],
    });
    expect(await socket.next("exec.result.ack")).toMatchObject({ status: "accepted" });
    await expect
      .poll(() => execution(development, id), { timeout: 20_000 })
      .toMatchObject({
        execution_id: id,
        run: "check",
        class: "batch",
        status: "done",
        verdict: "failure",
        reason: "finding: test: exit 1",
        epoch,
        accepted_epoch: epoch,
        executor_id: "mac-2",
      });
    await endStandingClaim(socket);
  });

  it("wakes a connected device's standing claim when a dispatch is admitted", async () => {
    const device = await newDevice();
    await post(development, "/v1/executors/register", registration("mac-3", device.identity));
    const socket = await connect(development, "mac-3", device.keys);
    socket.send(hello("mac-3"));
    await socket.next("session.welcome");
    socket.send({ type: "exec.claim", id: "c1", free: { batch: 1 } });
    await socket.next("exec.idle");
    const admitted = await post(development, "/v1/dispatch/check", dispatchBody("c".repeat(40)));
    const { execution_id: id } = (await admitted.json()) as { execution_id: string };
    expect(await socket.next("exec.lease")).toMatchObject({ execution_id: id });
    await endStandingClaim(socket);
  });

  it.each([
    [
      "skipped",
      { status: "skipped", reason: "draft-pr" },
      "skipped",
      "not-applicable: draft-pr",
      "d",
    ],
    ["cancelled", { status: "cancelled", reason: "superseded" }, "cancelled", "superseded", "e"],
  ])(
    "MAMEKO-RUN-046 records a run's %s outcome as itself",
    async (name, outcome, verdict, reason, shaChar) => {
      const device = await newDevice();
      const executor = `mac-${name}`;
      await post(development, "/v1/executors/register", registration(executor, device.identity));
      const admitted = await post(
        development,
        "/v1/dispatch/check",
        dispatchBody(shaChar.repeat(40)),
      );
      const { execution_id: id } = (await admitted.json()) as { execution_id: string };
      const socket = await connect(development, executor, device.keys);
      socket.send(hello(executor));
      await socket.next("session.welcome");
      socket.send({ type: "exec.claim", id: "c1", free: { batch: 1 } });
      const lease = await socket.next("exec.lease");
      socket.send({
        type: "exec.result",
        id: "r1",
        execution_id: id,
        epoch: lease["epoch"],
        result_id: `${id}:${String(lease["epoch"])}`,
        outcome,
        usage: {},
        artifacts: [],
      });
      expect(await socket.next("exec.result.ack")).toMatchObject({ status: "accepted" });
      await expect
        .poll(() => execution(development, id), { timeout: 20_000 })
        .toMatchObject({ status: "done", verdict, reason });
      await endStandingClaim(socket);
    },
  );
});

/** A manifest that lists `worker-deploy` and `sandbox-image` for dispatch, beside the repository's own. */
const PLACEMENT_REPOSITORY = {
  ...DEV_REPOSITORY,
  files: {
    ".github/flare-dispatch.json": Buffer.from(
      JSON.stringify({
        version: 1,
        runs: [
          {
            recipe: "worker-deploy",
            triggers: ["dispatch"],
            params: { command: "pnpm deploy" },
          },
          {
            recipe: "sandbox-image",
            triggers: ["dispatch"],
            params: {
              images: [
                { name: "sandbox", dockerfile: "infra/Dockerfile.sandbox", smoke: ["true"] },
              ],
            },
          },
        ],
      }),
    ).toString("base64"),
  },
};

describe("placement of cloud-pinned runs through admission and the lease path", () => {
  let placement: Miniflare;
  beforeAll(async () => {
    placement = miniflare("development", true, PLACEMENT_REPOSITORY, {
      GATE_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
    });
    await placement.ready;
  });
  afterAll(async () => {
    await placement?.dispose();
  });

  const context = (sha: string) => ({
    repo: "https://github.com/fractalboxdev/flare-dispatch",
    sha,
    ref: "refs/heads/main",
  });
  const requests = [
    {
      run: "worker-deploy",
      inputs: {
        ...context("d".repeat(40)),
        scope: "fractalboxdev/flare-dispatch",
        branch: "main",
        entry: { command: "pnpm deploy" },
      },
    },
    {
      run: "sandbox-image",
      inputs: {
        ...context("e".repeat(40)),
        entry: {
          images: [{ name: "sandbox", dockerfile: "infra/Dockerfile.sandbox", smoke: ["true"] }],
        },
        publish: true,
        executorLabels: [],
      },
    },
  ];

  it.each(requests)(
    "[FD-GATE-061] [FD-GATE-080] a $run request is admitted eligible for cloudflare alone, and a device never takes its lease",
    async ({ run, inputs }) => {
      const device = await newDevice();
      const executorId = `mac-${run}`;
      // A device whose sandbox meets any isolation, so the eligible kinds alone keep it out.
      await post(
        placement,
        "/v1/executors/register",
        registration(executorId, device.identity, ["isolation:vm"]),
      );
      const admitted = await post(placement, `/v1/dispatch/${run}`, {
        repository: "fractalboxdev/flare-dispatch",
        sha: inputs.sha,
        inputs,
      });
      expect(admitted.status).toBe(202);
      const { execution_id: id, class: className } = (await admitted.json()) as {
        execution_id: string;
        class: string;
      };
      const db = await placement.getD1Database("DB");
      const row = async () =>
        (
          await db
            .prepare("select state, eligible_kinds from placements where execution_id = ?")
            .bind(id)
            .all()
        ).results;
      expect(await row()).toEqual([{ state: "queued", eligible_kinds: '["cloudflare"]' }]);

      const socket = await connect(placement, executorId, device.keys);
      socket.send(hello(executorId));
      await socket.next("session.welcome");
      socket.send({ type: "exec.claim", id: "c1", free: { [className]: 1 } });
      await socket.next("exec.idle");
      expect(await row()).toEqual([{ state: "queued", eligible_kinds: '["cloudflare"]' }]);
      await endStandingClaim(socket);

      // The eligible kinds alone keep the device out: with them cleared, the same claim takes the lease.
      await db
        .prepare("update placements set eligible_kinds = null where execution_id = ?")
        .bind(id)
        .run();
      socket.send({ type: "exec.claim", id: "c2", free: { [className]: 1 } });
      expect(await socket.next("exec.lease")).toMatchObject({ execution_id: id, run });
    },
  );
});

describe("the declared dispatch route", () => {
  let linked: Miniflare;
  beforeAll(async () => {
    linked = miniflare("development", true, DEV_REPOSITORY);
    await linked.ready;
  });
  afterAll(async () => {
    await linked?.dispose();
  });

  it("[FD-IFC-001] answers a body the declaration's schema rejects with 400, naming the failing path", async () => {
    const r = await post(linked, "/v1/dispatch/check", {
      ...dispatchBody("d".repeat(40)),
      signals: [{ source: "lint", title: "unused import" }],
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_signals");
    expect(body.message).toMatch(/^signals\.0\.detail/);
    const db = await linked.getD1Database("DB");
    expect((await db.prepare("select id from executions").all()).results).toEqual([]);
  });

  it("[FD-IFC-001] [FD-IFC-035] answers an admitted dispatch with details_url and logs_url signed by a link token for the execution", async () => {
    const r = await post(linked, "/v1/dispatch/check", dispatchBody("e".repeat(40)));
    expect(r.status).toBe(202);
    const body = (await r.json()) as Record<string, string>;
    const id = body["execution_id"]!;
    const details = new URL(body["details_url"]!);
    const logs = new URL(body["logs_url"]!);
    expect(details.pathname).toBe(`/executions/${id}`);
    expect(logs.pathname).toBe(`/v1/executions/${id}/logs`);
    const token = logs.searchParams.get("t")!;
    expect(details.searchParams.get("t")).toBe(token);
    const check = (objectId: string) =>
      checkLinkToken(LINK_KEY, token, {
        purpose: "logs",
        objectId,
        nowS: Math.floor(Date.now() / 1000),
        currentEpoch: LINK_EPOCH,
      });
    expect(await check(id)).toEqual({ _tag: "Granted" });
    expect(await check("01OTHER")).toEqual({ _tag: "Invalid" });
  });
});

describe("the intake port", () => {
  it("[FD-IFC-009] answers an intake refusal with its code from the error-model table, and any other code as internal", async () => {
    const conflict = await Effect.runPromise(
      refusalOf(intakeError(409, "conflict", "another body", "01EXISTING")),
    );
    expect(errorBody(conflict, "r1")).toEqual({
      error: "conflict",
      message: "another body",
      request_id: "r1",
      execution_id: "01EXISTING",
    });
    const outside = await Effect.runPromise(refusalOf(intakeError(403, "sha_mismatch", "x")));
    expect(errorBody(outside, "r2")).toEqual({
      error: "internal",
      message: "internal error",
      request_id: "r2",
    });
  });

  it("[FD-IFC-025] hands intake an Actions caller with the token's ref, workflow ref and vouched commit", () => {
    const authenticated = authenticatedOf({
      trigger: "dispatch",
      run: "check",
      repository: "acme/app",
      ref: "refs/heads/main",
      sha: "a".repeat(40),
      workflowRef: "acme/app/.github/workflows/ci.yml@refs/heads/main",
      vouchedSha: "b".repeat(40),
      label: undefined,
      inputs: {},
      class: undefined,
      signals: undefined,
      caller: "actions:acme/app:acme/app/.github/workflows/ci.yml@refs/heads/main",
      idempotency: { key: "k", canonicalBody: '{"repository":"acme/app"}' },
    });
    expect(authenticated).toMatchObject({
      caller: {
        kind: "actions-oidc",
        id: "actions:acme/app:acme/app/.github/workflows/ci.yml@refs/heads/main",
        workflowRef: "acme/app/.github/workflows/ci.yml@refs/heads/main",
        ref: "refs/heads/main",
      },
      vouchedSha: "b".repeat(40),
      label: null,
      idempotency: { key: "k", body: { repository: "acme/app" } },
    });
  });
});
