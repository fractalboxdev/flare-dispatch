import { issueOidcToken, type OidcKeys } from "@fractalboxdev/flare-dispatch-cache/oidc";
import { parseProvenanceKey } from "@fractalboxdev/flare-dispatch-cache/provenance";
import {
  POLICY_PAYLOAD_TYPE,
  type KeysInUse,
} from "@fractalboxdev/flare-dispatch-cache/provenance-policy";
import {
  memoryPolicyStores,
  type MemoryPolicyStores,
} from "@fractalboxdev/flare-dispatch-cache/provenance-policy-test-support";
import { Context, Effect, Layer } from "effect";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  actionsClaims,
  DISPATCHER,
  makeHarness,
  MEMBER,
  OPERATOR,
  ORIGIN,
  record,
  type Harness,
} from "../api.test-support.ts";
import { INCIDENT_CAPS } from "../declaration.ts";
import { apiError } from "../errors.ts";
import { provenancePolicies } from "../live/provenance-policy.ts";
import { ProvenancePolicies } from "../ports.ts";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
beforeEach(() => {
  h.doubles.intake = (s) =>
    Effect.succeed({ _tag: "Admitted", executionId: "01JNEW", class: s.class ?? "batch" });
});

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const dispatch = async (run: string, body: unknown, headers: Record<string, string> = {}) => {
  const jwt = await h.actions.sign(actionsClaims("acme/widgets"));
  return h.fetch(`/v1/dispatch/${run}`, post(body, { authorization: `Bearer ${jwt}`, ...headers }));
};

describe("dispatch", () => {
  it("[FD-IFC-028]: a run intake does not find answers 404 run_not_found", async () => {
    h.doubles.intake = () => Effect.fail(apiError("run_not_found", "no run named nope"));
    const response = await dispatch("nope", { repository: "acme/widgets", inputs: {} });
    expect(response.status).toBe(404);
    expect((await json(response))["error"]).toBe("run_not_found");
  });

  it("[FD-IFC-029]: inputs that fail the run's schema answer 400 invalid_inputs", async () => {
    h.doubles.intake = () =>
      Effect.fail(apiError("invalid_inputs", "inputs.sha: expected a commit"));
    const response = await dispatch("check", { repository: "acme/widgets", inputs: { sha: 1 } });
    expect(response.status).toBe(400);
    expect((await json(response))["error"]).toBe("invalid_inputs");
  });

  it("[FD-IFC-030]: signals over the signals/v1 caps answer 400 invalid_signals and reach no intake", async () => {
    const before = h.doubles.calls.submissions.length;
    const long = { source: "s".repeat(121), title: "t", detail: "d" };
    const many = Array.from({ length: 51 }, () => ({ source: "s", title: "t", detail: "d" }));
    for (const signals of [
      [long],
      many,
      [{ source: "s", title: "t", detail: "d", url: "u".repeat(1001) }],
    ]) {
      const response = await dispatch("check", { repository: "acme/widgets", inputs: {}, signals });
      expect(response.status).toBe(400);
      expect((await json(response))["error"]).toBe("invalid_signals");
    }
    expect(h.doubles.calls.submissions.length).toBe(before);
  });

  it("[FD-IFC-032]: a repository with no installation answers 422 installation_not_found", async () => {
    h.doubles.intake = () =>
      Effect.fail(apiError("installation_not_found", "no installation covers acme/widgets"));
    const response = await dispatch("check", { repository: "acme/widgets", inputs: {} });
    expect(response.status).toBe(422);
  });

  it("[FD-IFC-033]: a named class reaches intake as the class input, and the response carries the resolved class", async () => {
    h.doubles.intake = () =>
      Effect.succeed({ _tag: "Admitted", executionId: "01JNEW", class: "interactive" });
    const response = await dispatch("check", {
      repository: "acme/widgets",
      inputs: {},
      class: "batch",
    });
    expect(h.doubles.calls.submissions.at(-1)?.class).toBe("batch");
    expect((await json(response))["class"]).toBe("interactive");
  });

  it("[FD-IFC-036]: a duplicate answers 202 with the existing id and duplicate: true; a conflict 409 with it", async () => {
    h.doubles.intake = () =>
      Effect.succeed({ _tag: "Duplicate", executionId: "01JOLD", class: "batch" });
    const duplicate = await dispatch("check", { repository: "acme/widgets", inputs: {} });
    expect(duplicate.status).toBe(202);
    expect(await json(duplicate)).toMatchObject({ execution_id: "01JOLD", duplicate: true });
    h.doubles.intake = () =>
      Effect.fail(apiError("conflict", "the key names another body", { execution_id: "01JOLD" }));
    const conflict = await dispatch(
      "check",
      { repository: "acme/widgets", inputs: {} },
      { "idempotency-key": "k1" },
    );
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toMatchObject({ error: "conflict", execution_id: "01JOLD" });
  });

  it("[FD-INT-011]: an Idempotency-Key outside 1 to 128 of [A-Za-z0-9._:-] answers 400 invalid_idempotency_key", async () => {
    for (const key of ["has space", "k".repeat(129), "semi;colon"]) {
      const response = await dispatch(
        "check",
        { repository: "acme/widgets", inputs: {} },
        { "idempotency-key": key },
      );
      expect(response.status).toBe(400);
      expect((await json(response))["error"]).toBe("invalid_idempotency_key");
    }
    await dispatch(
      "check",
      { repository: "acme/widgets", inputs: { b: 1, a: 2 } },
      { "idempotency-key": "k.1:x-y_z" },
    );
    expect(h.doubles.calls.submissions.at(-1)?.idempotency).toEqual({
      key: "k.1:x-y_z",
      canonicalBody: '{"inputs":{"a":2,"b":1},"repository":"acme/widgets"}',
    });
  });

  it("a rate-limited admission answers 429 with Retry-After", async () => {
    h.doubles.intake = () =>
      Effect.fail(apiError("rate_limited", "capacity: queue full", { retry_after: 30 }));
    const response = await dispatch("check", { repository: "acme/widgets", inputs: {} });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
  });
});

