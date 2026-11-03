import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { CommandExit } from "./command.ts";
import { runDeploySmoke, SmokeHttp, deploymentStatusDecoder } from "./deploy-smoke.ts";
import type { DispatchEvent } from "./dispatch-event.ts";
import { attachGrants, CREDENTIAL_PLACEHOLDER, redactLog } from "./egress.ts";
import {
  ctx,
  fakeArtifacts,
  fakeExec,
  fakeGithub,
  fakeIntents,
  memoryLedger,
  OTHER_SHA,
  SHA,
} from "./gate.test-support.ts";
import type { DeploySmokeInput, WorkerDeployInput } from "./inputs.ts";
import { lookupRun } from "./spec.ts";
import { workerDeployDecoder, workerDeployDedupKey, workerDeploySerialGroup } from "./triggers.ts";
import { DeployLedger, fileDeployLedger, runWorkerDeploy } from "./worker-deploy.ts";

const deployInput = (over: Partial<WorkerDeployInput["entry"]> = {}): WorkerDeployInput => ({
  ...ctx,
  scope: "o/r",
  branch: "main",
  entry: { command: "pnpm wrangler deploy", grants: ["cf-api"], ...over },
});

const deploy = (
  input: WorkerDeployInput,
  options: {
    head?: string;
    script?: Parameters<typeof fakeExec>[0];
    ledger?: Layer.Layer<DeployLedger>;
  } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const exec = fakeExec(options.script ?? []);
      const intents = fakeIntents();
      const github = fakeGithub(options.head === undefined ? {} : { head: options.head });
      const outcome = yield* runWorkerDeploy(input).pipe(
        Effect.provide(
          Layer.mergeAll(
            exec.layer,
            fakeArtifacts().layer,
            intents.layer,
            github.layer,
            options.ledger ?? memoryLedger(),
          ),
        ),
      );
      return { outcome, exec, intents, github };
    }),
  );

const push = (ref: string): DispatchEvent => ({
  _tag: "webhook",
  deliveryId: "d1",
  delivery: {
    event: "push",
    action: "",
    repository: { fullName: "o/r", cloneUrl: ctx.repo, defaultBranch: "main" },
    ref,
    before: OTHER_SHA,
    after: SHA,
  },
});

