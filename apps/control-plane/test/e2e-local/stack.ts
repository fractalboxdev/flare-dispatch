// The e2e-local stack's cloud path on one machine (specs/verification.md § V-E2E-LOCAL): the control plane Worker on
// workerd through Miniflare, configured by its own `wrangler.jsonc` rendered from an operator overlay through the one
// renderer; the test's Access team; and the recorded GitHub fixture server, which answers every request the Worker
// addresses to GitHub. Clients reach the Worker over HTTP through a front that records each request it forwards.
//
// The deployment is `development`. By default it has the development repository binding, as `pnpm ci:local` runs it: the
// stack holds no GitHub App key, so the Worker reads its repository from that binding and applies nothing to GitHub.
// Started with a recorded GitHub state, the stack instead holds an App key of its own and no repository binding, so the
// Worker reads and writes GitHub through the App, and the fixture server answers from that state. Executors are the
// test's own signed WebSockets (`../support.ts`); no container runs.
import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { decodeOverlay, type OverlayValues } from "@fractalboxdev/flare-dispatch-ops/overlay";
import { renderTemplate, stripJsonc } from "@fractalboxdev/flare-dispatch-ops/render";
import { Effect } from "effect";
import { build } from "esbuild";
import {
  fetch as mfFetch,
  Miniflare,
  type Request as MfRequest,
  Response as MfResponse,
} from "miniflare";
import { AUD, OPERATOR, startAccessTeam, type AccessTeam } from "../support.ts";
import {
  startGithubFixtureServer,
  type GithubFixtureServer,
  type GithubState,
} from "./fixtures/github-server.ts";

const APP = join(import.meta.dirname, "../..");

/** The repository the stack's GitHub holds: its manifest lists `check` for dispatch, MCP dispatch and pull requests. */
export const REPOSITORY = "acme/widgets";
/** Its default branch head, which is the head of the recorded pull request too. */
export const HEAD = "1".repeat(40);
export const WEBHOOK_SECRET = "e2e-webhook-secret";
export const OIDC_AUDIENCE = "e2e-control-plane";
export const PLANE_ID = "e2e-plane";
/** The link key log and artifact link tokens are signed under (FD-IFC-018). */
export const LINK_KEY = "e2e-link-key";
/** The secret compile-cache tokens derive from (FD-CACHE-057). */
export const COMPILE_CACHE_SECRET = "e2e-compile-cache-secret";

const MANIFEST = {
  version: 1,
  runs: [
    {
      recipe: "check",
      triggers: ["dispatch", "mcp", "pull_request"],
      params: { steps: [{ label: "test", command: "pnpm test", timeoutSec: 600 }] },
    },
  ],
};

const DEV_REPOSITORY = {
  repository: REPOSITORY,
  installation: 41000001,
  default_branch: "main",
  head: HEAD,
  confidentiality: "non-confidential",
  files: {
    ".github/flare-dispatch.json": Buffer.from(JSON.stringify(MANIFEST)).toString("base64"),
  },
};

/** The overlay the stack deploys with: the placeholder values, with the stack's own Access team, plane and App id. */
const overlayFor = (team: AccessTeam, appId: string) =>
  Effect.runSync(
    decodeOverlay(
      JSON.stringify({
        accountId: "00000000000000000000000000000000",
        d1: { DB: "00000000-0000-0000-0000-000000000000" },
        kv: { CONFIG: "00000000000000000000000000000000" },
        r2: { CACHE: "e2e-cache", ARTIFACTS: "e2e-artifacts" },
        hostnames: { dispatcher: "dispatch.example.com", docs: "docs.example.com" },
        access: { teamDomain: team.teamDomain, aud: AUD },
        operators: [OPERATOR],
        dispatchers: [OPERATOR],
        github: { appId, fixtureRepo: REPOSITORY },
        dispatch: { oidcAudience: OIDC_AUDIENCE },
        executors: { planeId: PLANE_ID },
        alerts: { sink: "https://alerts.example.com/hook" },
      }),
    ),
  );

/** The parts of the rendered `wrangler.jsonc` Miniflare reads. */
export interface RenderedConfig {
  readonly vars: Readonly<Record<string, unknown>>;
  readonly d1_databases: readonly { readonly binding: string }[];
  readonly kv_namespaces?: readonly { readonly binding: string }[];
  readonly r2_buckets?: readonly { readonly binding: string }[];
  readonly durable_objects: {
    readonly bindings: readonly { readonly name: string; readonly class_name: string }[];
  };
  readonly containers?: readonly { readonly class_name: string }[];
  readonly compatibility_date: string;
}

const render = (overlay: OverlayValues): RenderedConfig => {
  const template = readFileSync(join(APP, "wrangler.jsonc"), "utf8");
  const rendered = Effect.runSync(renderTemplate("control-plane", template, overlay));
  return JSON.parse(stripJsonc(rendered)) as RenderedConfig;
};

let bundle: Promise<string> | undefined;

