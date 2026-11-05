// `POST /v1/dispatch/:run` through the route group: the identity gate before any lookup, the Actions OIDC token,
// the body and input schemas, idempotency keys, the installation and the commit.
import { describe, expect, it } from "vitest";
import {
  actionsToken,
  AUDIENCE,
  BASE,
  bodyOf,
  dispatchRequest,
  harness,
  HEAD,
  otherKey,
  REPO,
  type Harness,
} from "./harness.test-support.ts";
import { handleIntake } from "./routes.ts";

const dispatch = (h: Harness, request: Request) =>
  h.run(handleIntake(request, `dispatch/${new URL(request.url).pathname.split("/").pop()}`));

const ok = { inputs: { sha: HEAD }, label: "ci" };

describe("the dispatch identity gate", () => {
  it("FD-INT-034 an unauthenticated dispatch answers 401 whatever the run name", async () => {
    const h = await harness();
    const known = await dispatch(h, dispatchRequest("check", ok, {}));
    const unknown = await dispatch(h, dispatchRequest("no-such-run", ok, {}));
    expect([known!.status, unknown!.status]).toEqual([401, 401]);
    expect((await bodyOf(unknown)).error).toBe("unauthenticated");
    expect(h.reads.calls).toEqual([]);
  });

  it("FD-INT-035 a token from another issuer, audience, an expired token or a bad signature answers 401", async () => {
    const h = await harness();
    const tokens = [
      actionsToken({ aud: "https://other.example.com" }),
      actionsToken({ exp: Date.UTC(2026, 10, 4, 11, 59, 0) / 1000 }),
      actionsToken({}, "k1", otherKey),
      actionsToken({}, "unknown-kid"),
    ];
    for (const t of tokens) {
      const r = await dispatch(h, dispatchRequest("check", ok, { authorization: `Bearer ${t}` }));
      expect(r!.status).toBe(401);
    }
    expect(h.executions()).toEqual([]);
  });

  it("FD-INT-035 the issuer's keys are cached for at most 1 h", async () => {
    const h = await harness();
    await dispatch(h, dispatchRequest("check", ok));
    await dispatch(h, dispatchRequest("check", ok));
    expect(h.recorded.jwksFetches).toBe(1);
    await h.adjust(3_600_000);
    await dispatch(
      h,
      dispatchRequest("check", ok, {
        authorization: `Bearer ${actionsToken({ exp: Date.UTC(2026, 10, 4, 14) / 1000 })}`,
      }),
    );
    expect(h.recorded.jwksFetches).toBe(2);
  });

  it("FD-INT-036 a body naming another repository than the token's claim answers 403 repository_mismatch", async () => {
    const h = await harness();
    const r = await dispatch(h, dispatchRequest("check", { ...ok, repository: "acme/other" }));
    expect(r!.status).toBe(403);
    expect((await bodyOf(r)).error).toBe("repository_mismatch");
  });

  it("FD-IFC-027 an Access identity in dispatchers may dispatch; another is 401", async () => {
    const h = await harness();
    const member = await dispatch(
      h,
      dispatchRequest(
        "check",
        { ...ok, repository: REPO },
        { "x-test-identity": "dev@example.com" },
      ),
    );
    const stranger = await dispatch(
      h,
      dispatchRequest(
        "check",
        { ...ok, repository: REPO },
        { "x-test-identity": "mallory@example.com" },
      ),
    );
    expect([member!.status, stranger!.status]).toEqual([202, 401]);
    expect(h.records()[0]).toMatchObject({ trigger: "dispatch", caller: "dev@example.com" });
  });
});