describe("executions", () => {
  beforeEach(() => {
    h.doubles.executions.clear();
    for (let i = 0; i < 5; i++) {
      const id = `01JEXEC${i}`;
      h.doubles.executions.set(
        id,
        record({
          execution_id: id,
          status: i % 2 === 0 ? "done" : "running",
          finished_at: i % 2 === 0 ? 100 + i : null,
        }),
      );
    }
  });

  it("[FD-IFC-037]: the list filters, pages newest first and returns next_before while more rows exist", async () => {
    const since = await json(
      await h.fetch("/v1/executions?finished_since=102", await h.asAccess(MEMBER)),
    );
    expect((since["executions"] as { execution_id: string }[]).map((e) => e.execution_id)).toEqual([
      "01JEXEC4",
      "01JEXEC2",
    ]);
    expect(
      (await h.fetch("/v1/executions?finished_since=-1", await h.asAccess(MEMBER))).status,
    ).toBe(400);
    const first = await json(await h.fetch("/v1/executions?limit=2", await h.asAccess(MEMBER)));
    const ids = (first["executions"] as { execution_id: string }[]).map((e) => e.execution_id);
    expect(ids).toEqual(["01JEXEC4", "01JEXEC3"]);
    expect(first["next_before"]).toBe("01JEXEC3");
    const last = await json(
      await h.fetch("/v1/executions?limit=200&before=01JEXEC1", await h.asAccess(MEMBER)),
    );
    expect((last["executions"] as unknown[]).length).toBe(1);
    expect(last["next_before"]).toBeUndefined();
    const done = await json(await h.fetch("/v1/executions?status=done", await h.asAccess(MEMBER)));
    expect((done["executions"] as unknown[]).length).toBe(3);
    expect((await h.fetch("/v1/executions?limit=201", await h.asAccess(MEMBER))).status).toBe(400);
  });

  it("[FD-IFC-038], [FD-IFC-039]: each execution carries placement, executor, class, epoch, verdict, conclusion and costs, and no inputs", async () => {
    const view = await json(await h.fetch("/v1/executions/01JEXEC0", await h.asAccess(MEMBER)));
    for (const key of [
      "placement",
      "executor_id",
      "executor_kind",
      "class",
      "epoch",
      "verdict",
      "conclusion",
      "reserved_micro_usd",
      "settled_micro_usd",
      "finished_at",
    ])
      expect(view).toHaveProperty(key);
    expect(view).not.toHaveProperty("input_json");
    expect(view).not.toHaveProperty("inputs");
    expect(view).not.toHaveProperty("dispatchedBy");
  });

  it("[FD-IFC-040]: wait holds the response until the execution is done", async () => {
    setTimeout(() => {
      h.doubles.executions.set(
        "01JEXEC1",
        record({ execution_id: "01JEXEC1", status: "done", verdict: "success" }),
      );
    }, 700);
    const started = Date.now();
    const view = await json(
      await h.fetch("/v1/executions/01JEXEC1?wait=5", await h.asAccess(MEMBER)),
    );
    expect(view["status"]).toBe("done");
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("[FD-IFC-040]: a wait that ends before done answers the current status", async () => {
    const view = await json(
      await h.fetch("/v1/executions/01JEXEC3?wait=1", await h.asAccess(MEMBER)),
    );
    expect(view["status"]).toBe("running");
  });

  it("[FD-IFC-041]: a wait that is not a whole number from 1 to 60 answers 400 invalid_wait", async () => {
    for (const wait of ["0", "61", "1.5", "abc", "-1"]) {
      const response = await h.fetch(
        `/v1/executions/01JEXEC0?wait=${wait}`,
        await h.asAccess(MEMBER),
      );
      expect(response.status).toBe(400);
      expect((await json(response))["error"]).toBe("invalid_wait");
    }
  });

  it("[FD-IFC-042]: a failure summary is bounded to the incident/v1 caps and 16 KiB", async () => {
    const response = await h.fetch(
      "/v1/executions/01JEXEC0/failure-summary",
      await h.asAccess(MEMBER),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      INCIDENT_CAPS.serializedBytes,
    );
    const pack = JSON.parse(text) as { ciFailures: { logTail: string }[] };
    expect(pack.ciFailures[0]!.logTail.length).toBeLessThanOrEqual(INCIDENT_CAPS.logTail);
  });

  it("[FD-IFC-045]: a confidential-compute repository's failure summary carries only the reason and the failing step names", async () => {
    h.doubles.executions.set(
      "01JSECRET",
      record({ execution_id: "01JSECRET", repository: "acme/secret" }),
    );
    const summaryOf = async () =>
      JSON.parse(
        await (
          await h.fetch("/v1/executions/01JSECRET/failure-summary", await h.asAccess(MEMBER))
        ).text(),
      ) as Record<string, unknown>;
    // Any other mode serves the whole bounded pack.
    for (const mode of ["non-confidential", "unclassified", "confidential-model"] as const) {
      h.doubles.confidentiality.set("acme/secret", mode);
      const full = await summaryOf();
      expect(full).toHaveProperty("suspectFiles");
      expect(full["ciFailures"]).toEqual([
        expect.objectContaining({ logTail: expect.any(String) }),
      ]);
    }
    h.doubles.confidentiality.set("acme/secret", "confidential-compute");
    try {
      const pack = await summaryOf();
      expect(pack).toEqual({
        contractVersion: "v1",
        incidentId: "01JSECRET",
        class: "ci",
        repo: "acme/secret",
        ciFailures: [{ kind: "run-step", name: "test", conclusion: "failure" }],
      });
      expect(JSON.stringify(pack)).not.toContain("src/secret");
    } finally {
      h.doubles.confidentiality.delete("acme/secret");
    }
  });

  it("[FD-IFC-043]: a failure summary of an execution that did not fail answers 409 not_failed", async () => {
    h.doubles.executions.set("01JOK", record({ execution_id: "01JOK", verdict: "success" }));
    const response = await h.fetch(
      "/v1/executions/01JOK/failure-summary",
      await h.asAccess(MEMBER),
    );
    expect(response.status).toBe(409);
    expect((await json(response))["error"]).toBe("not_failed");
  });

  it("[FD-IFC-044]: a failure summary of an execution not done answers 409 not_finished", async () => {
    const response = await h.fetch(
      "/v1/executions/01JEXEC1/failure-summary",
      await h.asAccess(MEMBER),
    );
    expect(response.status).toBe(409);
    expect((await json(response))["error"]).toBe("not_finished");
  });

  it("[FD-IFC-046]: only the dispatcher or an operator may cancel", async () => {
    const path = "/v1/executions/01JEXEC1/cancel";
    const member = await h.fetch(path, await h.asAccess(MEMBER, { method: "POST" }));
    expect(member.status).toBe(403);
    expect(h.doubles.calls.cancels.length).toBe(0);
    expect((await h.fetch(path, await h.asAccess(DISPATCHER, { method: "POST" }))).status).toBe(
      202,
    );
    expect(
      (
        await h.fetch(
          "/v1/executions/01JEXEC3/cancel",
          await h.asAccess(OPERATOR, { method: "POST" }),
        )
      ).status,
    ).toBe(202);
    expect(h.doubles.calls.cancels.map((c) => c.identity)).toEqual([DISPATCHER, OPERATOR]);
  });

  it("[FD-IFC-059]: an Actions token reads its own repository's execution, and no other route or repository", async () => {
    h.doubles.executions.set(
      "01JOTHER",
      record({ execution_id: "01JOTHER", repository: "acme/other" }),
    );
    const bearer = {
      authorization: `Bearer ${await h.actions.sign(actionsClaims("acme/widgets"))}`,
    };
    expect((await h.fetch("/v1/executions/01JEXEC0", { headers: bearer })).status).toBe(200);
    const foreign = await h.fetch("/v1/executions/01JOTHER", { headers: bearer });
    expect(foreign.status).toBe(404);
    expect((await json(foreign))["error"]).toBe("execution_not_found");
    expect((await h.fetch("/v1/executions", { headers: bearer })).status).toBe(401);
    expect(
      (await h.fetch("/v1/executions/01JEXEC0/failure-summary", { headers: bearer })).status,
    ).toBe(401);
  });

  it("[FD-IFC-003]: an unauthenticated request looks up no execution", async () => {
    const before = h.doubles.calls.lookups.length;
    expect((await h.fetch("/v1/executions/01JEXEC0")).status).toBe(401);
    expect((await h.fetch("/v1/executions/01JEXEC0/cancel", { method: "POST" })).status).toBe(401);
    expect(h.doubles.calls.lookups.length).toBe(before);
  });
});

describe("operator routes", () => {
  it("[FD-IFC-083]: each operation passes the operator's identity, the reason and the request id through", async () => {
    const response = await h.fetch(
      "/v1/ops/halt",
      await h.asAccess(OPERATOR, post({ state: "halt-cloud", reason: "runaway spend" })),
    );
    expect(response.status).toBe(200);
    const result = await json(response);
    const { operation, call } = h.doubles.calls.operations.at(-1)!;
    expect(operation).toEqual({ _tag: "halt", state: "halt-cloud" });
    expect(call.identity).toBe(OPERATOR);
    expect(call.reason).toBe("runaway spend");
    expect(call.requestId).toBe(result["request_id"]);
  });

  it("[FD-IFC-047]: a reason the coordinator rejects answers 400 reason_required", async () => {
    const response = await h.fetch(
      "/v1/ops/drain",
      await h.asAccess(OPERATOR, post({ executor: "e1", reason: "" })),
    );
    expect(response.status).toBe(400);
    expect((await json(response))["error"]).toBe("reason_required");
  });

  it("[FD-IFC-049], [FD-IFC-050]: a failed store transaction answers 503 unavailable; a rejected expiry 400 invalid_body", async () => {
    const cases = [
      [apiError("unavailable", "the store transaction failed; nothing changed"), 503],
      [apiError("invalid_body", "expires_at: at most 7 days ahead"), 400],
    ] as const;
    for (const [failure, status] of cases) {
      h.doubles.opsFailure = failure;
      const response = await h.fetch(
        "/v1/ops/force-admit",
        await h.asAccess(OPERATOR, post({ execution_id: "x", expires_at: 1, reason: "stuck" })),
      );
      expect(response.status).toBe(status);
      expect((await json(response))["error"]).toBe(failure.error);
    }
    h.doubles.opsFailure = undefined;
  });

  it("[FD-OPS-077]: the operator routes are exactly the operations of the operator routes table", async () => {
    const { OpsGroup } = await import("../declaration.ts");
    const paths = Object.values(OpsGroup.endpoints)
      .map((e) => `${e.method} ${e.path}`)
      .sort();
    expect(paths).toEqual(
      [
        "GET /v1/ops/health",
        "POST /v1/ops/drain",
        "POST /v1/ops/force-admit",
        "POST /v1/ops/halt",
        "POST /v1/ops/pause-key",
        "POST /v1/ops/quarantine",
        "POST /v1/ops/release",
        "POST /v1/ops/resume-key",
        "POST /v1/ops/revoke",
        "POST /v1/ops/top-up",
      ].sort(),
    );
  });
});

const ecKey = async (kid: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = async (key: CryptoKey) => ({
    ...((await crypto.subtle.exportKey("jwk", key)) as JsonWebKey),
    kid,
  });
  return {
    private: (await jwk(pair.privateKey)) as OidcKeys["current"],
    public: (await jwk(pair.publicKey)) as OidcKeys["retired"][number]["jwk"],
  };
};

describe("well-known", () => {
  it("[FD-IFC-051]: the OIDC routes answer 503 not_configured while no key is set, and cache for an hour once one is", async () => {
    h.doubles.oidcKeys = undefined;
    expect((await h.fetch("/.well-known/jwks.json")).status).toBe(503);
    expect((await h.fetch("/.well-known/openid-configuration")).status).toBe(503);
    h.doubles.oidcKeys = { current: (await ecKey("k1")).private, retired: [] };
    const jwks = await h.fetch("/.well-known/jwks.json");
    expect(jwks.status).toBe(200);
    expect(jwks.headers.get("cache-control")).toBe("max-age=3600");
    const config = await h.fetch("/.well-known/openid-configuration");
    expect(config.headers.get("cache-control")).toBe("max-age=3600");
    expect((await json(config))["jwks_uri"]).toBe(
      "https://dispatcher.example.com/.well-known/jwks.json",
    );
  });

  it("[FD-IFC-052]: the JWKS carries no private key member", async () => {
    const current = (await ecKey("k2")).private;
    const retired = (await ecKey("k1")).private;
    const extra = { dp: "x", dq: "y", qi: "z", p: "p", q: "q", k: "k", oth: [] };
    h.doubles.oidcKeys = {
      current: { ...current, ...extra },
      retired: [{ jwk: { ...retired, ...extra }, retiredAt: Date.now() }],
    };
    const { keys } = (await (await h.fetch("/.well-known/jwks.json")).json()) as {
      keys: Record<string, unknown>[];
    };
    expect(keys).toHaveLength(2);
    for (const key of keys)
      for (const member of ["d", "p", "q", "dp", "dq", "qi", "k", "oth"])
        expect(key).not.toHaveProperty(member);
  });

  it("[FD-PROV-049] the served JWKS keeps a key retired by rotation for 3600 s, and a token it signed verifies under the advertised ES256", async () => {
    const [k0, k1, k2] = await Promise.all([ecKey("k0"), ecKey("k1"), ecKey("k2")]);
    const now = Date.now();
    // k1 signed a token just before it was retired; the token lives at most 3600 s.
    const token = await Effect.runPromise(
      issueOidcToken(
        { current: k1.private, retired: [] },
        ORIGIN,
        {
          run: "deploy",
          executionId: "e1",
          audience: "sts.amazonaws.com",
          ttlSec: 3600,
        },
        now - 3599_000,
      ),
    );
    h.doubles.oidcKeys = {
      current: k2.private,
      retired: [
        { jwk: k1.public, retiredAt: now - 3599_000 },
        { jwk: k0.public, retiredAt: now - 3601_000 },
      ],
    };
    const { keys } = (await (await h.fetch("/.well-known/jwks.json")).json()) as {
      keys: (JsonWebKey & { kid: string })[];
    };
    expect(keys.map((k) => k.kid)).toEqual(["k2", "k1"]);
    const config = await json(await h.fetch("/.well-known/openid-configuration"));
    const [header, payload, signature] = token.jwt.split(".") as [string, string, string];
    const { alg, kid } = JSON.parse(Buffer.from(header, "base64url").toString()) as {
      alg: string;
      kid: string;
    };
    expect(config["id_token_signing_alg_values_supported"]).toEqual([alg]);
    expect(alg).toBe("ES256");
    const served = keys.find((k) => k.kid === kid)!;
    expect(served.alg).toBe("ES256");
    const verifier = await crypto.subtle.importKey(
      "jwk",
      served,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifier,
        Buffer.from(signature, "base64url"),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
  });

  it("/health needs no identity", async () => {
    expect(await json(await h.fetch("/health"))).toEqual({ status: "ok" });
  });
});

describe("verification policy", () => {
  const POLICY_PATH = "/.well-known/flare-dispatch/provenance-policy.json";

  const policy = (version: string, overrides: Record<string, unknown> = {}) => ({
    policy_version: version,
    issued_at: 1_700_000_000_000,
    provenance_keys: [],
    logs: [{ kind: "private", keys: [] }],
    devices: [],
    required_tiers: {
      release: "reproduced",
      package: "platform",
      image: "platform",
      "pr-artifact": "platform",
      preview: "platform",
      verdict: "device-signed",
    },
    slsa_build_levels: { cloud: 3, "attested-dedicated": 2, "managed-workstation": 1 },
    ...overrides,
  });

  /** The operator's envelope; the policy root key's signature is the verifier's to check (FD-PROV-053). */
  const envelope = (p: Record<string, unknown>) => ({
    payloadType: POLICY_PAYLOAD_TYPE,
    payload: Buffer.from(JSON.stringify(p)).toString("base64"),
    signatures: [{ keyid: "policy-root", sig: "MEUCIQ==" }],
  });

  const publish = async (body: unknown) =>
    h.fetch(
      "/v1/provenance-policy",
      await h.asAccess(OPERATOR, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope: body }),
      }),
    );

  let stores: MemoryPolicyStores;

  /** The real publisher over in-memory stores, holding `keys`. */
  const holding = (keys: KeysInUse) => {
    h.doubles.provenancePolicies = Context.get(
      Effect.runSync(
        Layer.build(provenancePolicies(keys).pipe(Layer.provide(stores.layer))).pipe(Effect.scoped),
      ),
      ProvenancePolicies,
    );
  };

  beforeEach(() => {
    stores = memoryPolicyStores();
    holding({ provenance: undefined, log: undefined });
  });

  it("[FD-PROV-044] serves the current policy at the well-known path and every earlier version by its policy_version", async () => {
    expect((await h.fetch(POLICY_PATH)).status).toBe(404);
    const first = envelope(policy("v1"));
    const second = envelope(policy("v2"));
    expect((await publish(first)).status).toBe(200);
    expect(await json(await h.fetch(POLICY_PATH))).toEqual(first);
    expect((await publish(second)).status).toBe(200);
    const current = await h.fetch(POLICY_PATH);
    expect(current.status).toBe(200);
    expect(await json(current)).toEqual(second);
    expect(await json(await h.fetch(`${POLICY_PATH}?policy_version=v1`))).toEqual(first);
    expect(await json(await h.fetch(`${POLICY_PATH}?policy_version=v2`))).toEqual(second);
    const missing = await h.fetch(`${POLICY_PATH}?policy_version=v9`);
    expect(missing.status).toBe(404);
    expect((await json(missing))["error"]).toBe("not_found");
  });

  it("[FD-PROV-044] only an operator publishes a policy version", async () => {
    const body = JSON.stringify({ envelope: envelope(policy("v1")) });
    const init = { method: "PUT", headers: { "content-type": "application/json" }, body };
    expect((await h.fetch("/v1/provenance-policy", init)).status).toBe(401);
    expect((await h.fetch("/v1/provenance-policy", await h.asAccess(MEMBER, init))).status).toBe(
      403,
    );
    expect(stores.appended).toHaveLength(0);
  });

  it("[FD-PROV-046] a published version is in the transparency log before the route serves it", async () => {
    const body = envelope(policy("v1"));
    stores.failAppend = "the log is unreachable";
    const failed = await publish(body);
    expect(failed.status).toBe(503);
    expect((await json(failed))["error"]).toBe("unavailable");
    expect((await h.fetch(POLICY_PATH)).status).toBe(404);
    expect((await h.fetch(`${POLICY_PATH}?policy_version=v1`)).status).toBe(404);
    stores.failAppend = undefined;
    const published = await publish(body);
    expect(await json(published)).toMatchObject({ policy_version: "v1", log_index: 0 });
    expect(stores.appended.map((e) => JSON.parse(e) as unknown)).toEqual([body]);
    expect(await json(await h.fetch(POLICY_PATH))).toEqual(body);
  });

  it("[FD-PROV-052] refuses a policy that lets a managed-workstation builder claim a SLSA Build level above L1", async () => {
    const levels = { cloud: 3, "attested-dedicated": 3, "managed-workstation": 2 };
    const refused = await publish(envelope(policy("v1", { slsa_build_levels: levels })));
    expect(refused.status).toBe(400);
    expect(await json(refused)).toMatchObject({ error: "invalid_body" });
    expect(
      String(
        (await json(await publish(envelope(policy("v1", { slsa_build_levels: levels })))))[
          "message"
        ],
      ),
    ).toContain("slsa-level");
    expect(stores.appended).toHaveLength(0);
    expect((await h.fetch(POLICY_PATH)).status).toBe(404);
  });

  it("[FD-PROV-047] refuses a policy whose key history omits the provenance key the control plane holds", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    const key = parseProvenanceKey(JSON.stringify({ ...priv, kid: "prov-1" }))!;
    holding({ provenance: key, log: undefined });
    const omits = await publish(envelope(policy("v1")));
    expect(omits.status).toBe(400);
    expect(String((await json(omits))["message"])).toContain("drops key prov-1");
    const [entry] = stores.history.provenance;
    const keeps = await publish(envelope(policy("v1", { provenance_keys: [entry] })));
    expect(keeps.status).toBe(200);
    expect(await json(await h.fetch(POLICY_PATH))).toEqual(
      envelope(policy("v1", { provenance_keys: [entry] })),
    );
  });
});