describe("worker-deploy", () => {
  it("FD-GATE-061 declares the cloud-pinned constraint and no device executor", () => {
    const found = lookupRun("production", "worker-deploy");
    if (found._tag !== "Available") throw new Error("expected worker-deploy");
    expect(found.entry.spec.constraints).toEqual(["cloud-pinned"]);
    expect(found.entry.executors).toEqual(["cloud"]);
    expect(found.entry.spec.limits.qosClass).toBe("release");
  });

  it("FD-GATE-062 uses one commit-scoped dedup key for a push and a dispatch", () => {
    const decoded = workerDeployDecoder({ command: "x" })(push("refs/heads/main"));
    expect(Option.isSome(decoded)).toBe(true);
    expect(Option.isNone(workerDeployDecoder({ command: "x" })(push("refs/heads/dev")))).toBe(true);
    expect(
      Option.isSome(workerDeployDecoder({ command: "x", branch: "dev" })(push("refs/heads/dev"))),
    ).toBe(true);
    expect(workerDeployDedupKey("o/r", SHA)).toBe(`worker-deploy:o/r:${SHA}`);
    expect(workerDeployDedupKey("o/r", SHA, "api")).toBe(`worker-deploy:api:o/r:${SHA}`);
  });

  it("FD-GATE-063 serializes one repository, branch and label", () => {
    expect(workerDeploySerialGroup("o/r", "main")).toBe("worker-deploy:o/r@main");
    expect(workerDeploySerialGroup("o/r", "main", "api")).toBe("worker-deploy:o/r@main:api");
    const found = lookupRun("production", "worker-deploy");
    expect(found._tag === "Available" && found.entry.spec.serialize).toBe(true);
  });

  it("FD-GATE-064 reads the branch head before the deploy command", async () => {
    const { github, exec } = await deploy(deployInput());
    expect(github.reads).toEqual(["head main"]);
    expect(exec.ran.map((r) => r.command)).toContain("pnpm wrangler deploy");
  });

  it("FD-GATE-065 cancels with superseded: branch head moved and runs no deploy", async () => {
    const { outcome, exec } = await deploy(deployInput(), { head: OTHER_SHA });
    expect(outcome).toEqual({ _tag: "cancelled", cause: "superseded: branch head moved" });
    expect(exec.ran).toEqual([]);
    const allowed = await deploy(deployInput({ requireHead: false }), { head: OTHER_SHA });
    expect(allowed.outcome).toEqual({ _tag: "success" });
  });

  it("FD-GATE-066 gives the job a placeholder, and the proxy alone attaches the cf-api credential", async () => {
    const { exec } = await deploy(deployInput());
    const env = exec.ran.find((r) => r.command === "pnpm wrangler deploy")!.env;
    expect(env["CLOUDFLARE_API_TOKEN"]).toBe(CREDENTIAL_PLACEHOLDER);
    const secret = "cf-secret-value-123456";
    const outbound = attachGrants(
      new Request("https://api.cloudflare.com/client/v4/accounts", {
        headers: { authorization: `Bearer ${CREDENTIAL_PLACEHOLDER}` },
      }),
      ["cf-api"],
      () => secret,
    );
    expect(outbound.headers.get("authorization")).toBe(`Bearer ${secret}`);
    const elsewhere = attachGrants(
      new Request("https://example.com/", { headers: { authorization: "Bearer stolen" } }),
      ["cf-api"],
      () => secret,
    );
    expect(elsewhere.headers.get("authorization")).toBeNull();
    const plain = attachGrants(new Request("http://api.cloudflare.com/"), ["cf-api"], () => secret);
    expect(plain.headers.get("authorization")).toBeNull();
    expect(redactLog(`calling with ${secret}`, [secret])).toBe("calling with [redacted]");
  });

  it("FD-GATE-067 starts the deploy command at most once in an epoch", async () => {
    const ledger = memoryLedger();
    const first = await deploy(deployInput(), { ledger });
    const replay = await deploy(deployInput(), { ledger });
    expect(first.outcome).toEqual({ _tag: "success" });
    expect(replay.outcome).toEqual({ _tag: "failure", reason: "infra: DeployAlreadyStarted" });
    expect(replay.exec.ran).toEqual([]);
    const root = mkdtempSync(join(tmpdir(), "fd-ledger-"));
    try {
      const claims = await Effect.runPromise(
        Effect.gen(function* () {
          const l = yield* DeployLedger;
          return [yield* l.claim("01J:2"), yield* l.claim("01J:2"), yield* l.claim("01J:3")];
        }).pipe(Effect.provide(fileDeployLedger(root))),
      );
      expect(claims).toEqual([true, false, true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FD-GATE-068 runs the deploy with timeoutSec, 900 s by default, and sets FD_BRANCH and FD_BRANCH_HEAD_SHA", async () => {
    const { exec } = await deploy(deployInput());
    const run = exec.ran.find((r) => r.command === "pnpm wrangler deploy")!;
    expect(run.timeoutMs).toBe(900_000);
    expect(run.env).toMatchObject({ FD_BRANCH: "main", FD_BRANCH_HEAD_SHA: SHA });
    const custom = await deploy(deployInput({ timeoutSec: 120 }));
    expect(custom.exec.ran.find((r) => r.command === "pnpm wrangler deploy")!.timeoutMs).toBe(
      120_000,
    );
    expect((await deploy(deployInput({ timeoutSec: 1801 }))).outcome).toEqual({
      _tag: "failure",
      reason: "config: timeoutSec",
    });
  });

  it("FD-GATE-069 emits one dispatch.followOn for deploy-smoke on the same commit after success", async () => {
    const ok = await deploy(deployInput());
    expect(ok.intents.emitted).toEqual([
      {
        kind: "dispatch.followOn",
        key: "deploy-smoke:0",
        payload: { run: "deploy-smoke", repository: "o/r", sha: SHA, ref: ctx.ref },
      },
    ]);
    const failed = await deploy(deployInput(), {
      script: [{ match: "wrangler", exit: CommandExit.Exited({ code: 1 }) }],
    });
    expect(failed.outcome).toEqual({ _tag: "failure", reason: "exit: 1" });
    expect(failed.intents.emitted).toEqual([]);
  });
});

const smokeInput = (over: Partial<DeploySmokeInput> = {}): DeploySmokeInput => ({
  scope: "o/r",
  sha: SHA,
  hosts: ["app.example.com"],
  ...over,
});

const smoke = (input: DeploySmokeInput, answer: (url: string) => Response | Error) => {
  const requested: string[] = [];
  const layer = Layer.succeed(SmokeHttp, {
    fetch: async (url, init) => {
      requested.push(url);
      expect(init.redirect).toBe("manual");
      const a = answer(url);
      if (a instanceof Error) throw a;
      return a;
    },
  });
  return Effect.runPromise(
    runDeploySmoke(input, { intervalMs: 1 }).pipe(Effect.provide(layer)),
  ).then((outcome) => ({ outcome, requested }));
};

describe("deploy-smoke", () => {
  const status = (
    delivery: Partial<Extract<DispatchEvent, { _tag: "webhook" }>["delivery"]>,
  ): DispatchEvent =>
    ({
      _tag: "webhook",
      deliveryId: "d2",
      delivery: {
        event: "deployment_status",
        action: "created",
        repository: { fullName: "o/r", cloneUrl: ctx.repo, defaultBranch: "main" },
        state: "success",
        environment: "production",
        environmentUrl: "https://app.example.com",
        sha: SHA,
        ref: "main",
        ...delivery,
      },
    }) as DispatchEvent;

  it("FD-GATE-070 requests deploy-smoke for a successful deployment_status of a listed environment with a URL", () => {
    const decode = deploymentStatusDecoder({ hosts: ["app.example.com"] });
    expect(Option.getOrUndefined(decode(status({})))).toMatchObject({
      sha: SHA,
      targetUrl: "https://app.example.com",
    });
    expect(Option.isNone(decode(status({ state: "failure" })))).toBe(true);
    expect(Option.isNone(decode(status({ environment: "staging" })))).toBe(true);
    const noUrl = status({});
    if (noUrl._tag === "webhook" && noUrl.delivery.event === "deployment_status")
      delete (noUrl.delivery as { environmentUrl?: string }).environmentUrl;
    expect(Option.isNone(decode(noUrl))).toBe(true);
    expect(
      Option.isSome(
        deploymentStatusDecoder({ hosts: [], environments: ["staging"] })(
          status({ environment: "staging" }),
        ),
      ),
    ).toBe(true);
  });

  it("FD-GATE-071 probes each default path over HTTPS and counts 2xx and 3xx healthy", async () => {
    const { outcome, requested } = await smoke(
      smokeInput(),
      (url) => new Response(null, { status: url.endsWith("/health") ? 302 : 200 }),
    );
    expect(outcome).toEqual({ _tag: "success" });
    expect(requested).toEqual(["https://app.example.com/", "https://app.example.com/health"]);
  });

  it("FD-GATE-072 records smoke: <host><path> <status> after 3 unhealthy attempts", async () => {
    const { outcome, requested } = await smoke(
      smokeInput({ paths: ["/health"] }),
      () => new Response(null, { status: 503 }),
    );
    expect(outcome).toEqual({ _tag: "failure", reason: "smoke: app.example.com/health 503" });
    expect(requested).toHaveLength(3);
    const errored = await smoke(smokeInput({ paths: ["/"] }), () => new Error("refused"));
    expect(errored.outcome).toEqual({ _tag: "failure", reason: "smoke: app.example.com/ error" });
  });

  it("FD-GATE-073 refuses a target host outside deploySmoke.hosts and sends it no request", async () => {
    const { outcome, requested } = await smoke(
      smokeInput({ targetUrl: "https://evil.example.net/" }),
      () => new Response(),
    );
    expect(outcome).toEqual({ _tag: "failure", reason: "config: host not allowed" });
    expect(requested).toEqual([]);
  });

  it("FD-GATE-074 follows no redirect to a host outside deploySmoke.hosts", async () => {
    const { requested } = await smoke(
      smokeInput({ paths: ["/"] }),
      () => new Response(null, { status: 302, headers: { location: "https://evil.example.net/" } }),
    );
    expect(requested).toEqual(["https://app.example.com/"]);
  });

  it("FD-GATE-075 runs in the control pool with no container and a rate of 0", () => {
    const found = lookupRun("production", "deploy-smoke");
    if (found._tag !== "Available") throw new Error("expected deploy-smoke");
    expect(found.entry.executors).toEqual(["control"]);
    expect(found.entry.containerRateUsdPerHour).toBe(0);
    expect(found.entry.spec.requires).not.toContain("Exec");
  });
});
