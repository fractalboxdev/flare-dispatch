// Doubles for the `gha` launcher: a throwaway RSA key standing in for GitHub's Actions OIDC issuer, the Actions API's
// `workflow_dispatch` and cancel endpoints, and a launcher over a SQLite D1 that several launchers may share.
import type { webcrypto } from "node:crypto";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Launcher, type LeaseRef } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { commentDatabase } from "./comment-writes.test-support.ts";
import { d1GhaLaunches, ghaLauncherLayer, type GhaLauncherConfig } from "./gha-launcher.ts";
import { ACTIONS_ISSUER, ACTIONS_JWKS, JwksSource, type Jwk } from "./jwks.ts";
import { installationQuotaLayer } from "./rate-limit.ts";

export const RUNNER_CONFIG: GhaLauncherConfig = {
  installation: 77,
  runnerRepo: "acme/fd-runners",
  workflow: "runner.yml",
  branch: "main",
  audience: "https://dispatch.example.com",
};

export const INSTALLATION_TOKEN = "ghs_installation_token_for_runner_repo";

const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export interface ActionsSigner {
  readonly jwk: Jwk;
  readonly sign: (claims: Readonly<Record<string, unknown>>) => Promise<string>;
}

/** An RS256 key pair that signs tokens as GitHub's Actions issuer would. */
export const makeActionsSigner = async (kid = "actions-key"): Promise<ActionsSigner> => {
  const keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as { readonly publicKey: webcrypto.CryptoKey; readonly privateKey: webcrypto.CryptoKey };
  const exported = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as {
    readonly n?: string;
    readonly e?: string;
  };
  return {
    jwk: { kid, kty: "RSA", alg: "RS256", n: exported.n!, e: exported.e! },
    sign: async (claims) => {
      const signing = `${segment({ alg: "RS256", typ: "JWT", kid })}.${segment(claims)}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keys.privateKey,
        new TextEncoder().encode(signing),
      );
      return `${signing}.${Buffer.from(signature).toString("base64url")}`;
    },
  };
};

/** The claims of the runner job's OIDC token for workflow run `runId`, as GitHub issues them. */
export const runnerClaims = (
  runId: string | number,
  overrides: Readonly<Record<string, unknown>> = {},
  config: GhaLauncherConfig = RUNNER_CONFIG,
): Record<string, unknown> => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ACTIONS_ISSUER,
    aud: config.audience,
    sub: `repo:${config.runnerRepo}:ref:refs/heads/${config.branch}`,
    repository: config.runnerRepo,
    ref: `refs/heads/${config.branch}`,
    workflow_ref: `${config.runnerRepo}/.github/workflows/${config.workflow}@refs/heads/${config.branch}`,
    run_id: String(runId),
    run_attempt: "1",
    iat: now,
    exp: now + 300,
    ...overrides,
  };
};

export interface ActionsRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

export interface FakeActionsApi {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: ActionsRequest[];
  /** The workflow run id each dispatch answers, in dispatch order. */
  readonly runIds: number[];
  /** Answers every dispatch with this status and no run, when set. */
  refuseWith: number | undefined;
}

/** GitHub's Actions API for the runner repository: each dispatch answers a new workflow run id. */
export const fakeActionsApi = (firstRunId = 9_000): FakeActionsApi => {
  let next = firstRunId;
  const api: FakeActionsApi = {
    requests: [],
    runIds: [],
    refuseWith: undefined,
    fetch: async (input, init) => {
      const url = String(input);
      const raw = init?.body;
      const headers = new Headers(init?.headers);
      api.requests.push({
        method: init?.method ?? "GET",
        url,
        authorization: headers.get("authorization"),
        body: typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined,
      });
      if (api.refuseWith !== undefined)
        return Response.json({ message: "refused" }, { status: api.refuseWith });
      if (url.endsWith("/dispatches")) {
        const id = next++;
        api.runIds.push(id);
        return Response.json({ workflow_run_id: id, run_url: "", html_url: "" });
      }
      if (url.endsWith("/cancel")) return Response.json({}, { status: 202 });
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  };
  return api;
};

export interface LauncherHarness {
  readonly db: D1Like;
  readonly api: FakeActionsApi;
  readonly signer: ActionsSigner;
  /** A launcher on the shared D1: each call is a separate isolate's launcher. */
  readonly launcher: () => Layer.Layer<Launcher>;
  readonly start: (lease: LeaseRef, launcher?: Layer.Layer<Launcher>) => Promise<void>;
  readonly cancel: (executionId: string, epoch: number) => Promise<void>;
  readonly verify: (claims: unknown, launcher?: Layer.Layer<Launcher>) => Promise<boolean>;
}

export const launcherHarness = async (
  options: {
    readonly config?: GhaLauncherConfig;
    readonly signer?: ActionsSigner;
    readonly api?: FakeActionsApi;
  } = {},
): Promise<LauncherHarness> => {
  const db = commentDatabase();
  const api = options.api ?? fakeActionsApi();
  const signer = options.signer ?? (await makeActionsSigner());
  const config = options.config ?? RUNNER_CONFIG;
  const jwks = Layer.succeed(JwksSource)({
    keys: (url) => Effect.succeed(url === ACTIONS_JWKS ? [signer.jwk] : []),
  });
  const launcher = () =>
    ghaLauncherLayer({
      fetch: api.fetch,
      token: () => Effect.succeed(INSTALLATION_TOKEN),
      config,
      launches: d1GhaLaunches(db),
    }).pipe(Layer.provide(Layer.merge(installationQuotaLayer(), jwks)));
  const shared = launcher();
  const run = <A>(f: (l: Launcher["Service"]) => Effect.Effect<A>, layer = shared) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* f(yield* Launcher);
      }).pipe(Effect.provide(layer)),
    );
  return {
    db,
    api,
    signer,
    launcher,
    start: (lease, layer) => run((l) => l.start(lease), layer),
    cancel: (executionId, epoch) => run((l) => l.cancel(executionId, epoch)),
    verify: (claims, layer) => run((l) => l.verify(claims), layer),
  };
};
