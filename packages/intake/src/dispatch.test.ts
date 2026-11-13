// The admission of an authenticated dispatch: the run and input schemas, the signals caps, idempotency keys, the
// installation, the manifest and the commit. The HTTP API's declared dispatch route authenticates the caller and
// decodes the body before it (apps/control-plane/test/control-plane.test.ts, packages/api).
import { describe, expect, it } from "vitest";
import {
  admit,
  authenticated,
  BASE,
  bodyOf,
  CATALOG,
  harness,
  HEAD,
  manifest,
  pullRequestPayload,
  REPO,
  refusal,
  repoWithManifest,
  signedWebhook,
  testRun,
} from "./harness.test-support.ts";
import { catalogRuns } from "./catalog.ts";
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

describe("a self-heal-pr dispatch", () => {
  const incident = (over: Record<string, unknown> = {}) => ({
    contractVersion: "v1",
    incidentId: "ci-acme-app-1",
    class: "ci",
    repo: REPO,
    repro: { kind: "command", command: "pnpm test" },
    ...over,
  });
  const selfHeal = async () =>
    harness({
      settings: { catalog: catalogRuns("production") },
      repos: {
        [REPO]: repoWithManifest(manifest([{ recipe: "self-heal-pr", triggers: ["dispatch"] }])),
      },
    });
  const dispatch = (inputs: unknown) =>
    authenticated({ run: "self-heal-pr", label: null, sha: HEAD, inputs });

  it("[FD-AGT-063] without an incident/v1 pack of class ci with a command repro answers 400 before any read or row", async () => {
    const h = await selfHeal();
    const refused = [
      {},
      { incident: incident({ class: "application" }) },
      { incident: incident({ class: "demo" }) },
      { incident: incident({ repro: { kind: "derived", command: "pnpm test" } }) },
      { incident: incident({ repro: { kind: "none" } }) },
      { incident: incident({ repro: { kind: "command" } }) },
      { incident: incident({ repro: { kind: "command", command: "  " } }) },
      { incident: incident({ repro: undefined }) },
    ];
    for (const inputs of refused)
      expect(await refusal(h, dispatch(inputs)), JSON.stringify(inputs)).toEqual({
        status: 400,
        code: "invalid_inputs",
      });
    expect(h.reads.calls).toEqual([]);
    expect(h.executions()).toEqual([]);
    expect(h.records()).toEqual([]);
  });

  it("[FD-AGT-063] with a ci pack whose repro is a command is admitted", async () => {
    const h = await selfHeal();
    const admitted = await admit(h, dispatch({ incident: incident() }));
    expect(admitted.duplicate).toBe(false);
    expect(h.executions()).toMatchObject([{ id: admitted.executionId, run: "self-heal-pr" }]);
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

describe("a scoped dispatch", () => {
  const SCANNER = { kind: "access", id: "scan-bot.access" } as const;

  it("[FD-IFC-091] a scoped dispatcher's classCeiling reaches class resolution, and caps the class resolveClass assigns", async () => {
    const recording = await harness();
    await admit(recording, authenticated({ caller: SCANNER, classCeiling: "batch" }));
    await admit(recording, authenticated({ caller: SCANNER, sha: BASE }));
    expect(recording.recorded.resolved.map((r) => r.classCeiling)).toEqual(["batch", null]);

    const profile = await harness({ profileResolver: true });
    const capped = await admit(profile, authenticated({ caller: SCANNER, classCeiling: "batch" }));
    const uncapped = await admit(profile, authenticated({ caller: SCANNER, sha: BASE }));
    expect([capped.className, uncapped.className]).toEqual(["batch", "interactive"]);
  });

  it("[FD-IFC-091] an MCP call's assigned class is resolved under the caller's classCeiling", async () => {
    const h = await harness();
    await admit(
      h,
      authenticated({ trigger: "mcp", caller: SCANNER, classCeiling: "batch", classInput: null }),
    );
    expect(h.recorded.resolved.map((r) => [r.trigger, r.classCeiling])).toEqual([
      ["mcp", "batch"],
      ["mcp", "batch"],
    ]);
  });
});

describe("a dispatch of a read-only scan run", () => {
  const SCAN_MANIFEST = manifest([
    { recipe: "check", label: "ci", triggers: ["dispatch"], params: { steps: ["test"] } },
    { recipe: "scan", triggers: ["dispatch"] },
  ]);
  const scanHarness = () =>
    harness({
      settings: {
        catalog: (name) =>
          name === "scan" ? testRun("scan", { readOnlyScan: true }) : CATALOG[name],
      },
      repos: { [REPO]: repoWithManifest(SCAN_MANIFEST) },
    });
  const scan = (over: Parameters<typeof authenticated>[0] = {}) =>
    authenticated({ run: "scan", label: null, ...over });

  it("[FD-IFC-092] with no Idempotency-Key answers 400 invalid_idempotency_key before any read or row", async () => {
    const h = await scanHarness();
    expect(await refusal(h, scan())).toEqual({ status: 400, code: "invalid_idempotency_key" });
    expect(h.reads.calls).toEqual([]);
    expect(h.executions()).toEqual([]);
    expect(h.records()).toEqual([]);
    const keyed = await admit(
      h,
      scan({ idempotency: { key: "scan-1", body: { repository: REPO, inputs: { sha: HEAD } } } }),
    );
    expect(keyed.duplicate).toBe(false);
    expect(h.executions()).toMatchObject([{ id: keyed.executionId, run: "scan" }]);
    // A run that is not a read-only scan run takes a dispatch with no key.
    expect((await admit(h, authenticated())).duplicate).toBe(false);
  });

  it("[FD-IFC-092] security-rescan is the catalogue's read-only scan run, and a dispatch of it with no key answers 400", async () => {
    const production = catalogRuns("production");
    expect(production("security-rescan")?.readOnlyScan).toBe(true);
    expect(production("security-gate")?.readOnlyScan).toBeUndefined();
    expect(production("check")?.readOnlyScan).toBeUndefined();
    const h = await harness({ settings: { catalog: production } });
    expect(
      await refusal(
        h,
        authenticated({ run: "security-rescan", label: null, inputs: { sha: HEAD } }),
      ),
    ).toEqual({ status: 400, code: "invalid_idempotency_key" });
    expect(h.reads.calls).toEqual([]);
  });

  it("[FD-IFC-092] [FD-IFC-074] an MCP dispatch with no Idempotency-Key answers 400 invalid_idempotency_key, as the HTTP route does", async () => {
    const h = await scanHarness();
    expect(await refusal(h, scan({ trigger: "mcp" }))).toEqual({
      status: 400,
      code: "invalid_idempotency_key",
    });
    expect(h.reads.calls).toEqual([]);
    expect(h.executions()).toEqual([]);
    expect(h.records()).toEqual([]);
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
