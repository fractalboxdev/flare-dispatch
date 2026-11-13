// The paths the committed Access configuration bypasses, reached over HTTP with no Access JWT: Access in front of the
// deployed Worker lets these requests through, so the Worker runs each surface's own identity check (FD-OPS-088). Each
// bypassed path has a probe here that a request without the surface's credential is refused and, where the Worker
// serves the surface, that one with it is admitted.
import { mintLinkToken } from "@fractalboxdev/flare-dispatch-api";
import { signCompileCacheToken } from "@fractalboxdev/flare-dispatch-cache";
import { ACCESS_BYPASS, bypassed } from "@fractalboxdev/flare-dispatch-ops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { router } from "../../src/http.ts";
import { connect, hello, newDevice, OPERATOR, registration } from "../support.ts";
import {
  COMPILE_CACHE_SECRET,
  LINK_KEY,
  OIDC_AUDIENCE,
  PLANE_ID,
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

const EXECUTION = "01E2EBYPASS000000000000000";
const ARTIFACT = "01E2EBYPASSART0000000000000";

/** A request with no Access JWT. */
const send = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
  fetch(`${stack.url}${path}`, {
    method,
    headers: { accept: "application/json", ...headers },
    redirect: "manual",
    ...(body === undefined ? {} : { body }),
  });

const errorOf = async (r: Response) => ((await r.json()) as { error?: string }).error;

const link = (purpose: "logs" | "artifact", objectId: string) =>
  mintLinkToken(LINK_KEY, {
    purpose,
    objectId,
    expiresAtS: Math.floor(Date.now() / 1000) + 600,
    epoch: 0,
  });

/** A link surface: no token falls to the Access check, a token for another object is refused, its own admitted. */
const linkProbe = (purpose: "logs" | "artifact", objectId: string, path: string) => async () => {
  const none = await send("GET", path);
  expect(none.status).toBe(401);
  const other = await send("GET", `${path}?t=${await link(purpose, "01OTHEROBJECT0000000000000")}`);
  expect(other.status).toBe(403);
  const own = await send("GET", `${path}?t=${await link(purpose, objectId)}`);
  expect([401, 403]).not.toContain(own.status);
};

const compileCacheToken = (secret: string) =>
  signCompileCacheToken(secret, {
    repo: REPOSITORY,
    executionId: EXECUTION,
    epoch: 1,
    read: ["ns"],
    write: "ns",
    expiresAt: Date.now() + 600_000,
  });

/** One probe per bypassed surface, keyed by the surface `ACCESS_BYPASS` names. */
const probes: Readonly<Record<string, () => Promise<void>>> = {
  webhook: async () => {
    const forged = stack.github.delivery("ping", "ping.json", "another-secret");
    const refused = await fetch(`${stack.url}/v1/webhooks/github`, {
      method: "POST",
      headers: forged.headers,
      body: forged.body,
    });
    expect(refused.status).toBe(401);
    const ping = stack.github.delivery("ping", "ping.json", WEBHOOK_SECRET);
    const admitted = await fetch(`${stack.url}/v1/webhooks/github`, {
      method: "POST",
      headers: ping.headers,
      body: ping.body,
    });
    expect(admitted.status).toBe(200);
  },
  dispatch: async () => {
    const sha = "5".repeat(40);
    const body = JSON.stringify({
      repository: REPOSITORY,
      sha,
      inputs: {
        repo: `https://github.com/${REPOSITORY}`,
        sha,
        ref: "refs/heads/main",
        steps: [{ label: "test", command: "pnpm test" }],
      },
    });
    const json = { "content-type": "application/json" };
    const none = await send("POST", "/v1/dispatch/check", json, body);
    expect(none.status).toBe(401);
    expect(await errorOf(none)).toBe("unauthenticated");
    const token = await stack.github.oidcToken({ repository: REPOSITORY, sha }, OIDC_AUDIENCE);
    const admitted = await send(
      "POST",
      "/v1/dispatch/check",
      { ...json, authorization: `Bearer ${token}` },
      body,
    );
    expect(admitted.status).toBe(202);
  },
  "executor connect": async () => {
    const unsigned = await stack.mf.dispatchFetch(`http://x/v1/executors/connect`, {
      headers: { Upgrade: "websocket" },
    });
    expect(unsigned.webSocket ?? null).toBeNull();
    expect(unsigned.status).toBeGreaterThanOrEqual(400);
    expect(unsigned.status).toBeLessThan(500);
    const device = await newDevice();
    const enrolled = await fetch(`${stack.url}/v1/executors/register`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await stack.access(OPERATOR)) },
      body: JSON.stringify(registration("bypass-device", device.identity)),
    });
    expect(enrolled.status).toBe(201);
    // The connect carries the device key's signature and no Access JWT.
    const socket = await connect(stack.mf, "bypass-device", device.keys, PLANE_ID);
    socket.send(hello("bypass-device", PLANE_ID));
    expect(await socket.next("session.welcome")).toMatchObject({ type: "session.welcome" });
  },
  health: async () => {
    expect((await send("GET", "/health")).status).toBe(200);
  },
  "well-known": async () => {
    for (const path of ["/.well-known/openid-configuration", "/.well-known/jwks.json"]) {
      const r = await send("GET", path);
      expect({ path, status: r.status }).not.toMatchObject({ status: 401 });
      expect({ path, status: r.status }).not.toMatchObject({ status: 403 });
    }
  },
  "log aggregate": linkProbe("logs", EXECUTION, `/v1/executions/${EXECUTION}/logs`),
  log: linkProbe("logs", EXECUTION, `/v1/executions/${EXECUTION}/logs/run.log`),
  artifact: linkProbe("artifact", ARTIFACT, `/v1/artifacts/${ARTIFACT}`),
  "compile-cache": async () => {
    const path = `/v1/compile-cache/${REPOSITORY}/ns/key`;
    const none = await send("GET", path);
    expect(none.status).toBe(403);
    expect(await none.text()).toBe("token missing");
    const forged = await send("GET", path, {
      authorization: `Bearer ${await compileCacheToken("another-secret")}`,
    });
    expect(forged.status).toBe(403);
    expect(await forged.text()).toBe("token invalid");
    // A token signed under the deploy's secret passes the token check; the lease it names is not current.
    const signed = await send("GET", path, {
      authorization: `Bearer ${await compileCacheToken(COMPILE_CACHE_SECRET)}`,
    });
    expect(await signed.text()).toBe("token epoch is not current");
  },
  // No route serves the model gateway or the provenance reads on this deploy, so the Worker answers each with its own
  // Access check: a bypass at the edge reaches no route logic.
  "model-gateway": async () => {
    const r = await send(
      "POST",
      "/v1/model/completions",
      { "content-type": "application/json" },
      "{}",
    );
    expect(r.status).toBe(401);
    expect(await errorOf(r)).toBe("unauthenticated");
  },
  "provenance executions": async () => {
    const r = await send("GET", "/v1/provenance/executions/01E2EBYPASS000000000000000");
    expect(r.status).toBe(401);
    expect(await errorOf(r)).toBe("unauthenticated");
  },
  "provenance subjects": async () => {
    const r = await send("GET", `/v1/provenance/subjects/sha256:${"0".repeat(64)}`);
    expect(r.status).toBe(401);
    expect(await errorOf(r)).toBe("unauthenticated");
  },
};

