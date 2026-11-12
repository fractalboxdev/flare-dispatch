// The containment identity on `/v1/ops/*` (specs/interfaces.md § Containment), over a fake `Operations` whose control
// state each test sets.
import { Effect } from "effect";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  baseConfig,
  DISPATCHER,
  makeHarness,
  MEMBER,
  OPERATOR,
  record,
  type Harness,
} from "../api.test-support.ts";
import { apiError } from "../errors.ts";
import type { ControlState } from "../ports.ts";

const RESPONDER = "responder@example.com";
const config = baseConfig({ containment: [RESPONDER] });

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
beforeEach(() => {
  h.doubles.calls.operations.length = 0;
  h.doubles.controlState = Effect.fail(apiError("unavailable", "no control state is read"));
  h.doubles.deliveryKeys = { list: Effect.succeed(["11", "12"]) };
});

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

/** A request to `path` as `identity`, with `body` as JSON when given, under the overlay with one containment identity. */
const as = async (identity: string, path: string, body?: unknown) =>
  h.fetch(path, {
    ...(await h.asAccess(
      identity,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    )),
    config,
  });

const controlStateIs = (state: ControlState) => {
  h.doubles.controlState = Effect.succeed(state);
};

const reason = "incident 42";

/** The four routes a containment identity is admitted on, each with a request it may make. */
const ADMITTED = [
  ["/v1/ops/halt", { state: "halt-all", reason }],
  ["/v1/ops/quarantine", { executor: "exec-1", reason }],
  ["/v1/ops/pause-key", { installation: "11", reason }],
  ["/v1/ops/delivery-keys", undefined],
] as const;

/** Every other `/v1/ops/*` route. */
const REFUSED = [
  ["/v1/ops/release", { executor: "exec-1", reason }],
  ["/v1/ops/force-admit", { execution_id: "x", expires_at: 1, reason }],
  ["/v1/ops/top-up", { amount_micro_usd: 1, expires_at: 1, reason }],
  ["/v1/ops/drain", { executor: "exec-1", reason }],
  ["/v1/ops/revoke", { executor: "exec-1", reason }],
  ["/v1/ops/resume-key", { installation: "11", reason }],
  ["/v1/ops/health", undefined],
] as const;

describe("the containment identity's routes", () => {
  it("[FD-IFC-095] admits a containment identity on halt, quarantine, pause-key and delivery-keys", async () => {
    for (const [path, body] of ADMITTED) {
      const response = await as(RESPONDER, path, body);
      expect(response.status, path).toBe(200);
    }
    expect(h.doubles.calls.operations.map(({ operation }) => operation._tag)).toEqual([
      "halt",
      "quarantine",
      "pause",
    ]);
    expect(h.doubles.calls.operations.every(({ call }) => call.identity === RESPONDER)).toBe(true);
    expect(await json(await as(RESPONDER, "/v1/ops/delivery-keys"))).toEqual({
      installations: ["11", "12"],
    });
  });

  it("[FD-IFC-095], [FD-IFC-016] answers a containment identity 403 forbidden on every other /v1/ops/* route, applying nothing", async () => {
    for (const [path, body] of REFUSED) {
      const response = await as(RESPONDER, path, body);
      expect(response.status, path).toBe(403);
      expect((await json(response))["error"], path).toBe("forbidden");
    }
    expect(h.doubles.calls.operations).toEqual([]);
    for (const [path, body] of REFUSED) expect((await as(OPERATOR, path, body)).status).toBe(200);
  });

  it("[FD-IFC-095], [FD-IFC-016] admits on the containment routes no identity that is in neither operators nor containment", async () => {
    for (const identity of [MEMBER, DISPATCHER])
      for (const [path, body] of ADMITTED) {
        const response = await as(identity, path, body);
        expect(response.status, `${identity} ${path}`).toBe(403);
        expect((await json(response))["error"]).toBe("forbidden");
      }
    expect(h.doubles.calls.operations).toEqual([]);
  });
});

