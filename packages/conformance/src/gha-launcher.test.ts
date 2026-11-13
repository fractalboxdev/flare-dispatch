// FlareDispatch's `gha` launcher on mameko's launcher port (specs/executors.md § The GitHub Actions launcher,
// specs/executor-protocol.md § `gha` sockets), against an Actions API stand-in over HTTP that also serves the Actions
// issuer's JWKS, with its launches in a Miniflare D1. `start` dispatches the runner workflow the overlay names for one
// (execution, epoch); `verify` answers `true` only for the runner job's OIDC token of the launch it names, once.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ACTIONS_JWKS,
  d1GhaLaunches,
  ghaLauncherLayer,
  installationQuotaLayer,
  JwksSource,
  JwksUnavailable,
  type GhaLauncherConfig,
} from "@fractalboxdev/flare-dispatch-github";
import { Launcher, type LeaseRef } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  makeActionsSigner,
  runnerClaims,
  type ActionsSigner,
} from "../../github/src/gha.test-support.ts";

const CONFIG: GhaLauncherConfig = {
  installation: 41,
  runnerRepo: "acme/fd-runners",
  workflow: "runner.yml",
  branch: "main",
  audience: "https://dispatch.example.com",
};

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

let server: Server;
let base = "";
let signer: ActionsSigner;
let mf: Miniflare;
const seen: Seen[] = [];
let nextRun = 5_000;

beforeAll(async () => {
  signer = await makeActionsSigner();
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "GET",
        path,
        body: raw === "" ? undefined : JSON.parse(raw),
      });
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (path === "/.well-known/jwks") return reply(200, { keys: [signer.jwk] });
      if (req.method === "POST" && path.endsWith("/dispatches"))
        return reply(200, { workflow_run_id: nextRun++, run_url: "", html_url: "" });
      if (req.method === "POST" && path.endsWith("/cancel")) return reply(202, {});
      reply(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    compatibilityDate: "2026-05-01",
    d1Databases: ["DB"],
  });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  await new Promise((resolve) => server?.close(resolve));
});

beforeEach(() => {
  seen.length = 0;
});

/** GitHub's Actions JWKS, read over HTTP from the stand-in. */
const jwksOverHttp = Layer.succeed(JwksSource)({
  keys: (url) =>
    url !== ACTIONS_JWKS
      ? Effect.fail(new JwksUnavailable({ url }))
      : Effect.tryPromise({
          try: async () =>
            ((await (await fetch(`${base}/.well-known/jwks`)).json()) as { keys: never[] }).keys,
          catch: () => new JwksUnavailable({ url }),
        }),
});

/** One isolate's launcher port, over the shared D1. */
const launcher = async () =>
  ghaLauncherLayer({
    fetch: globalThis.fetch,
    baseUrl: base,
    token: () => Effect.succeed("ghs_runner_repo_installation"),
    config: CONFIG,
    launches: d1GhaLaunches(await mf.getD1Database("DB")),
  }).pipe(Layer.provide(Layer.merge(installationQuotaLayer(), jwksOverHttp)));

const onPort = <A>(layer: Layer.Layer<Launcher>, f: (l: Launcher["Service"]) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* Launcher);
    }).pipe(Effect.provide(layer)),
  );

const lease = (executionId: string, epoch: number): LeaseRef => ({
  executionId,
  epoch,
  scopeId: "scope",
  deadlineAt: Date.now() + 20 * 60_000 + 30_000,
});

describe("gha launcher on the launcher port", () => {
  it("[FD-EXEC-085] start on the gha launcher port starts one workflow_dispatch run of the overlay's runner workflow, in its runner repository, for that (execution, epoch)", async () => {
    const port = await launcher();
    expect(await onPort(port, (l) => Effect.succeed(l.kind))).toBe("gha");
    await onPort(port, (l) => l.start(lease("exec-085", 2)));
    await onPort(port, (l) => l.start(lease("exec-085b", 1)));
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/repos/acme/fd-runners/actions/workflows/runner.yml/dispatches",
        body: {
          ref: "main",
          inputs: { execution_id: "exec-085", epoch: "2", deadline_minutes: "20" },
          return_run_details: true,
        },
      },
      {
        method: "POST",
        path: "/repos/acme/fd-runners/actions/workflows/runner.yml/dispatches",
        body: {
          ref: "main",
          inputs: { execution_id: "exec-085b", epoch: "1", deadline_minutes: "20" },
          return_run_details: true,
        },
      },
    ]);
  });

  it("[FD-PROTO-014] verify answers true only for an Actions OIDC token that passes the audience, runner workflow and single-claim checks, and only for the (execution_id, epoch) its launch named", async () => {
    const port = await launcher();
    await onPort(port, (l) => l.start(lease("exec-a", 1)));
    const runA = nextRun - 1;
    await onPort(port, (l) => l.start(lease("exec-b", 3)));
    const runB = nextRun - 1;
    const verify = async (claim: unknown, layer = port) => onPort(layer, (l) => l.verify(claim));
    const sign = (runId: number, overrides: Record<string, unknown> = {}) =>
      signer.sign(runnerClaims(runId, overrides, CONFIG));

    // Each failing check alone refuses the claim.
    const refused = [
      await sign(runA, { aud: "https://other.example.com" }),
      await sign(runA, { repository: "acme/other" }),
      await sign(runA, {
        workflow_ref: "acme/fd-runners/.github/workflows/other.yml@refs/heads/main",
      }),
      await sign(runA, {
        workflow_ref: "acme/fd-runners/.github/workflows/runner.yml@refs/heads/dev",
      }),
      await sign(runB),
      await sign(runA + 1_000),
    ];
    for (const token of refused)
      expect(await verify({ executionId: "exec-a", epoch: 1, token })).toBe(false);
    const tokenA = await sign(runA);
    // The launch's token names no other (execution, epoch).
    expect(await verify({ executionId: "exec-a", epoch: 2, token: tokenA })).toBe(false);
    expect(await verify({ executionId: "exec-b", epoch: 3, token: tokenA })).toBe(false);
    expect(await verify({ executionId: "exec-unlaunched", epoch: 1, token: tokenA })).toBe(false);
    expect(await verify({ executionId: "exec-a", epoch: 1, token: tokenA })).toBe(true);
    // A second claim of that launch, through this isolate or another, is refused.
    expect(await verify({ executionId: "exec-a", epoch: 1, token: tokenA })).toBe(false);
    expect(await verify({ executionId: "exec-a", epoch: 1, token: tokenA }, await launcher())).toBe(
      false,
    );
    // The other launch's own token still claims its own lease, once.
    const tokenB = await sign(runB);
    expect(await verify({ executionId: "exec-b", epoch: 3, token: tokenB }, await launcher())).toBe(
      true,
    );
    expect(await verify({ executionId: "exec-b", epoch: 3, token: tokenB })).toBe(false);
    expect(seen.filter((s) => s.path === "/.well-known/jwks").length).toBeGreaterThan(0);
  });
});
