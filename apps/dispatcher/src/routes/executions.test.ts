// Tests for the executions read routes (`GET /v1/executions` list +
// `GET /v1/executions/:id` detail), driven through `handleRequest`. These
// routes consume the ExecutionsRead / LogToken ports; the suite exercises the
// admin-bearer gate (list), the capability-token gate (detail), and the shape
// of the responses over the in-memory D1/R2 fakes.

import { describe, expect, it } from "vitest";

import { handleRequest } from "../router";
import { signLogToken } from "../log-token";
import {
  makeFakeD1,
  makeFakeEnv,
  makeFakeR2,
  makeFakeWorkflow,
} from "../test-helpers";

const SECRET = "exec-secret-please-rotate";
const ORIGIN = "https://dispatcher.example";
const EXEC = "offload-test:owner_repo:abc123def456";
const ADMIN = "admin-bearer-please-rotate";

const execRow = (over: Record<string, unknown> = {}) => ({
  id: EXEC,
  run: "offload-test",
  repo: "owner/repo",
  ref: "refs/heads/main",
  sha: "abc123def456789",
  status: "success",
  started_at: 1000,
  completed_at: 2000,
  parent_execution_id: null,
  input_json: JSON.stringify({ secret: "should-not-leak" }),
  summary_json: JSON.stringify({ ok: true }),
  check_run_id: null,
  ...over,
});

const fixture = (opts: { adminToken?: string } = {}) => {
  const storage = makeFakeR2();
  const metadata = makeFakeD1({
    executions: [execRow()],
    steps: [
      {
        id: `${EXEC}:checkout:1`,
        execution_id: EXEC,
        name: "checkout",
        status: "success",
        started_at: 1000,
        completed_at: 1100,
        exit_code: 0,
        log_uri: null,
        attempt: 1,
      },
    ],
  });
  storage.put(`logs/${EXEC}/exec.ndjson`, "{}\n", "application/x-ndjson");
  storage.put(`artifacts/${EXEC}/pr-review.diff`, "diff\n", "text/plain");
  const env = makeFakeEnv({
    hmacSecret: "h",
    workflow: makeFakeWorkflow(),
    storage,
    metadata,
    logLinkSecret: SECRET,
    publicOrigin: ORIGIN,
    ...(opts.adminToken !== undefined ? { adminToken: opts.adminToken } : {}),
  });
  return { env };
};

const get = (
  env: ReturnType<typeof fixture>["env"],
  path: string,
  headers?: Record<string, string>,
) => handleRequest(new Request(`${ORIGIN}${path}`, { headers }), env);

describe("GET /v1/executions — listing", () => {
  it("503s when ADMIN_TOKEN is unset", async () => {
    const { env } = fixture();
    const res = await get(env, "/v1/executions");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe(
      "admin_not_configured",
    );
  });

  it("401s a missing / wrong bearer", async () => {
    const { env } = fixture({ adminToken: ADMIN });
    expect((await get(env, "/v1/executions")).status).toBe(401);
    const res = await get(env, "/v1/executions", {
      Authorization: "Bearer nope",
    });
    expect(res.status).toBe(401);
  });

  it("returns the executions with tokened logsUrl when authorized", async () => {
    const { env } = fixture({ adminToken: ADMIN });
    const res = await get(env, "/v1/executions", {
      Authorization: `Bearer ${ADMIN}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      executions: { id: string; logsUrl?: string }[];
      nextBefore: number | null;
    };
    expect(body.executions).toHaveLength(1);
    expect(body.executions[0]!.id).toBe(EXEC);
    expect(body.executions[0]!.logsUrl).toContain("/logs/");
    expect(body.nextBefore).toBeNull();
  });
});

describe("GET /v1/executions/:id — detail", () => {
  it("403s without a valid capability token", async () => {
    const { env } = fixture();
    const res = await get(env, `/v1/executions/${encodeURIComponent(EXEC)}`);
    expect(res.status).toBe(403);
  });

  it("returns execution + steps + logs + artifacts with a valid token", async () => {
    const { env } = fixture();
    const token = await signLogToken(SECRET, EXEC);
    const res = await get(
      env,
      `/v1/executions/${encodeURIComponent(EXEC)}?t=${token}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      execution: { id: string; logsUrl?: string };
      steps: { name: string }[];
      logs: { file: string; url: string }[];
      artifacts: { name: string }[];
      summary?: unknown;
    };
    expect(body.execution.id).toBe(EXEC);
    expect(body.steps.map((s) => s.name)).toContain("checkout");
    expect(body.logs.map((l) => l.file)).toContain("exec.ndjson");
    // The per-file URL carries the same capability token.
    expect(body.logs[0]!.url).toContain(`?t=${token}`);
    expect(body.artifacts.map((a) => a.name)).toContain("pr-review.diff");
    expect(body.summary).toEqual({ ok: true });
  });

  it("404s a missing execution presented with a valid token for that id", async () => {
    const { env } = fixture();
    const missing = "offload-test:owner_repo:missing000000";
    const token = await signLogToken(SECRET, missing);
    const res = await get(
      env,
      `/v1/executions/${encodeURIComponent(missing)}?t=${token}`,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "execution_not_found",
    );
  });
});
