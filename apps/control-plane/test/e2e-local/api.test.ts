// The HTTP API's wait and the dispatch action's wait loop over the deployed Worker: `GET /v1/executions/:id` with `wait`
// held until the execution is done, and the action, run as the runner runs it, dispatching with the job's OIDC token
// and polling with `wait=60` until the verdict.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connect,
  endStandingClaim,
  hello,
  newDevice,
  OPERATOR,
  registration,
  type Socket,
} from "../support.ts";
import { OIDC_AUDIENCE, PLANE_ID, REPOSITORY, startStack, type Stack } from "./stack.ts";

const ROOT = join(import.meta.dirname, "../../../..");

let stack: Stack;
let device: Socket;

beforeAll(async () => {
  stack = await startStack();
  const { identity, keys } = await newDevice();
  const enrolled = await fetch(`${stack.url}/v1/executors/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await stack.access(OPERATOR)) },
    body: JSON.stringify(registration("e2e-device", identity)),
  });
  expect(enrolled.status).toBe(201);
  device = await connect(stack.mf, "e2e-device", keys, PLANE_ID);
  device.send(hello("e2e-device", PLANE_ID));
  await device.next("session.welcome");
});

afterAll(async () => {
  await stack?.close();
});

const inputs = (sha: string) => ({
  repo: `https://github.com/${REPOSITORY}`,
  sha,
  ref: "refs/heads/main",
  steps: [{ label: "test", command: "pnpm test" }],
});

/** A dispatch by the operator, a member of `dispatchers`. */
const dispatch = async (sha: string) => {
  const r = await fetch(`${stack.url}/v1/dispatch/check`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await stack.access(OPERATOR)) },
    body: JSON.stringify({ repository: REPOSITORY, sha, inputs: inputs(sha) }),
  });
  expect(r.status).toBe(202);
  return ((await r.json()) as { execution_id: string }).execution_id;
};

let claims = 0;

/** The device claims until it holds `id`'s lease, and reports `outcome` for it. */
const settle = async (id: string, outcome: Record<string, unknown>) => {
  while (true) {
    device.send({
      type: "exec.claim",
      id: `c${++claims}`,
      free: { release: 1, required: 1, interactive: 1, batch: 1 },
    });
    const lease = await device.next("exec.lease");
    const ours = lease["execution_id"] === id;
    device.send({
      type: "exec.result",
      id: `r${claims}`,
      execution_id: lease["execution_id"],
      epoch: lease["epoch"],
      result_id: `${String(lease["execution_id"])}:${String(lease["epoch"])}`,
      outcome: ours ? outcome : { status: "cancelled", reason: "superseded" },
      usage: {},
      artifacts: [],
    });
    expect(await device.next("exec.result.ack")).toMatchObject({ status: "accepted" });
    // The heartbeat reports the slot free again.
    await endStandingClaim(device);
    if (ours) return;
  }
};

const view = async (id: string, wait?: number) => {
  const started = Date.now();
  const r = await fetch(
    `${stack.url}/v1/executions/${id}${wait === undefined ? "" : `?wait=${wait}`}`,
    { headers: await stack.access(OPERATOR) },
  );
  expect(r.status).toBe(200);
  return {
    body: (await r.json()) as { status: string; verdict: string | null },
    elapsedMs: Date.now() - started,
  };
};

describe("GET /v1/executions/:id with wait", () => {
  it("[FD-IFC-040] holds the response for the whole wait while the execution is not done", async () => {
    const id = await dispatch("4".repeat(40));
    const immediate = await view(id);
    expect(immediate.body.status).not.toBe("done");
    expect(immediate.elapsedMs).toBeLessThan(1_500);
    const held = await view(id, 3);
    expect(held.body.status).not.toBe("done");
    expect(held.elapsedMs).toBeGreaterThanOrEqual(2_900);
    expect(held.elapsedMs).toBeLessThan(10_000);
    await settle(id, { status: "cancelled", reason: "superseded" });
  });

  it("[FD-IFC-040] answers as soon as the execution is done, before the wait ends", async () => {
    const id = await dispatch("5".repeat(40));
    const held = view(id, 60);
    await new Promise((r) => setTimeout(r, 1_000));
    await settle(id, { status: "failure", reason: "finding: test: exit 1" });
    const { body, elapsedMs } = await held;
    expect(body).toMatchObject({ status: "done", verdict: "failure" });
    expect(elapsedMs).toBeGreaterThanOrEqual(1_000);
    expect(elapsedMs).toBeLessThan(30_000);
  });
});

