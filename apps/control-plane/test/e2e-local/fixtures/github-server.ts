// The recorded GitHub fixture server of the e2e-local stack. It answers every request the control plane addresses to
// GitHub, and stands in for GitHub towards the control plane:
//
// - the Actions OIDC issuer: `token.actions.githubusercontent.com/.well-known/jwks`, under a key this server holds;
// - the Actions runtime's token endpoint, which a job with `id-token: write` reads its OIDC token from;
// - webhook deliveries: the recorded payloads of `recordings/`, signed with the deployment's webhook secret;
// - the REST API: a stack without an App credential reads its repository from the development repository binding, so
//   the server holds no REST state. A stack with one hands the server its recorded state (`intake-github.json`): the
//   App, the installation that covers each repository, and each repository's branches and files. The server checks
//   the App JWT and each installation token as GitHub does. Any REST call the state does not answer gets 404 and is
//   listed in `unrecorded`, so a test can assert it made none.
import { createHmac, randomBytes, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { makeSigner, type Signer } from "@fractalboxdev/flare-dispatch-api/test-support";

export const ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const ACTIONS_HOST = new URL(ACTIONS_ISSUER).host;
const API_HOST = "api.github.com";
const TOKEN_PATH = "/_actions/token";

const RECORDINGS = join(import.meta.dirname, "recordings");

/** One request this server answered, as GitHub would have received it. */
export interface GithubCall {
  readonly method: string;
  readonly host: string;
  readonly path: string;
}

/** The job an Actions OIDC token names: its repository, commit and ref. */
export interface ActionsJob {
  readonly repository: string;
  readonly sha: string;
  readonly ref?: string;
  readonly workflow?: string;
}

/** One repository as the App's installation sees it. */
export interface RecordedRepository {
  readonly installation: number;
  readonly default_branch: string;
  /** Each branch's head commit. */
  readonly branches: Readonly<Record<string, string>>;
  /** Each file at every branch head, as the JSON value its text encodes. */
  readonly files: Readonly<Record<string, unknown>>;
}

/** GitHub's state as the App reads it: the App's id and the repositories its installations cover. */
export interface GithubState {
  readonly app: { readonly id: string };
  readonly repositories: Readonly<Record<string, RecordedRepository>>;
}

/** A recorded state, and the public key of the App the control plane signs its App JWTs with. */
export interface GithubAppFixture {
  readonly state: GithubState;
  readonly publicKey: KeyObject;
}

/** A write the control plane made to the REST API, with its JSON body. */
export interface GithubWrite extends GithubCall {
  readonly body: unknown;
}

/** What `oidcToken` changes of a well-formed token: claims replaced or added, and header fields. */
export interface TokenOverrides {
  readonly claims?: Record<string, unknown>;
  readonly header?: Record<string, unknown>;
}

export interface GithubFixtureServer {
  /** This server's own origin, which the runtime token endpoint is served under. */
  readonly origin: string;
  /** What the Actions runtime hands a job with `id-token: write`: the token request URL and its request token. */
  readonly oidcRequest: (job: ActionsJob) => { readonly url: string; readonly token: string };
  /** An Actions OIDC token for a job and an audience, signed by the issuer key this server publishes. */
  readonly oidcToken: (
    job: ActionsJob,
    audience: string,
    overrides?: TokenOverrides,
  ) => Promise<string>;
  /** The key id of the issuer key this server publishes in its JWKS. */
  readonly issuerKid: string;
  /** Answers one request addressed to GitHub; the stack routes the Worker's outbound requests here. */
  readonly handle: (request: Request) => Promise<Response>;
  /** A recorded webhook delivery with its GitHub headers, the body signed with `secret`. */
  readonly delivery: (
    event: string,
    recording: string,
    secret: string,
    patch?: (payload: Record<string, unknown>) => Record<string, unknown>,
  ) => { readonly headers: Record<string, string>; readonly body: string };
  readonly calls: readonly GithubCall[];
  /** Every REST write the recorded state answered, in order. */
  readonly writes: readonly GithubWrite[];
  readonly unrecorded: readonly GithubCall[];
  readonly close: () => Promise<void>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const readRecording = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(RECORDINGS, name), "utf8")) as Record<string, unknown>;

