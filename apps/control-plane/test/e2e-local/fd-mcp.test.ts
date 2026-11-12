// `fd mcp` as an agent on the developer's device runs it: the executable over stdio, pointed at the deployed Worker with
// the developer's Access token in the OS credential store, and at a local scheduler socket. The pinned mameko release
// ships no socket server for the local scheduler, so the socket here is the test's own listener, which records every
// connection; a call routed to the HTTP API shows in the front's record of requests instead.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATOR } from "../support.ts";
import {
  developerEnv,
  dispatcherMcp,
  forgetAccessToken,
  REPOSITORY,
  startFdMcp,
  startStack,
  storeAccessToken,
  type FdMcp,
  type Stack,
} from "./stack.ts";

let stack: Stack;
let token: string;
let home: string;
let scheduler: Server;
let mcp: FdMcp;
/** Connections the local scheduler socket accepted. */
let connections = 0;

beforeAll(async () => {
  stack = await startStack();
  token = await stack.team.jwt(OPERATOR);
  await storeAccessToken(stack.url, token);
  home = mkdtempSync(join(tmpdir(), "fd-mcp-"));
  const socketPath = join(home, "scheduler.sock");
  scheduler = createServer((socket: Socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => scheduler.listen(socketPath, resolve));
  mcp = await startFdMcp(developerEnv(stack, home, { FD_SCHEDULER_SOCKET: socketPath }));
});

afterAll(async () => {
  await mcp?.close();
  await new Promise<void>((resolve) =>
    scheduler === undefined ? resolve() : scheduler.close(() => resolve()),
  );
  if (stack !== undefined) await forgetAccessToken(stack.url);
  await stack?.close();
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
});

/** The tools the deployed dispatcher serves at `/mcp`, as an agent lists them over Streamable HTTP. */
const dispatcherTools = async (): Promise<string[]> =>
  ((await dispatcherMcp(stack, OPERATOR, "tools/list")) as { tools: { name: string }[] }).tools.map(
    (t) => t.name,
  );

/** What one call sent: the connections the scheduler socket accepted and the requests the Worker received. */
const routed = async <A>(thunk: () => Promise<A>) => {
  const socketBefore = connections;
  const httpBefore = stack.requests.length;
  const answer = await thunk();
  return {
    answer,
    socket: connections - socketBefore,
    http: stack.requests.slice(httpBefore),
  };
};

const sha = "7".repeat(40);
const inputs = {
  repo: `https://github.com/${REPOSITORY}`,
  sha,
  ref: "refs/heads/main",
  steps: [{ label: "test", command: "pnpm test" }],
};

describe("fd mcp over stdio against the deployed Worker", () => {
  it("[FD-IFC-075] serves the union of the dispatcher's tools and the local scheduler's", async () => {
    const listed = (await mcp.request("tools/list")) as { tools: { name: string }[] };
    const dispatcher = await dispatcherTools();
    expect(dispatcher.length).toBeGreaterThan(0);
    expect(listed.tools.map((t) => t.name).sort()).toEqual(
      [...new Set([...dispatcher, "rehearse", "lease_status"])].sort(),
    );
  });

  it("[FD-IFC-075] sends rehearse, lease_status and every local- id to the local scheduler socket, never to the HTTP API", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["rehearse", { run: "check" }],
      ["lease_status", {}],
      ["get_verdict", { execution_id: "local-01JE2EREHEARSAL0000000000" }],
      ["get_failure_summary", { execution_id: "local-01JE2EREHEARSAL0000000000" }],
      ["cancel", { execution_id: "local-01JE2EREHEARSAL0000000000" }],
    ];
    for (const [tool, args] of calls) {
      const sent = await routed(() => mcp.call(tool, args));
      expect({ tool, socket: sent.socket, http: sent.http }).toEqual({ tool, socket: 1, http: [] });
      // The socket accepted the connection; the pinned release defines no wire format for its operations, so the tool
      // answers that as a tool error with its code (FD-IFC-080) rather than guessing one.
      expect(sent.answer).toMatchObject({ isError: true, value: { error: "scheduler_protocol" } });
    }
  });

  it("[FD-IFC-075] sends dispatch and get_verdict to the HTTP API with the developer's own Access token", async () => {
    const dispatched = await routed(() =>
      mcp.call("dispatch", { run: "check", repo: REPOSITORY, sha, inputs }),
    );
    expect(dispatched.socket).toBe(0);
    expect(dispatched.answer.isError).toBe(false);
    const id = String(dispatched.answer.value["execution_id"]);
    expect(id).not.toMatch(/^local-/);
    expect(dispatched.http.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/dispatch/check",
    ]);
    expect(dispatched.http[0]!.headers["cf-access-token"]).toBe(token);
    // [FD-IFC-075] The Worker admitted it under the developer's own identity.
    const record = (
      await (
        await stack.mf.getD1Database("DB")
      )
        .prepare("select trigger, caller from intake_records where execution_id = ?")
        .bind(id)
        .all()
    ).results[0];
    expect(record).toEqual({ trigger: "dispatch", caller: OPERATOR });

    const verdict = await routed(() => mcp.call("get_verdict", { execution_id: id }));
    expect(verdict.socket).toBe(0);
    expect(verdict.answer).toMatchObject({
      isError: false,
      value: { execution_id: id, run: "check", repository: REPOSITORY, verdict: null },
    });
    expect(verdict.http.map((r) => `${r.method} ${r.path.split("?")[0]}`)).toEqual([
      `GET /v1/executions/${id}`,
    ]);
    expect(verdict.http[0]!.headers["cf-access-token"]).toBe(token);
  });
});
