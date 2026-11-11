// The recorded GitHub fixture server of the e2e-local stack. It answers every request the control plane addresses to
// GitHub, and stands in for GitHub towards the control plane:
//
// - the Actions OIDC issuer: `token.actions.githubusercontent.com/.well-known/jwks`, under a key this server holds;
// - the Actions runtime's token endpoint, which a job with `id-token: write` reads its OIDC token from;
// - webhook deliveries: the recorded payloads of `recordings/`, signed with the deployment's webhook secret;
// - the REST API: the stack holds no App credential, so the control plane reads its repository from the development
//   repository binding; any REST call answers 404 and is listed in `unrecorded`, so a test can assert it made none.
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { makeSigner, type Signer } from "@fractalboxdev/flare-dispatch-api/test-support";

export const ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const ACTIONS_HOST = new URL(ACTIONS_ISSUER).host;
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

export interface GithubFixtureServer {
  /** This server's own origin, which the runtime token endpoint is served under. */
  readonly origin: string;
  /** What the Actions runtime hands a job with `id-token: write`: the token request URL and its request token. */
  readonly oidcRequest: (job: ActionsJob) => { readonly url: string; readonly token: string };
  /** An Actions OIDC token for a job and an audience, signed by the issuer key this server publishes. */
  readonly oidcToken: (job: ActionsJob, audience: string) => Promise<string>;
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

export const startGithubFixtureServer = async (): Promise<GithubFixtureServer> => {
  const issuer: Signer = await makeSigner("e2e-actions-issuer");
  const calls: GithubCall[] = [];
  const unrecorded: GithubCall[] = [];
  /** Each request token the runtime handed out, and the job it belongs to. */
  const requestTokens = new Map<string, ActionsJob>();
  let origin = "";

  const oidcToken = (job: ActionsJob, audience: string) => {
    const now = Math.floor(Date.now() / 1000);
    const ref = job.ref ?? "refs/heads/main";
    const workflow = job.workflow ?? ".github/workflows/ci.yml";
    return issuer.sign({
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
    });
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const host = url.host === new URL(origin).host ? "runtime" : url.host;
    const call = { method: request.method, host, path: `${url.pathname}${url.search}` };
    calls.push(call);
    if (host === ACTIONS_HOST && url.pathname === "/.well-known/jwks")
      return json(200, { keys: [issuer.jwk] });
    if (host === "runtime" && url.pathname === TOKEN_PATH) {
      const bearer = /^bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      const job = bearer === undefined ? undefined : requestTokens.get(bearer);
      const audience = url.searchParams.get("audience");
      if (job === undefined || audience === null) return json(401, { message: "Bad credentials" });
      return json(200, { value: await oidcToken(job, audience) });
    }
    unrecorded.push(call);
    return json(404, { message: "Not Found" });
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
    unrecorded,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};