interface ActionRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly outputs: Readonly<Record<string, string>>;
}

/** The dispatch action as the runner runs it: its entry under node, its inputs as `INPUT_*`, an OIDC-capable job. */
const runAction = (
  sha: string,
  extra: Readonly<Record<string, string>>,
  whilePolling: (id: string) => Promise<void>,
): Promise<ActionRun> => {
  const dir = mkdtempSync(join(tmpdir(), "fd-action-"));
  const outputPath = join(dir, "output");
  const oidc = stack.github.oidcRequest({ repository: REPOSITORY, sha });
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "packages/fd/src/action/main.ts"],
    {
      cwd: ROOT,
      env: {
        PATH: process.env["PATH"],
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_SHA: sha,
        ACTIONS_ID_TOKEN_REQUEST_URL: oidc.url,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: oidc.token,
        INPUT_URL: stack.url,
        INPUT_AUDIENCE: OIDC_AUDIENCE,
        INPUT_RUN: "check",
        INPUT_INPUTS: JSON.stringify(inputs(sha)),
        INPUT_WAIT: "true",
        ...extra,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  return (async () => {
    // The action's first poll, under the job's token, names the execution it dispatched.
    let id: string | undefined;
    for (let i = 0; i < 600 && id === undefined; i++) {
      id = stack.requests
        .filter((r) => r.headers["authorization"] !== undefined)
        .map((r) => /^\/v1\/executions\/([^/?]+)\?wait=/.exec(r.path)?.[1])
        .find((m) => m !== undefined && !seen.has(m));
      if (id === undefined) await new Promise((r) => setTimeout(r, 50));
    }
    if (id === undefined) throw new Error(`the action never polled: ${stdout}`);
    seen.add(id);
    await whilePolling(id);
    const code = await exited;
    let text = "";
    try {
      text = readFileSync(outputPath, "utf8");
    } catch {
      text = "";
    }
    const outputs = Object.fromEntries(
      text
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    return { code, stdout, outputs };
  })();
};

const seen = new Set<string>();

const pollsOf = (id: string) =>
  stack.requests.filter((r) => r.method === "GET" && r.path.startsWith(`/v1/executions/${id}?`));

describe("the dispatch action with wait", () => {
  it("[FD-IFC-059] polls with wait=60 until the execution is done, and passes the step on success", async () => {
    const run = await runAction("6".repeat(40), {}, (id) => settle(id, { status: "success" }));
    expect(run.code).toBe(0);
    expect(run.outputs).toMatchObject({ verdict: "success" });
    const id = run.outputs["execution-id"]!;
    const polls = pollsOf(id);
    expect(polls.length).toBeGreaterThanOrEqual(1);
    for (const poll of polls) {
      expect(poll.path).toBe(`/v1/executions/${id}?wait=60`);
      // The job's OIDC token is the action's only credential.
      expect(poll.headers["authorization"]).toMatch(/^Bearer ey/);
      expect(poll.headers["cf-access-jwt-assertion"]).toBeUndefined();
    }
  });

  it("[FD-IFC-059] fails the step when the verdict is not success", async () => {
    const run = await runAction("7".repeat(40), {}, (id) =>
      settle(id, { status: "failure", reason: "finding: test: exit 1" }),
    );
    expect(run.code).toBe(1);
    expect(run.outputs).toMatchObject({ verdict: "failure" });
    expect(run.stdout).toContain("::error::failure");
    expect(pollsOf(run.outputs["execution-id"]!).every((p) => p.path.endsWith("?wait=60"))).toBe(
      true,
    );
  });

  it("[FD-IFC-059] fails the step once wait-timeout passes with the execution still not done", async () => {
    const started = Date.now();
    const run = await runAction("8".repeat(40), { "INPUT_WAIT-TIMEOUT": "3" }, async () => {});
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("::error::wait_ended");
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});