const toRequest = async (req: IncomingMessage, origin: string): Promise<Request> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers))
    if (typeof value === "string") headers.set(name, value);
  return new Request(new URL(req.url ?? "/", origin), {
    method: req.method ?? "GET",
    headers,
    ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
  });
};

const send = async (res: ServerResponse, response: Response) => {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
};

const notFound = () => json(404, { message: "Not Found" });

const bearerOf = (request: Request) =>
  /^bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];

/** The issuer of an App JWT whose RS256 signature verifies under the App's key and whose `exp` has not passed. */
const appJwtIssuer = (jwt: string | undefined, key: KeyObject): string | undefined => {
  const [header, payload, signature] = jwt?.split(".") ?? [];
  if (header === undefined || payload === undefined || signature === undefined) return undefined;
  const signed = verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    key,
    Buffer.from(signature, "base64url"),
  );
  if (!signed) return undefined;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    readonly iss?: unknown;
    readonly exp?: unknown;
  };
  return typeof claims.iss === "string" &&
    typeof claims.exp === "number" &&
    claims.exp > Date.now() / 1000
    ? claims.iss
    : undefined;
};

/** The REST API over a recorded state; `undefined` for a call the state does not answer. */
const restApi = (app: GithubAppFixture, writes: GithubWrite[]) => {
  const { state, publicKey } = app;
  /** Each installation token minted, and the installation it acts for. */
  const tokens = new Map<string, number>();
  let checkRuns = 0;
  const repository = (owner: string, name: string) =>
    Object.entries(state.repositories).find(
      ([fullName]) => fullName.toLowerCase() === `${owner}/${name}`.toLowerCase(),
    );
  const isApp = (request: Request) => appJwtIssuer(bearerOf(request), publicKey) === state.app.id;
  const badJwt = () => json(401, { message: "A JSON web token could not be decoded" });

  return async (request: Request, url: URL, call: GithubCall): Promise<Response | undefined> => {
    const installationOf = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url.pathname);
    if (installationOf !== null && request.method === "GET") {
      if (!isApp(request)) return badJwt();
      const found = repository(installationOf[1]!, installationOf[2]!);
      return found === undefined
        ? notFound()
        : json(200, { id: found[1].installation, app_id: Number(state.app.id) });
    }
    const minting = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (minting !== null && request.method === "POST") {
      if (!isApp(request)) return badJwt();
      const installation = Number(minting[1]);
      if (!Object.values(state.repositories).some((r) => r.installation === installation))
        return notFound();
      const token = `ghs_e2e${installation}${randomBytes(12).toString("hex")}`;
      tokens.set(token, installation);
      return json(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    const scoped = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (scoped === null) return undefined;
    const bearer = bearerOf(request);
    const installation = bearer === undefined ? undefined : tokens.get(bearer);
    if (installation === undefined) return json(401, { message: "Bad credentials" });
    const found = repository(scoped[1]!, scoped[2]!);
    // GitHub hides a repository from an installation token that does not cover it.
    if (found === undefined || found[1].installation !== installation) return notFound();
    const [fullName, repo] = found;
    const rest = scoped[3] ?? "";
    const heads = new Set(Object.values(repo.branches));
    const branch = /^\/branches\/([^/]+)$/.exec(rest)?.[1];
    const rules = /^\/rules\/branches\/([^/]+)$/.exec(rest)?.[1];
    const protection = /^\/branches\/([^/]+)\/protection\/required_status_checks$/.exec(rest)?.[1];
    const content = /^\/contents\/(.+)$/.exec(rest)?.[1];
    if (request.method === "GET" && rest === "")
      return json(200, {
        full_name: fullName,
        default_branch: repo.default_branch,
        private: false,
      });
    if (request.method === "GET" && branch !== undefined) {
      const sha = repo.branches[decodeURIComponent(branch)];
      return sha === undefined
        ? json(404, { message: "Branch not found" })
        : json(200, { name: decodeURIComponent(branch), commit: { sha }, protected: false });
    }
    // The recorded repositories hold no branch rules and no classic protection.
    if (request.method === "GET" && rules !== undefined) return json(200, []);
    if (request.method === "GET" && protection !== undefined)
      return json(404, { message: "Branch not protected" });
    if (request.method === "GET" && content !== undefined) {
      const ref = url.searchParams.get("ref");
      if (ref === null || !(ref in repo.branches || heads.has(ref))) return undefined;
      const path = decodeURIComponent(content);
      if (!Object.hasOwn(repo.files, path)) return notFound();
      const text = JSON.stringify(repo.files[path]);
      return json(200, {
        type: "file",
        name: path.split("/").at(-1),
        path,
        size: Buffer.byteLength(text),
        encoding: "base64",
        content: Buffer.from(text).toString("base64"),
      });
    }
    if (request.method === "POST" && rest === "/check-runs") {
      const body = (await request.json()) as Record<string, unknown>;
      writes.push({ ...call, body });
      checkRuns += 1;
      return json(201, {
        id: checkRuns,
        name: body["name"],
        head_sha: body["head_sha"],
        external_id: body["external_id"] ?? null,
        status: body["status"] ?? "queued",
        conclusion: body["conclusion"] ?? null,
        output: body["output"] ?? { title: null, summary: null },
      });
    }
    return undefined;
  };
};

/** The fixture server; with `app`, it also answers the REST API from the recorded state. */
export const startGithubFixtureServer = async (
  app?: GithubAppFixture,
): Promise<GithubFixtureServer> => {
  const issuer: Signer = await makeSigner("e2e-actions-issuer");
  const calls: GithubCall[] = [];
  const writes: GithubWrite[] = [];
  const unrecorded: GithubCall[] = [];
  const rest = app === undefined ? undefined : restApi(app, writes);
  /** Each request token the runtime handed out, and the job it belongs to. */
  const requestTokens = new Map<string, ActionsJob>();
  let origin = "";

  const oidcToken = (job: ActionsJob, audience: string, overrides: TokenOverrides = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const ref = job.ref ?? "refs/heads/main";
    const workflow = job.workflow ?? ".github/workflows/ci.yml";
    return issuer.sign(
      {
        iss: ACTIONS_ISSUER,
        aud: audience,
        sub: `repo:${job.repository}:ref:${ref}`,
        repository: job.repository,
        repository_owner: job.repository.split("/")[0],
        ref,
        sha: job.sha,
        workflow_ref: `${job.repository}/${workflow}@${ref}`,
        iat: now,
        nbf: now,
        exp: now + 600,
        ...overrides.claims,
      },
      overrides.header,
    );
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const host = url.host === new URL(origin).host ? "runtime" : url.host;
    const call = { method: request.method, host, path: `${url.pathname}${url.search}` };
    calls.push(call);
    if (host === ACTIONS_HOST && url.pathname === "/.well-known/jwks")
      return json(200, { keys: [issuer.jwk] });
    if (host === "runtime" && url.pathname === TOKEN_PATH) {
      const bearer = bearerOf(request);
      const job = bearer === undefined ? undefined : requestTokens.get(bearer);
      const audience = url.searchParams.get("audience");
      if (job === undefined || audience === null) return json(401, { message: "Bad credentials" });
      return json(200, { value: await oidcToken(job, audience) });
    }
    const answer =
      host === API_HOST && rest !== undefined ? await rest(request, url, call) : undefined;
    if (answer !== undefined) return answer;
    unrecorded.push(call);
    return notFound();
  };

  const server: Server = createServer((req, res) => {
    void toRequest(req, origin)
      .then(handle)
      .then((response) => send(res, response))
      .catch((e: unknown) => res.writeHead(500).end(String(e)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  return {
    origin,
    oidcRequest: (job) => {
      const token = randomBytes(16).toString("hex");
      requestTokens.set(token, job);
      return { url: `${origin}${TOKEN_PATH}?api-version=2.0`, token };
    },
    oidcToken,
    issuerKid: issuer.kid,
    handle,
    delivery: (event, recording, secret, patch = (p) => p) => {
      const body = JSON.stringify(patch(readRecording(recording)));
      const signature = createHmac("sha256", secret).update(body).digest("hex");
      return {
        headers: {
          "content-type": "application/json",
          "user-agent": "GitHub-Hookshot/e2e",
          "x-github-event": event,
          "x-github-delivery": crypto.randomUUID(),
          "x-hub-signature-256": `sha256=${signature}`,
        },
        body,
      };
    },
    calls,
    writes,
    unrecorded,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};
