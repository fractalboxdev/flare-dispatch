import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { beforeAll, describe, expect, it } from "vitest";
import {
  accessClaims,
  baseConfig,
  makeHarness,
  MEMBER,
  OPERATOR,
  type Harness,
} from "./api.test-support.ts";
import { FlareDispatchApi } from "./declaration.ts";
import {
  artifactsGroup,
  declaredGroups,
  logsGroup,
  operabilityGroup,
  provenanceGroup,
} from "./groups.ts";
import { DuplicateRoute, matchPath, mount, routerGroup } from "./router.ts";
import { Effect, Layer } from "effect";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe("declaration and router", () => {
  it("[FD-IFC-001]: the mounted routes are exactly the declaration's endpoints", () => {
    const declared: string[] = [];
    HttpApi.reflect(FlareDispatchApi, {
      onGroup: () => {},
      onEndpoint: ({ endpoint }) => declared.push(`${endpoint.method} ${endpoint.path}`),
    });
    const logs = logsGroup(
      HttpApiBuilder.group(FlareDispatchApi, "logs", (handlers) =>
        handlers
          .handle("aggregate", () => Effect.succeed(""))
          .handle("file", () => Effect.succeed("")),
      ),
    );
    const artifacts = artifactsGroup(
      HttpApiBuilder.group(FlareDispatchApi, "artifacts", (handlers) =>
        handlers
          .handle("get", () => Effect.succeed(new Uint8Array()))
          .handle("list", () => Effect.succeed({ artifacts: [], cursor: null })),
      ),
    );
    const operability = operabilityGroup(
      HttpApiBuilder.group(FlareDispatchApi, "operability", (handlers) =>
        handlers
          .handle("fleet", () => Effect.succeed([]))
          .handle("phaseGate", () =>
            Effect.succeed({
              gate: 0,
              windowStart: 0,
              windowEnd: 0,
              measures: [],
              pageAlarms: [],
              killLines: [],
            }),
          )
          .handle("spend", () =>
            Effect.succeed({
              month: "2027-01",
              budget: 0,
              settled: 0,
              reserved: 0,
              committed: 0,
              classes: [],
              floor: 0,
              measured_reserve_runway_days: null,
              control_state: "run" as const,
              resets_at: 0,
            }),
          )
          .handle("installNew", () => Effect.succeed(""))
          .handle("installCallback", () => Effect.succeed("")),
      ),
    );
    const mounted = mount(
      ...declaredGroups,
      operability,
      logs,
      artifacts,
      provenanceGroup,
    ).routes.map((r) => `${r.method} ${r.path}`);
    expect(mounted.sort()).toEqual(declared.sort());
  });

  it("[FD-IFC-004]: a path no route claims answers 404 not_found with the error shape", async () => {
    const response = await h.fetch("/nowhere");
    expect(response.status).toBe(404);
    const body = await json(response);
    expect(body).toMatchObject({ error: "not_found" });
    expect(typeof body["request_id"]).toBe("string");
    expect(typeof body["message"]).toBe("string");
  });

  it("[FD-IFC-010], [FD-IFC-004]: an unclaimed /v1 path passes the Access gate before its 404", async () => {
    expect((await h.fetch("/v1/nothing-here")).status).toBe(401);
    expect((await h.fetch("/v1/nothing-here", await h.asAccess(MEMBER))).status).toBe(404);
  });

  it("[FD-IFC-005], [FD-IFC-003]: another method on a known path answers 405 only after the identity gate", async () => {
    expect((await h.fetch("/v1/executions", { method: "DELETE" })).status).toBe(401);
    const response = await h.fetch(
      "/v1/executions",
      await h.asAccess(MEMBER, { method: "DELETE" }),
    );
    expect(response.status).toBe(405);
    expect(await json(response)).toMatchObject({ error: "method_not_allowed" });
  });

  it("[FD-IFC-006]: a body over the limit answers 413 without being parsed", async () => {
    const big = "x".repeat(1_048_577);
    const response = await h.fetch(
      "/v1/ops/halt",
      await h.asAccess(OPERATOR, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(big.length) },
        body: big,
      }),
    );
    expect(response.status).toBe(413);
    expect(await json(response)).toMatchObject({ error: "payload_too_large" });
  });

  it("[FD-IFC-006]: a streamed body with no length is bounded too", async () => {
    const chunk = new Uint8Array(512 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 3; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await h.fetch(
      "/v1/ops/halt",
      await h.asAccess(OPERATOR, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
  });

  it("[FD-IFC-007]: a body that fails its schema answers 400 invalid_body naming the first failing path", async () => {
    const response = await h.fetch(
      "/v1/ops/halt",
      await h.asAccess(OPERATOR, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "sideways", reason: "x" }),
      }),
    );
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body["error"]).toBe("invalid_body");
    expect(body["message"]).toContain("state");
  });

  it("[FD-IFC-007]: a body that is not JSON answers 400 invalid_body", async () => {
    const response = await h.fetch(
      "/v1/ops/halt",
      await h.asAccess(OPERATOR, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
    expect((await json(response))["error"]).toBe("invalid_body");
  });

  it("[FD-IFC-008]: a defect answers 500 internal with the request id and no exception text", async () => {
    // An `operators` list that is not an array makes the cancel route's group check throw.
    const cancel = await h.fetch("/v1/executions/01JEXEC0000000000000000000/cancel", {
      ...(await h.asAccess(MEMBER, { method: "POST" })),
      config: { ...baseConfig(), operators: undefined as never },
    });
    expect(cancel.status).toBe(500);
    const body = await json(cancel);
    expect(body["error"]).toBe("internal");
    expect(body["message"]).toBe("internal error");
    expect(typeof body["request_id"]).toBe("string");
  });

  it("[FD-IFC-009]: every error carries exactly error, message and request_id", async () => {
    const response = await h.fetch("/v1/executions/missing", await h.asAccess(MEMBER));
    expect(response.status).toBe(404);
    expect(Object.keys(await json(response)).sort()).toEqual(["error", "message", "request_id"]);
  });

  it("mount refuses two groups that claim one method and path", () => {
    const clash = routerGroup(
      "clash",
      [{ method: "GET", path: "/health", surface: { _tag: "Public" } }],
      Layer.empty as never,
    );
    expect(() => mount(...declaredGroups, clash)).toThrow(DuplicateRoute);
  });

  it("the most specific path wins the surface", () => {
    const routes = mount(...declaredGroups).routes;
    expect(matchPath(routes, "/v1/executions/abc/failure-summary")[0]?.route.path).toBe(
      "/v1/executions/:id/failure-summary",
    );
  });

  it("accessClaims carry the team issuer", () => {
    expect(accessClaims(MEMBER).iss).toBe("https://team.example.com");
  });
});
