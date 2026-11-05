// The router on workerd through Miniflare, with the D1 Layers behind it: the way the control plane Worker mounts it.
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accessClaims,
  actionsClaims,
  AUD,
  DISPATCHER,
  makeSigner,
  MEMBER,
  OIDC_AUD,
  OPERATOR,
  TEAM,
  type Signer,
} from "./api.test-support.ts";
import { ACTIONS_JWKS, accessIssuer } from "./identity.ts";

let mf: Miniflare;
let access: Signer;
let actions: Signer;

const SHA = "c".repeat(40);

beforeAll(async () => {
  access = await makeSigner("access-kid");
  actions = await makeSigner("actions-kid");
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "testing/worker.fixture.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: bundle.outputFiles[0]!.text }],
    compatibilityDate: "2026-05-01",
    d1Databases: { DB: "control-plane" },
    durableObjects: { EPOCH_ANCHOR: { className: "EpochAnchor", useSQLite: true } },
    bindings: {
      DEPLOYMENT: "development",
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      OPERATORS: JSON.stringify([OPERATOR]),
      DISPATCHERS: JSON.stringify([DISPATCHER]),
      DISPATCH_OIDC_AUDIENCE: OIDC_AUD,
      PLANE_ID: "flare-dispatch",
      PUBLIC_ORIGIN: "https://dispatcher.example.com",
      LINK_KEY: "link-key-for-tests",
      TEST_JWKS: JSON.stringify({
        [`${accessIssuer(TEAM)}/cdn-cgi/access/certs`]: [access.jwk],
        [ACTIONS_JWKS]: [actions.jwk],
      }),
    },
  });
  await mf.ready;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

interface Init {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

const as = async (email: string, init: Init = {}) => ({
  ...init,
  headers: { ...init.headers, "cf-access-jwt-assertion": await access.sign(accessClaims(email)) },
});

const checkInputs = {
  repo: "https://github.com/acme/widgets",
  sha: SHA,
  ref: "main",
  steps: [{ label: "test", command: "pnpm test" }],
};

describe("the router on workerd", () => {
  it("FD-IFC-010: a gated route needs an Access identity on workerd too", async () => {
    const response = await mf.dispatchFetch("http://x/v1/executions");
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("unauthenticated");
  });

  it("FD-IFC-024, FD-IFC-035, FD-IFC-036, FD-IFC-038: an Actions dispatch is admitted once, and the record reads back", async () => {
    const jwt = await actions.sign(actionsClaims("acme/widgets", { sha: SHA }));
    const dispatch = () =>
      mf.dispatchFetch("http://x/v1/dispatch/check", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ repository: "acme/widgets", inputs: checkInputs }),
      });
    const first = await dispatch();
    expect(first.status).toBe(202);
    const admitted = (await first.json()) as Record<string, string>;
    expect(admitted["details_url"]).toContain(`/executions/${admitted["execution_id"]}?t=`);
    const second = (await (await dispatch()).json()) as Record<string, unknown>;
    expect(second).toMatchObject({ execution_id: admitted["execution_id"], duplicate: true });

    const view = (await (
      await mf.dispatchFetch(`http://x/v1/executions/${admitted["execution_id"]}`, await as(MEMBER))
    ).json()) as Record<string, unknown>;
    expect(view).toMatchObject({
      execution_id: admitted["execution_id"],
      run: "check",
      repository: "acme/widgets",
      status: "queued",
      placement: "queued",
      verdict: null,
      advisory: false,
    });
    expect(view).not.toHaveProperty("inputs");

    const page = (await (
      await mf.dispatchFetch("http://x/v1/executions?status=queued", await as(MEMBER))
    ).json()) as {
      executions: { execution_id: string }[];
    };
    expect(page.executions.map((e) => e.execution_id)).toContain(admitted["execution_id"]);
  });

  it("FD-IFC-029: inputs that fail the run's schema answer 400 invalid_inputs", async () => {
    const response = await mf.dispatchFetch(
      "http://x/v1/dispatch/check",
      await as(DISPATCHER, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repository: "acme/widgets",
          inputs: { ...checkInputs, sha: "short" },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_inputs");
  });

  it("FD-IFC-028: a run outside the catalog answers 404 run_not_found", async () => {
    const response = await mf.dispatchFetch(
      "http://x/v1/dispatch/no-such-run",
      await as(DISPATCHER, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repository: "acme/widgets", inputs: {} }),
      }),
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("run_not_found");
  });

  it("FD-IFC-086, FD-IFC-087: registration writes through registerDevice, and a refused key answers registration_refused", async () => {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const spki = Buffer.from(
      new Uint8Array((await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer),
    ).toString("base64");
    const register = async (keyStore: string, publicKey: string) =>
      mf.dispatchFetch(
        "http://x/v1/executors/register",
        await as(OPERATOR, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            executor_id: `dev-${keyStore}`,
            labels: [],
            protocol_version: "1",
            code_hash: null,
            identity: {
              public_key: publicKey,
              key_store: keyStore,
              certificate_chain: [],
              evidence: null,
            },
          }),
        }),
      );
    const ok = await register("software", spki);
    expect(ok.status).toBe(201);
    const refused = await register("secure-enclave", spki);
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error: string; message: string };
    expect(body.error).toBe("registration_refused");
    expect(body.message).toContain("key-store");
  });

  it("FD-IFC-051: with no OIDC key the well-known routes answer 503 not_configured", async () => {
    expect((await mf.dispatchFetch("http://x/.well-known/jwks.json")).status).toBe(503);
  });
});
