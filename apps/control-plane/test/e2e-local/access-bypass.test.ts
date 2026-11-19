// The machine paths, reached over HTTP with no Access JWT: no Access application covers them, so the Worker runs each
// surface's own identity check (FD-OPS-088). Each machine path has a probe here that a request without the surface's
// credential is refused and, where the Worker serves the surface, that one with it is admitted.
import { mintLinkToken } from "@fractalboxdev/flare-dispatch-api";
import { signCompileCacheToken } from "@fractalboxdev/flare-dispatch-cache";
import {
  accessCovers,
  HUMAN_PATHS,
  isMachinePath,
  MACHINE_PATHS,
} from "@fractalboxdev/flare-dispatch-ops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signControlPlaneReadToken } from "../../src/control-plane-read.ts";
import { signDeployClaimToken } from "../../src/deploy-claim.ts";
import { signModelLeaseToken } from "../../src/model-gateway.ts";
import { router } from "../../src/http.ts";
import { connect, hello, newDevice, OPERATOR, registration } from "../support.ts";
import {
  COMPILE_CACHE_SECRET,
  CONTROL_PLANE_READ_SECRET,
  DEPLOY_CLAIM_SECRET,
  LINK_KEY,
  MODEL_LEASE_SECRET,
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

const readToken = (secret: string) =>
  signControlPlaneReadToken(secret, {
    executionId: EXECUTION,
    epoch: 1,
    expiresAt: Date.now() + 600_000,
  });

/**
 * A surface that takes a lease's control-plane read token as the bearer: a token under another secret is
 * `unauthenticated`, and one under the deploy's secret passes the token check while the lease it names is not current.
 */
const leaseReadProbe = async (path: string) => {
  const forged = await send("GET", path, {
    authorization: `Bearer ${await readToken("another-secret")}`,
  });
  expect(forged.status).toBe(401);
  expect(await forged.json()).toMatchObject({ error: "unauthenticated", message: "token invalid" });
  const signed = await send("GET", path, {
    authorization: `Bearer ${await readToken(CONTROL_PLANE_READ_SECRET)}`,
  });
  expect(signed.status).toBe(401);
  expect(await signed.json()).toMatchObject({
    error: "lease_stale",
    message: "token epoch is not current",
  });
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

/** One probe per machine surface, keyed by the surface `MACHINE_PATHS` names. */
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
  "executions list": async () => {
    const path = `/v1/executions?repository=${encodeURIComponent(REPOSITORY)}`;
    const none = await send("GET", path);
    expect(none.status).toBe(401);
    expect(await errorOf(none)).toBe("unauthenticated");
    await leaseReadProbe(path);
  },
  log: async () => {
    const path = `/v1/logs/${EXECUTION}`;
    await linkProbe("logs", EXECUTION, path)();
    await leaseReadProbe(path);
    await linkProbe("logs", EXECUTION, `/v1/logs/${EXECUTION}/run.log`)();
  },
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
  "deploy-claim": async () => {
    const path = `/v1/deploy-claims/${EXECUTION}`;
    const token = (secret: string) =>
      signDeployClaimToken(secret, {
        executionId: EXECUTION,
        epoch: 1,
        expiresAt: Date.now() + 600_000,
      });
    const none = await send("POST", path);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: "unauthenticated", message: "token missing" });
    const forged = await send("POST", path, {
      authorization: `Bearer ${await token("another-secret")}`,
    });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ message: "token invalid" });
    // A token signed under the deploy's secret passes the token check; the lease it names is not current.
    const signed = await send("POST", path, {
      authorization: `Bearer ${await token(DEPLOY_CLAIM_SECRET)}`,
    });
    expect(signed.status).toBe(403);
    expect(await signed.json()).toMatchObject({ message: "token epoch is not current" });
  },
  "model-gateway": async () => {
    const path = "/v1/model/completions";
    const json = { "content-type": "application/json" };
    const token = (secret: string) =>
      signModelLeaseToken(secret, {
        executionId: EXECUTION,
        epoch: 1,
        expiresAt: Date.now() + 600_000,
      });
    const none = await send("POST", path, json, "{}");
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: "unauthenticated", message: "token missing" });
    const forged = await send(
      "POST",
      path,
      { ...json, authorization: `Bearer ${await token("another-secret")}` },
      "{}",
    );
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ message: "token invalid" });
    // A token signed under the deploy's secret passes the token check; the lease it names is not current.
    const signed = await send(
      "POST",
      path,
      { ...json, authorization: `Bearer ${await token(MODEL_LEASE_SECRET)}` },
      "{}",
    );
    expect(signed.status).toBe(401);
    expect(await signed.json()).toMatchObject({
      error: "lease_stale",
      message: "token epoch is not current",
    });
  },
  // No route serves the provenance reads on this deploy, so the Worker answers each with its own Access check: a
  // bypass at the edge reaches no route logic.
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

/** Whether an Access application on the human paths covers a request path. */
const human = (path: string) => HUMAN_PATHS.some((h) => accessCovers(h.path, path));

describe("the machine paths Access leaves uncovered", () => {
  it("[FD-OPS-088] lists as a machine path every route whose surface names an identity other than the Access JWT, and covers every Access-only route with a human path", () => {
    const outside = router.routes.filter(
      (r) => r.surface._tag !== "Access" && r.surface._tag !== "AccessOrActions",
    );
    expect(outside.length).toBeGreaterThan(5);
    for (const r of outside)
      expect({
        path: r.path,
        machine: isMachinePath(concrete(r.path)),
        human: human(concrete(r.path)),
      }).toEqual({
        path: r.path,
        machine: true,
        human: false,
      });
    for (const r of router.routes.filter((x) => x.surface._tag === "Access"))
      expect({
        path: r.path,
        machine: isMachinePath(concrete(r.path)),
        human: human(concrete(r.path)),
      }).toEqual({
        path: r.path,
        machine: false,
        human: true,
      });
    // The executions list takes a lease's control-plane read token beside the Access JWT; one execution is human.
    expect(isMachinePath("/v1/executions")).toBe(true);
    expect(human("/v1/executions")).toBe(false);
    expect(isMachinePath(`/v1/executions/${EXECUTION}/failure-summary`)).toBe(false);
    expect(human(`/v1/executions/${EXECUTION}/failure-summary`)).toBe(true);
    // The connect upgrade, the compile cache, the deploy claim and the model route are answered before the router.
    expect(isMachinePath("/v1/executors/connect")).toBe(true);
    expect(isMachinePath(`/v1/compile-cache/${REPOSITORY}/ns/key`)).toBe(true);
    expect(isMachinePath(`/v1/deploy-claims/${EXECUTION}`)).toBe(true);
    expect(isMachinePath("/v1/model/completions")).toBe(true);
  });

  it("[FD-OPS-088] the Worker runs each machine surface's own identity check on a request with no Access JWT", async () => {
    expect(Object.keys(probes).sort()).toEqual(MACHINE_PATHS.map((m) => m.surface).sort());
    for (const m of MACHINE_PATHS)
      await probes[m.surface]!().catch((e: unknown) => {
        throw new Error(`${m.surface} ${m.path}: ${String(e)}`);
      });
  });
});