/** A concrete path for a route pattern: each `:param` and a trailing `*` filled in. */
const concrete = (path: string) =>
  path.replace(/:[A-Za-z_]+/g, "01E2EBYPASS000000000000000").replace(/\*$/, "x");

describe("the paths Access bypasses", () => {
  it("[FD-OPS-088] bypasses every route whose surface names an identity other than the Access JWT, and no Access-only route", () => {
    const outside = router.routes.filter(
      (r) => r.surface._tag !== "Access" && r.surface._tag !== "AccessOrActions",
    );
    expect(outside.length).toBeGreaterThan(5);
    for (const r of outside)
      expect({ path: r.path, bypassed: bypassed(concrete(r.path)) }).toEqual({
        path: r.path,
        bypassed: true,
      });
    for (const r of router.routes.filter((x) => x.surface._tag === "Access"))
      expect({ path: r.path, bypassed: bypassed(concrete(r.path)) }).toEqual({
        path: r.path,
        bypassed: false,
      });
    // The connect upgrade and the compile cache are answered before the router.
    expect(bypassed("/v1/executors/connect")).toBe(true);
    expect(bypassed(`/v1/compile-cache/${REPOSITORY}/ns/key`)).toBe(true);
  });

  it("[FD-OPS-088] the Worker runs each bypassed surface's own identity check on a request with no Access JWT", async () => {
    expect(Object.keys(probes).sort()).toEqual(ACCESS_BYPASS.map((b) => b.surface).sort());
    for (const b of ACCESS_BYPASS)
      await probes[b.surface]!().catch((e: unknown) => {
        throw new Error(`${b.surface} ${b.path}: ${String(e)}`);
      });
  });
});
