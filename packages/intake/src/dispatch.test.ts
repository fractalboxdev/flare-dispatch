// The admission of an authenticated dispatch: the run and input schemas, the signals caps, idempotency keys, the
// installation, the manifest and the commit. The HTTP API's declared dispatch route authenticates the caller and
// decodes the body before it (apps/control-plane/test/control-plane.test.ts, packages/api).
import { describe, expect, it } from "vitest";
import {
  admit,
  authenticated,
  BASE,
  bodyOf,
  harness,
  HEAD,
  pullRequestPayload,
  REPO,
  refusal,
  signedWebhook,
} from "./harness.test-support.ts";
import { handleIntake } from "./routes.ts";

describe("dispatch validation", () => {
  it("[FD-INT-039] a dispatch of an unknown run answers 404 run_not_found", async () => {
    const h = await harness();
    expect(await refusal(h, authenticated({ run: "no-such-run" }))).toEqual({
      status: 404,
      code: "run_not_found",
    });
    expect(h.reads.calls).toEqual([]);
  });

  it("[FD-AGT-008] inputs holding a write credential answer 400 before admission writes any row", async () => {
    const h = await harness({
      settings: {
        writeCredentialIn: (inputs) =>
          JSON.stringify(inputs).includes("ghs_") ? "steps[0]" : null,
      },
    });
    expect(
      await refusal(
        h,
        authenticated({ inputs: { sha: HEAD, steps: [`echo ghs_${"t".repeat(36)}`] } }),
      ),
    ).toEqual({ status: 400, code: "invalid_inputs" });
    expect(h.executions()).toEqual([]);
    expect(h.records()).toEqual([]);
    expect(h.rows("select * from placements")).toEqual([]);
    expect(h.sheds()).toEqual([
      { scope_id: REPO, run: "check", reason: "credential in payload: inputs.steps[0]" },
    ]);
  });

  it("[FD-INT-040] inputs that fail the run's input schema answer 400 invalid_inputs", async () => {
    const h = await harness();
    expect(await refusal(h, authenticated({ inputs: { steps: 1 } }))).toEqual({
      status: 400,
      code: "invalid_inputs",
    });
    expect(h.executions()).toEqual([]);
  });

  it("[FD-INT-010] [FD-INT-003] a reused Idempotency-Key with the same body is a duplicate, with another body 409 conflict", async () => {
    const h = await harness();
    const body = { inputs: { sha: HEAD }, label: "ci" };
    const keyed = (inputs: { sha: string }) =>
      authenticated({ inputs, idempotency: { key: "build-7", body: { ...body, inputs } } });
    const first = await admit(h, keyed({ sha: HEAD }));
    const same = await admit(h, keyed({ sha: HEAD }));
    const other = await refusal(h, keyed({ sha: BASE }));
    expect(same).toEqual({ ...first, duplicate: true });
    expect(other).toEqual({ status: 409, code: "conflict", executionId: first.executionId });
    expect(h.rows("select canonical, request_digest from dedup_keys")).toEqual([
      {
        canonical: `idem:${REPO}:build-7`,
        request_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });

  it("[FD-INT-049] more than 50 merged signals or an over-long field answers 400 invalid_signals", async () => {
    const h = await harness();
    const signal = { source: "lint", title: "t" };
    const many = await refusal(
      h,
      authenticated({
        inputs: { sha: HEAD, signals: Array(30).fill(signal) },
        signals: Array(21).fill(signal),
      }),
    );
    const long = [];
    for (const s of [
      { source: "s".repeat(121), title: "t" },
      { source: "s", title: "t".repeat(201) },
      { source: "s", title: "t", detail: "d".repeat(2001) },
      { source: "s", title: "t", url: "u".repeat(1001) },
    ])
      long.push(await refusal(h, authenticated({ signals: [s] })));
    expect([many, ...long]).toEqual(Array(5).fill({ status: 400, code: "invalid_signals" }));
    expect(h.executions()).toEqual([]);
  });
});

describe("dispatch to admission", () => {
  it("[FD-INT-001] an admitted dispatch answers its execution id and class", async () => {
    const h = await harness();
    const admitted = await admit(h, authenticated());
    expect(admitted).toEqual({
      executionId: expect.any(String),
      className: "interactive",
      duplicate: false,
    });
    expect(h.executions()).toEqual([
      {
        id: admitted.executionId,
        scope_id: REPO,
        run: "check",
        class: "interactive",
        status: "pending",
      },
    ]);
  });

  it("[FD-INT-009] a second dispatch of the same run and commit is a duplicate of the first", async () => {
    const h = await harness();
    const first = await admit(h, authenticated({ sha: HEAD }));
    const second = await admit(h, authenticated({ sha: HEAD }));
    expect(second).toEqual({ ...first, duplicate: true });
  });

  it("[FD-INT-041] a dispatch with no ref and no commit pins the default branch head", async () => {
    const h = await harness();
    await admit(
      h,
      authenticated({ ref: undefined, caller: { kind: "access", id: "dev@example.com" } }),
    );
    expect(h.records()[0]).toMatchObject({
      sha: BASE,
      ref: "refs/heads/main",
      caller: "dev@example.com",
    });
  });

  it("[FD-INT-042] [FD-INT-043] the installation resolves from the repository; a repository no installation covers answers 422", async () => {
    const h = await harness();
    await admit(h, authenticated());
    expect(h.records()[0]!.installation).toBe(7);
    expect(h.reads.calls).toContain(`installation ${REPO}`);
    const none = await harness({ installations: {} });
    expect(await refusal(none, authenticated())).toEqual({
      status: 422,
      code: "installation_not_found",
    });
    expect(none.executions()).toEqual([]);
  });

  it("[FD-IFC-009] an Actions token naming one commit cannot dispatch another commit that is not a branch head of its repository; the refusal is 403 forbidden", async () => {
    const h = await harness();
    const foreign = "e".repeat(40);
    expect(await refusal(h, authenticated({ sha: foreign, vouchedSha: BASE }))).toEqual({
      status: 403,
      code: "forbidden",
    });
    expect(h.executions()).toEqual([]);
    const same = await admit(h, authenticated({ sha: BASE, vouchedSha: BASE }));
    expect(same.duplicate).toBe(false);
  });

  it("[FD-IFC-028] [FD-INT-015] a run the manifest does not list for dispatch answers 404 run_not_found", async () => {
    const h = await harness();
    const unlisted = await refusal(h, authenticated({ run: "nightly", label: null }));
    const label = await refusal(h, authenticated({ label: "nightly" }));
    expect([unlisted, label]).toEqual([
      { status: 404, code: "run_not_found" },
      { status: 404, code: "run_not_found" },
    ]);
    expect(h.executions()).toEqual([]);
  });

  it("[FD-IFC-033] a class input reaches class resolution", async () => {
    const h = await harness();
    await admit(h, authenticated({ classInput: "batch" }));
    expect(h.recorded.resolved[0]).toMatchObject({ classInput: "batch", trigger: "dispatch" });
    expect(h.recorded.resolved[0]!.caller).toMatchObject({ kind: "actions-oidc" });
  });

  it("[FD-INT-063] an MCP call's class above the assigned one is dropped to the assigned class", async () => {
    const h = await harness({
      resolve: (r) => ({ _tag: "Class", class: r.classInput ?? "batch", labels: [], alarm: null }),
    });
    const admitted = await admit(
      h,
      authenticated({
        trigger: "mcp",
        caller: { kind: "access", id: "dev@example.com" },
        classInput: "interactive",
      }),
    );
    expect(admitted.className).toBe("batch");
  });
});

describe("the route group", () => {
  it("[FD-INT-064] a served path with another method answers 405; an unserved path is the router's 404", async () => {
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
    for (const path of ["other", "dispatch/check"])
      expect(
        await h.run(
          handleIntake(new Request(`https://cp.example.com/v1/${path}`, { method: "POST" }), path),
        ),
      ).toBeNull();
  });

  it("[FD-INT-065] a defect answers 500 internal with a request id and no exception text", async () => {
    const h = await harness({
      settings: {
        catalog: () => {
          throw new Error("secret detail");
        },
      },
    });
    const r = await h.run(
      handleIntake(await signedWebhook("pull_request", pullRequestPayload()), "webhooks/github"),
    );
    expect(r!.status).toBe(500);
    expect(await bodyOf(r)).toEqual({
      error: "internal",
      message: "internal error",
      request_id: expect.any(String),
    });
  });
});