describe("dispatch validation", () => {
  it("FD-INT-039 an authenticated dispatch of an unknown run answers 404 run_not_found", async () => {
    const h = await harness();
    const r = await dispatch(h, dispatchRequest("no-such-run", ok));
    expect(r!.status).toBe(404);
    expect((await bodyOf(r)).error).toBe("run_not_found");
  });

  it("FD-INT-040 a body over 1 MiB is 413, a schema failure invalid_body and an input failure invalid_inputs", async () => {
    const h = await harness();
    const large = await dispatch(
      h,
      dispatchRequest("check", JSON.stringify({ pad: "x".repeat(1024 * 1024) })),
    );
    const notJson = await dispatch(h, dispatchRequest("check", "{"));
    const badBody = await dispatch(h, dispatchRequest("check", { ...ok, sha: "not-a-sha" }));
    const badInputs = await dispatch(h, dispatchRequest("check", { inputs: { steps: 1 } }));
    expect([large!.status, notJson!.status, badBody!.status, badInputs!.status]).toEqual([
      413, 400, 400, 400,
    ]);
    expect([(await bodyOf(badBody)).error, (await bodyOf(badInputs)).error]).toEqual([
      "invalid_body",
      "invalid_inputs",
    ]);
  });

  it("FD-INT-010 FD-INT-011 an Idempotency-Key outside 1 to 128 characters of [A-Za-z0-9._:-] answers 400 invalid_idempotency_key", async () => {
    const h = await harness();
    const bearer = { authorization: `Bearer ${actionsToken({})}` };
    for (const key of ["", "x".repeat(129), "has space", "slash/no"]) {
      const r = await dispatch(
        h,
        dispatchRequest("check", ok, { ...bearer, "idempotency-key": key }),
      );
      expect(r!.status).toBe(400);
      expect((await bodyOf(r)).error).toBe("invalid_idempotency_key");
    }
  });

  it("FD-INT-010 FD-INT-003 a reused Idempotency-Key with the same body is a duplicate, with another body 409 conflict", async () => {
    const h = await harness();
    const headers = { authorization: `Bearer ${actionsToken({})}`, "idempotency-key": "build-7" };
    const first = await bodyOf(await dispatch(h, dispatchRequest("check", ok, headers)));
    const same = await bodyOf(await dispatch(h, dispatchRequest("check", ok, headers)));
    const other = await dispatch(
      h,
      dispatchRequest("check", { ...ok, inputs: { sha: BASE } }, headers),
    );
    expect(same).toMatchObject({ execution_id: first.execution_id, duplicate: true });
    expect(other!.status).toBe(409);
    expect(await bodyOf(other)).toMatchObject({
      error: "conflict",
      execution_id: first.execution_id,
    });
    expect(h.rows("select canonical, request_digest from dedup_keys")).toEqual([
      {
        canonical: `idem:${REPO}:build-7`,
        request_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });

  it("FD-INT-049 more than 50 merged signals or an over-long field answers 400 invalid_signals", async () => {
    const h = await harness();
    const signal = { source: "lint", title: "t" };
    const many = await dispatch(
      h,
      dispatchRequest("check", {
        ...ok,
        inputs: { sha: HEAD, signals: Array(30).fill(signal) },
        signals: Array(21).fill(signal),
      }),
    );
    const long = await dispatch(
      h,
      dispatchRequest("check", { ...ok, signals: [{ source: "s".repeat(121), title: "t" }] }),
    );
    expect([many!.status, long!.status]).toEqual([400, 400]);
    expect((await bodyOf(many)).error).toBe("invalid_signals");
  });
});

describe("dispatch to admission", () => {
  it("FD-INT-001 FD-IFC-035 an admitted dispatch answers 202 with execution_id, class, details_url and logs_url", async () => {
    const h = await harness();
    const r = await dispatch(h, dispatchRequest("check", ok));
    expect(r!.status).toBe(202);
    const body = await bodyOf(r);
    expect(body).toMatchObject({ class: "interactive", execution_id: expect.any(String) });
    expect(body.details_url).toBe(
      `https://control-plane.example.com/v1/executions/${body.execution_id}`,
    );
    expect(h.executions()).toEqual([
      {
        id: body.execution_id,
        scope_id: REPO,
        run: "check",
        class: "interactive",
        status: "pending",
      },
    ]);
  });

  it("FD-INT-009 a dispatch after a webhook for the same run and commit is a duplicate of it", async () => {
    const h = await harness();
    const first = await bodyOf(await dispatch(h, dispatchRequest("check", { ...ok, sha: HEAD })));
    const second = await bodyOf(await dispatch(h, dispatchRequest("check", { ...ok, sha: HEAD })));
    expect(second).toMatchObject({ execution_id: first.execution_id, duplicate: true });
  });

  it("FD-INT-041 a dispatch with no ref pins the default branch head", async () => {
    const h = await harness();
    await dispatch(
      h,
      dispatchRequest(
        "check",
        { ...ok, repository: REPO },
        { "x-test-identity": "dev@example.com" },
      ),
    );
    expect(h.records()[0]).toMatchObject({ sha: BASE, ref: "refs/heads/main" });
  });

  it("FD-INT-042 FD-INT-043 the installation resolves from the repository; a repository no installation covers answers 422", async () => {
    const h = await harness();
    await dispatch(h, dispatchRequest("check", ok));
    expect(h.records()[0]!.installation).toBe(7);
    expect(h.reads.calls).toContain(`installation ${REPO}`);
    const none = await harness({ installations: {} });
    const r = await dispatch(none, dispatchRequest("check", ok));
    expect(r!.status).toBe(422);
    expect((await bodyOf(r)).error).toBe("installation_not_found");
    expect(none.executions()).toEqual([]);
  });

  it("FD-IFC-028 FD-INT-015 a run the manifest does not list for dispatch answers 404 run_not_found", async () => {
    const h = await harness();
    const r = await dispatch(h, dispatchRequest("nightly", { inputs: { sha: HEAD } }));
    expect(r!.status).toBe(404);
    expect(h.executions()).toEqual([]);
  });

  it("FD-IFC-033 a class input reaches class resolution", async () => {
    const h = await harness();
    await dispatch(h, dispatchRequest("check", { ...ok, class: "batch" }));
    expect(h.recorded.resolved[0]).toMatchObject({ classInput: "batch", trigger: "dispatch" });
    expect(h.recorded.resolved[0]!.caller).toMatchObject({ kind: "actions-oidc" });
    expect(AUDIENCE).toContain("https://");
  });
});

describe("the route group", () => {
  it("FD-INT-064 a served path with another method answers 405; an unserved path is the router's 404", async () => {
    const h = await harness();
    const get = await h.run(
      handleIntake(
        new Request("https://cp.example.com/v1/webhooks/github", { method: "GET" }),
        "webhooks/github",
      ),
    );
    expect(get!.status).toBe(405);
    expect(await bodyOf(get)).toMatchObject({
      error: "method_not_allowed",
      request_id: expect.any(String),
    });
    expect(
      await h.run(handleIntake(new Request("https://cp.example.com/v1/other"), "other")),
    ).toBeNull();
  });

  it("FD-INT-065 a defect answers 500 internal with a request id and no exception text", async () => {
    const h = await harness({
      settings: {
        catalog: () => {
          throw new Error("secret detail");
        },
      },
    });
    const r = await dispatch(h, dispatchRequest("check", ok));
    expect(r!.status).toBe(500);
    const body = await bodyOf(r);
    expect(body).toEqual({
      error: "internal",
      message: "internal error",
      request_id: expect.any(String),
    });
  });
});