describe("the containment identity tightens and never releases", () => {
  it("[FD-IFC-096] answers a containment identity's halt run with 403 forbidden and applies nothing; an operator's applies", async () => {
    controlStateIs("halt-all");
    const refused = await as(RESPONDER, "/v1/ops/halt", { state: "run", reason });
    expect(refused.status).toBe(403);
    expect((await json(refused))["error"]).toBe("forbidden");
    expect(h.doubles.calls.operations).toEqual([]);
    expect((await as(RESPONDER, "/v1/ops/halt", { state: "halt-all", reason })).status).toBe(200);
    expect((await as(OPERATOR, "/v1/ops/halt", { state: "run", reason })).status).toBe(200);
    expect(h.doubles.calls.operations.map(({ operation }) => operation)).toEqual([
      { _tag: "halt", state: "halt-all" },
      { _tag: "halt", state: "run" },
    ]);
  });

  it("[FD-IFC-097] answers a containment identity's halt-cloud with 403 forbidden while the control state is halt-all", async () => {
    controlStateIs("halt-all");
    const refused = await as(RESPONDER, "/v1/ops/halt", { state: "halt-cloud", reason });
    expect(refused.status).toBe(403);
    expect((await json(refused))["error"]).toBe("forbidden");
    expect(h.doubles.calls.operations).toEqual([]);
    expect((await as(RESPONDER, "/v1/ops/halt", { state: "halt-all", reason })).status).toBe(200);
    expect((await as(OPERATOR, "/v1/ops/halt", { state: "halt-cloud", reason })).status).toBe(200);
    expect(h.doubles.calls.operations.map(({ operation }) => operation)).toEqual([
      { _tag: "halt", state: "halt-all" },
      { _tag: "halt", state: "halt-cloud" },
    ]);
  });

  it("[FD-IFC-097] applies a containment identity's halt-cloud while the control state is run or halt-cloud", async () => {
    for (const state of ["run", "halt-cloud"] as const) {
      controlStateIs(state);
      const response = await as(RESPONDER, "/v1/ops/halt", { state: "halt-cloud", reason });
      expect(response.status, state).toBe(200);
    }
    expect(h.doubles.calls.operations.map(({ operation }) => operation)).toEqual([
      { _tag: "halt", state: "halt-cloud" },
      { _tag: "halt", state: "halt-cloud" },
    ]);
  });

  it("[FD-IFC-097] answers 503 unavailable, applying nothing, when the control state cannot be read", async () => {
    const response = await as(RESPONDER, "/v1/ops/halt", { state: "halt-cloud", reason });
    expect(response.status).toBe(503);
    expect((await json(response))["error"]).toBe("unavailable");
    expect(h.doubles.calls.operations).toEqual([]);
  });

  it("[FD-IFC-098] answers a containment identity's pause-key of the records key with 403 forbidden; an operator's applies", async () => {
    const refused = await as(RESPONDER, "/v1/ops/pause-key", { installation: "records", reason });
    expect(refused.status).toBe(403);
    expect((await json(refused))["error"]).toBe("forbidden");
    expect(h.doubles.calls.operations).toEqual([]);
    expect((await as(RESPONDER, "/v1/ops/pause-key", { installation: "11", reason })).status).toBe(
      200,
    );
    const operator = await as(OPERATOR, "/v1/ops/pause-key", { installation: "records", reason });
    expect(operator.status).toBe(200);
    expect(h.doubles.calls.operations.map(({ operation }) => operation)).toEqual([
      { _tag: "pause", installation: "11" },
      { _tag: "pause", installation: "records" },
    ]);
  });

  it("[FD-IFC-046] lets a containment identity cancel an execution it did not dispatch", async () => {
    const id = "01JCONTAIN000000000000000";
    h.doubles.executions.set(id, record({ execution_id: id, status: "running", verdict: null }));
    expect((await as(MEMBER, `/v1/executions/${id}/cancel`, {})).status).toBe(403);
    const response = await as(RESPONDER, `/v1/executions/${id}/cancel`, {});
    expect(response.status).toBe(202);
    expect(h.doubles.calls.cancels.at(-1)).toEqual({ executionId: id, identity: RESPONDER });
  });
});