/** The Worker as `wrangler deploy` bundles it: one ES module from `src/worker.ts`. */
const workerScript = () =>
  (bundle ??= build({
    entryPoints: [join(APP, "src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  }).then((out) => out.outputFiles[0]!.text));

/** One request a client sent the Worker. */
export interface StackRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface Stack {
  /** The Worker's origin as clients reach it: the recording front. */
  readonly url: string;
  readonly mf: Miniflare;
  readonly overlay: OverlayValues;
  readonly config: RenderedConfig;
  readonly team: AccessTeam;
  readonly github: GithubFixtureServer;
  /** Every request the front forwarded, in order. */
  readonly requests: readonly StackRequest[];
  /** Headers carrying an Access JWT for `identity`; none for `null`. */
  readonly access: (identity: string | null) => Promise<Record<string, string>>;
  readonly close: () => Promise<void>;
}

/** Headers that describe one connection, not the message; the front sets its own. */
const HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "expect",
  "host",
]);

/**
 * The front: forwards each client request to the Worker unchanged, recording it. It streams each request and response
 * body through without collecting it, so a body reaches the Worker, and the client, as it is sent.
 */
const startFront = async (requests: StackRequest[]) => {
  let target: URL | undefined;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (target === undefined) throw new Error("the Worker is not ready");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers))
        if (typeof value === "string" && !HOP_HEADERS.has(name)) headers[name] = value;
      const method = req.method ?? "GET";
      requests.push({ method, path: req.url ?? "/", headers });
      const length = req.headers["content-length"];
      const hasBody =
        req.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
      const response = await fetch(new URL(req.url ?? "/", target), {
        method,
        headers,
        redirect: "manual",
        ...(hasBody
          ? { body: Readable.toWeb(req) as unknown as ReadableStream, duplex: "half" }
          : {}),
      } as RequestInit);
      // `fetch` has already decoded an encoded body, so its encoding and length headers no longer describe it.
      const decoded = response.headers.has("content-encoding");
      const out = Object.fromEntries(
        [...response.headers].filter(
          ([name]) =>
            !HOP_HEADERS.has(name) &&
            !(decoded && (name === "content-encoding" || name === "content-length")),
        ),
      );
      res.writeHead(response.status, out);
      if (response.body === null) res.end();
      else await pipeline(Readable.fromWeb(response.body as never), res);
    })().catch((e: unknown) => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end(String(e));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`,
    forwardTo: (origin: URL) => {
      target = origin;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const GITHUB_HOSTS: ReadonlySet<string> = new Set([
  "api.github.com",
  "github.com",
  "token.actions.githubusercontent.com",
]);

export interface StackOptions {
  /** GitHub's recorded state: the Worker holds an App key and reads and writes GitHub through the App. */
  readonly github?: GithubState;
  /**
   * The Worker's `PUBLIC_ORIGIN` is the front's URL, so the links and endpoints it hands out (a lease's compile-cache
   * endpoint, say) reach it. Without it the Worker has no public origin, as the rendered configuration gives none.
   */
  readonly publicOrigin?: boolean;
}

/** An App key pair, as the operator's `GITHUB_APP_PRIVATE_KEY` secret holds the private half. */
const appKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    publicKey,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
};

export const startStack = async (options: StackOptions = {}): Promise<Stack> => {
  const team = await startAccessTeam();
  const key = options.github === undefined ? undefined : appKey();
  const github = await startGithubFixtureServer(
    options.github === undefined || key === undefined
      ? undefined
      : { state: options.github, publicKey: key.publicKey },
  );
  const overlay = overlayFor(team, options.github?.app.id ?? "0");
  const config = render(overlay);
  const containerClasses = new Set((config.containers ?? []).map((c) => c.class_name));
  const requests: StackRequest[] = [];
  const front = await startFront(requests);
  const vars = Object.fromEntries(
    Object.entries(config.vars).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: await workerScript() }],
    compatibilityDate: config.compatibility_date,
    host: "127.0.0.1",
    port: 0,
    d1Databases: config.d1_databases.map((d) => d.binding),
    kvNamespaces: (config.kv_namespaces ?? []).map((k) => k.binding),
    r2Buckets: (config.r2_buckets ?? []).map((r) => r.binding),
    // A container-backed pool needs a container engine; `wrangler dev` builds none (`dev.enable_containers`).
    durableObjects: Object.fromEntries(
      config.durable_objects.bindings
        .filter((b) => !containerClasses.has(b.class_name))
        .map((b) => [b.name, { className: b.class_name, useSQLite: true }]),
    ),
    bindings: {
      ...vars,
      // What `wrangler dev` for local work overrides, and the Worker secrets `fd deploy` would set.
      DEPLOYMENT: "development",
      ...(key === undefined
        ? { FD_DEV_REPOSITORY: JSON.stringify(DEV_REPOSITORY) }
        : { GITHUB_APP_PRIVATE_KEY: key.privateKeyPem }),
      WEBHOOK_SECRET,
      CACHE_TOKEN_SECRET: "e2e-cache-token-secret",
      COMPILE_CACHE_SECRET,
      LINK_KEY,
      ...(options.publicOrigin === true ? { PUBLIC_ORIGIN: front.url } : {}),
      // The template renders neither; the overlay holds both (`dispatchers`, `dispatch.oidcAudience`).
      DISPATCHERS: JSON.stringify(overlay.dispatchers ?? []),
      DISPATCH_OIDC_AUDIENCE: overlay.dispatch?.oidcAudience ?? "",
    },
    // Every request the Worker addresses to GitHub reaches the fixture server; anything else (the Access team's keys)
    // goes out as addressed.
    outboundService: async (request: MfRequest) => {
      const host = new URL(request.url).host;
      if (!GITHUB_HOSTS.has(host)) return mfFetch(request);
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
      const answer = await github.handle(
        new Request(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          ...(body === undefined ? {} : { body }),
        }),
      );
      return new MfResponse(await answer.arrayBuffer(), {
        status: answer.status,
        headers: Object.fromEntries(answer.headers),
      });
    },
  });
  front.forwardTo(await mf.ready);
  return {
    url: front.url,
    mf,
    overlay,
    config,
    team,
    github,
    requests,
    access: async (identity): Promise<Record<string, string>> =>
      identity === null ? {} : { "cf-access-jwt-assertion": await team.jwt(identity) },
    close: async () => {
      await front.close();
      await mf.dispose();
      await github.close();
      await team.close();
    },
  };
};
