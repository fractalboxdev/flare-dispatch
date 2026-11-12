// The upgrade gate's end-to-end half (specs/interfaces.md § Upgrade gate): the HTTP API, an `fd-<subcommand>` and MCP
// together over the deployed Worker, each on the `effect` the workspace installs and its `@stability unstable` modules
// (`effect/http-api`, `effect/cli`, `effect/ai`). The e2e-local job runs this suite on every pull request, so a change
// to the `effect` version merges only when one execution reads the same through all three.
import { readFileSync, realpathSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ExecutionView, FlareDispatchApi } from "@fractalboxdev/flare-dispatch-api/declaration";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
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
import {
  developerEnv,
  dispatcherTool,
  forgetAccessToken,
  PLANE_ID,
  REPOSITORY,
  runFd,
  startFdMcp,
  startStack,
  storeAccessToken,
  type Stack,
} from "./stack.ts";

const ROOT = join(import.meta.dirname, "../../../..");

/** Each surface's package, and the unstable modules its sources import. */
const SURFACES = {
  "packages/api": {
    "src/declaration.ts": "effect/http-api",
    "src/mcp/server.ts": "effect/ai",
  },
  "packages/fd": {
    "src/client.ts": "effect/http-api",
    "src/main.ts": "effect/cli",
    "src/mcp-shim.ts": "effect/ai",
  },
  "apps/control-plane": {},
} as const;

/** The `effect` package a workspace package resolves, by its real path. */
const effectOf = (dir: string) =>
  dirname(
    realpathSync(createRequire(join(ROOT, dir, "package.json")).resolve("effect/package.json")),
  );

describe("the effect upgrade gate's modules", () => {
  it("[FD-IFC-082] the HTTP API, fd-<subcommand> and MCP surfaces run on one installed effect, at the version every package pins, and its modules they import are @stability unstable", () => {
    const installs = Object.keys(SURFACES).map(effectOf);
    expect(new Set(installs).size).toBe(1);
    const effect = installs[0]!;
    const installed = (
      JSON.parse(readFileSync(join(effect, "package.json"), "utf8")) as { version: string }
    ).version;
    for (const dir of Object.keys(SURFACES)) {
      const manifest = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      expect({ dir, effect: manifest.dependencies["effect"] }).toEqual({ dir, effect: installed });
    }
    const exportsMap = (
      JSON.parse(readFileSync(join(effect, "package.json"), "utf8")) as {
        exports: Record<string, string>;
      }
    ).exports;
    for (const [dir, files] of Object.entries(SURFACES))
      for (const [file, module] of Object.entries(files)) {
        expect(readFileSync(join(ROOT, dir, file), "utf8")).toContain(`from "${module}"`);
        const entry = exportsMap[`./${module.slice("effect/".length)}`];
        expect(entry).toBeDefined();
        const head = readFileSync(join(effect, entry!), "utf8").slice(0, 200);
        expect({
          module,
          unstable: /^\/\*\*\s*\n\s*\*\s*@stability unstable\b/.test(head),
        }).toEqual({
          module,
          unstable: true,
        });
      }
  });
});

let stack: Stack;
let device: Socket;
let home: string;

beforeAll(async () => {
  stack = await startStack();
  await storeAccessToken(stack.url, await stack.team.jwt(OPERATOR));
  home = mkdtempSync(join(tmpdir(), "fd-effect-"));
  const { identity, keys } = await newDevice();
  const enrolled = await fetch(`${stack.url}/v1/executors/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await stack.access(OPERATOR)) },
    body: JSON.stringify(registration("e2e-effect-device", identity)),
  });
  expect(enrolled.status).toBe(201);
  device = await connect(stack.mf, "e2e-effect-device", keys, PLANE_ID);
  device.send(hello("e2e-effect-device", PLANE_ID));
  await device.next("session.welcome");
});

afterAll(async () => {
  if (stack !== undefined) await forgetAccessToken(stack.url);
  await stack?.close();
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
});

/** The HTTP API client derived from the one declaration, as the operator. */
const withClient = <A, E>(
  use: (client: HttpApiClient.ForApi<typeof FlareDispatchApi>) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const jwt = yield* Effect.promise(() => stack.team.jwt(OPERATOR));
      const client = yield* HttpApiClient.make(FlareDispatchApi, {
        baseUrl: stack.url,
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.setHeader("cf-access-jwt-assertion", jwt),
        ),
      });
      return yield* use(client);
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

/** The device claims the lease of `id` and reports success for it. */
const settle = async (id: string) => {
  let claims = 0;
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
      outcome: ours ? { status: "success" } : { status: "cancelled", reason: "superseded" },
      usage: {},
      artifacts: [],
    });
    expect(await device.next("exec.result.ack")).toMatchObject({ status: "accepted" });
    await endStandingClaim(device);
    if (ours) return;
  }
};

describe("the HTTP API, an fd-<subcommand> and MCP over the deployed Worker", () => {
  it("[FD-IFC-082] one execution dispatched through the declared HTTP API reads the same verdict through fd verdict, the dispatcher's /mcp and fd mcp", async () => {
    const sha = "8".repeat(40);
    // effect/http-api: the declaration's client encodes the dispatch and decodes the answer by the route's schemas.
    const dispatched = await withClient((client) =>
      client.dispatch.dispatch({
        params: { run: "check" },
        headers: {},
        payload: {
          repository: REPOSITORY,
          sha,
          inputs: {
            repo: `https://github.com/${REPOSITORY}`,
            sha,
            ref: "refs/heads/main",
            steps: [{ label: "test", command: "pnpm test" }],
          },
        },
      }),
    );
    const id = dispatched.execution_id;
    await settle(id);
    const done = {
      execution_id: id,
      run: "check",
      repository: REPOSITORY,
      status: "done",
      verdict: "success",
    };

    const view = await withClient((client) => client.executions.get({ params: { id }, query: {} }));
    expect(view).toMatchObject(done);

    // effect/cli: the executable prints one document of the route's response schema and exits 0 on success.
    const fd = await runFd(developerEnv(stack, home), "verdict", [id, "--json"]);
    expect({ code: fd.code, stderr: fd.stderr }).toEqual({ code: 0, stderr: "" });
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(ExecutionView))(fd.stdout)).toEqual(view);

    // effect/ai: the dispatcher's MCP server over Streamable HTTP, and `fd mcp` over stdio.
    expect(await dispatcherTool(stack, OPERATOR, "get_verdict", { execution_id: id })).toEqual({
      isError: false,
      value: view,
    });
    const mcp = await startFdMcp(developerEnv(stack, home));
    try {
      expect(await mcp.call("get_verdict", { execution_id: id })).toEqual({
        isError: false,
        value: view,
      });
    } finally {
      expect(await mcp.close()).toBe(0);
    }
  });
});
