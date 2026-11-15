// The run catalogue a Container pool's device executor serves: every cloud run that is no host execution, with the
// Container as the job sandbox. The agentic recipes and the scan runs build their Layers inside each execution from the
// lease's `cloudLease` and the runner's services, so a lease is decoded through the entry's runs exactly as the
// bundle's runner decodes it. The execution socket answers as a Container's device executor does: a host-process job
// whose workspace holds the lease's checkout.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  intentList,
  localContentLayer,
  memoryLocalContent,
  type RunResult,
} from "@fractalboxdev/mameko-run";
import {
  STAGED_WRITE_MANIFEST,
  stagedBlobName,
  StagedWrites,
} from "@fractalboxdev/flare-dispatch-agentic";
import { jobServices, runnerMain } from "@fractalboxdev/mameko-runner";
import { Effect, Layer } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudRuns, runs } from "./cloud-runner-entry.ts";
import { GateExec } from "./command.ts";
import { containerAgenticLayers, containerScanLayers } from "./container-layers.ts";
import { ExecutionLease } from "./execution-lease.ts";
import type { ScanLease } from "./inputs.ts";
import { AdvisorySnapshots } from "./ports.ts";
import RUN_DIGESTS from "./run-digests.json" with { type: "json" };
import { registry } from "./runs.ts";
import { ScanSettings } from "./security-gate.ts";
import { lookupRun } from "./spec.ts";

/** One answer on the execution socket. */
type SocketAnswer = Record<string, unknown>;

const names = (served: readonly { readonly spec: { readonly name: string } }[]) =>
  served.map((r) => r.spec.name);

const AGENTIC = [
  "pr-review",
  "improve-pr",
  "self-heal-pr",
  "spec-drift-pr",
  "triage-issues",
  "triage-prs",
  "ci-triage-pr",
  "release-notes",
];
const SCAN = ["security-gate", "security-rescan"];

const ORIGIN = "https://ci.example.com";
const AGENT_LEASE = {
  modelGatewayUrl: `${ORIGIN}/v1/model/completions`,
  controlPlaneUrl: ORIGIN,
};
const EXECUTION = "01JCLOUDLEASE0000000000000";

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

/** The lease's checkout: a base commit and a head commit that changes `README.md`, with `HEAD` at the head. */
const checkout = () => {
  const dir = tempDir("fd-lease-ws-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "readme\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "README.md"), "readme\nmore\n");
  git(dir, "commit", "-q", "-am", "head");
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
};

/** mameko's artifact name grammar (MAMEKO-EXEC-020). */
const artifactName = (name: string) =>
  name.length >= 1 && name.length <= 128 && !name.startsWith(".") && /^[A-Za-z0-9._-]+$/.test(name);

/**
 * The device executor's side of one execution's socket, where the Container is the job sandbox: the job's commands run
 * in `workspace`, `job.egress` ends the setup phase (answered by `egress`), and an artifact upload reads the
 * workspace file. Every request is recorded in `events` in arrival order.
 */
const device = (
  workspace: string,
  egress: () => SocketAnswer = () => ({ type: "job.egress.ok" }),
) => {
  const events: string[] = [];
  const artifacts = new Map<string, Uint8Array>();
  const answer = (m: Record<string, unknown>): SocketAnswer => {
    switch (m["type"]) {
      case "job.prepare":
        events.push("prepare");
        return { type: "job.prepare.ok" };
      case "job.exec": {
        const argv = m["argv"] as string[];
        events.push(`exec:${argv.join(" ")}`);
        const ran = spawnSync(argv[0]!, argv.slice(1), {
          cwd: join(workspace, String(m["cwd"] ?? "")),
          env: { PATH: process.env["PATH"], GIT_CONFIG_GLOBAL: "/dev/null" },
        });
        return {
          type: "job.exec.ok",
          exit_code: ran.status ?? 128,
          stdout: (ran.stdout ?? Buffer.alloc(0)).toString("base64"),
          stderr: (ran.stderr ?? Buffer.alloc(0)).toString("base64"),
        };
      }
      case "workspace.read":
        try {
          const bytes = readFileSync(join(workspace, String(m["path"])));
          return { type: "workspace.read.ok", bytes: bytes.toString("base64") };
        } catch (e) {
          return { type: "socket.error", code: "ReadRefused", message: String(e) };
        }
      case "job.egress":
        events.push("egress:agent");
        return egress();
      case "artifact.upload": {
        const name = String(m["name"]);
        events.push(`artifact:${name}`);
        if (!artifactName(name))
          return { type: "socket.error", code: "InvalidArtifactName", message: name };
        artifacts.set(name, new Uint8Array(readFileSync(join(workspace, String(m["path"])))));
        return { type: "artifact.uploaded" };
      }
      case "job.stop":
        events.push("stop");
        return { type: "job.stop.ok" };
      default:
        return { type: "socket.error", code: "Unsupported", message: String(m["type"]) };
    }
  };
  return {
    events,
    artifacts,
    client: { request: async (m: Record<string, unknown>) => answer(m) },
    /** Serves the socket at `path` for a runner child, one JSON object per line. */
    serve: (path: string) =>
      new Promise<{ readonly close: () => Promise<void> }>((resolve) => {
        const open = new Set<net.Socket>();
        const server = net.createServer((socket) => {
          open.add(socket);
          socket.on("close", () => open.delete(socket));
          let buffer = "";
          socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
              const message = JSON.parse(buffer.slice(0, i)) as Record<string, unknown>;
              buffer = buffer.slice(i + 1);
              socket.write(`${JSON.stringify({ ...answer(message), ref: message["id"] })}\n`);
            }
          });
        });
        server.listen(path, () =>
          resolve({
            close: () =>
              new Promise<void>((done) => {
                for (const socket of open) socket.destroy();
                server.close(() => done());
              }),
          }),
        );
      }),
  };
};

/** The run payload the device executor writes on the runner child's stdin for a lease of `run` (MAMEKO-EXEC-143). */
const leasePayload = (run: string, inputs: unknown) => ({
  workflow_version: 1,
  execution_id: EXECUTION,
  run,
  run_digest: (RUN_DIGESTS as Record<string, string>)[run],
  run_version: "2.0.0",
  scope_id: "acme/app",
  request_context: {},
  class: "batch",
  epoch: 1,
  deadline_at: Date.now() + 3_600_000,
  attempt: 0,
  input: inputs,
});

/** Runs one lease through the entry's runs as the bundle's runner does, over the device's socket. */
const runLease = async (d: ReturnType<typeof device>, run: string, inputs: unknown) => {
  const dir = tempDir("fd-sock-");
  const server = await d.serve(join(dir, "c.sock"));
  const lines: string[] = [];
  try {
    const code = await runnerMain({
      runs,
      argv: ["--journal", join(dir, "j.sqlite"), "--content-socket", join(dir, "c.sock")],
      stdin: Readable.from([`${JSON.stringify(leasePayload(run, inputs))}\n`]),
      stdout: new Writable({
        write: (chunk, _encoding, done) => (lines.push(String(chunk)), done()),
      }),
    });
    return { code, line: JSON.parse(lines.join("")) as { result: RunResult } };
  } finally {
    await server.close();
  }
};

/** Each agentic recipe's input for an `acme/app` lease. */
const agenticInput = (run: string, base: string, head: string): Record<string, unknown> => {
  const repo = { owner: "acme", name: "app" };
  switch (run) {
    case "pr-review":
      return {
        repo,
        number: 7,
        baseSha: base,
        headSha: head,
        draft: false,
        labels: [],
        authorLogin: "dev",
        authorAssociation: "MEMBER",
        forkHead: false,
        maxDiffChars: 100_000,
      };
    case "improve-pr":
      return {
        repo,
        baseBranch: "main",
        dimension: {
          name: "size",
          measure: "echo 10",
          better: "lower",
          materialityFloor: 1,
          verify: "true",
        },
      };
    case "self-heal-pr":
      return {
        incident: {
          contractVersion: "v1",
          incidentId: "ci-acme-app-1",
          class: "ci",
          repo: "acme/app",
          diagnosis: { title: "t", area: "README.md", diagnosis: "d", suggestedFix: "f" },
          suspectFiles: ["README.md"],
          repro: { kind: "command", command: "true" },
        },
      };
    case "triage-issues":
      return { repo };
    default:
      return { repo, baseBranch: "main" };
  }
};

/** A `fetch` that records each request, answering the model route with `text` and every other URL `403`. */
const stubFetch = (events: string[], text = '{"findings":[]}') => {
  const sent: { readonly url: string; readonly authorization: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    events.push(`fetch:${url}`);
    sent.push({ url, authorization: new Headers(init.headers).get("authorization") });
    return url === AGENT_LEASE.modelGatewayUrl
      ? new Response(JSON.stringify({ text }))
      : new Response('{"error":"egress_denied"}', { status: 403 });
  });
  return sent;
};

describe("the Container pool's run catalogue", () => {
  it("serves every cloud run that is no host execution under both deployments: the cloud gate runs, the agentic recipes and the scan runs", () => {
    const served = ["worker-deploy", "sandbox-image", ...AGENTIC, ...SCAN];
    const cloudOnly = registry
      .map((r) => r.spec.name)
      .filter((name) => {
        const found = lookupRun("production", name);
        return found._tag === "Available" && found.entry.executors.includes("cloud");
      });
    expect([...cloudOnly].sort()).toEqual([...served].sort());
    expect(names(cloudRuns("production"))).toEqual(served);
    expect(names(cloudRuns("development"))).toEqual(served);
    expect(names(runs)).toEqual(served);
    for (const run of runs)
      // Each run carries the cloud Layers, not the registry's unprovided Layer.
      expect(run.layer).not.toBe(registry.find((r) => r.spec.name === run.spec.name)?.layer);
    for (const name of ["check", "oxlint", "gate-job"])
      expect(names(cloudRuns("development"))).not.toContain(name);
  });

  it("[FD-AGT-010] [FD-AGT-059] builds pr-review's Layers from its lease: the checkout the workspace holds, the model route the lease names after the setup phase ends, and the diff in the execution's artifact store", async () => {
    const { dir, base, head } = checkout();
    const d = device(dir);
    const sent = stubFetch(d.events);
    const { code, line } = await runLease(d, "pr-review", {
      ...agenticInput("pr-review", base, head),
      cloudLease: AGENT_LEASE,
    });
    expect(code).toBe(0);
    expect(line.result).toEqual({ _tag: "success" });
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(request.url).toBe(AGENT_LEASE.modelGatewayUrl);
      expect(request.authorization).toBeNull();
    }
    // The job's setup phase ends before the first model request.
    expect(d.events.indexOf("egress:agent")).toBeGreaterThan(-1);
    expect(d.events.indexOf("egress:agent")).toBeLessThan(
      d.events.findIndex((e) => e.startsWith("fetch:")),
    );
    const diff = git(dir, "diff", "--no-color", "--no-ext-diff", `${base}...${head}`);
    expect(new TextDecoder().decode(d.artifacts.get("pr-review.diff")).trim()).toBe(diff);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it.each(AGENTIC)(
    "[FD-AGT-010] builds %s's Layers from a lease that carries its executor values, and ends the run infra: CloudLeaseMissing on one that carries none",
    async (run) => {
      const { dir, base, head } = checkout();
      const leased = device(dir);
      const leasedSent = stubFetch(leased.events, "flaky");
      const withLease = await runLease(leased, run, {
        ...agenticInput(run, base, head),
        cloudLease: AGENT_LEASE,
      });
      expect(withLease.code).toBe(0);
      expect(withLease.line.result).not.toEqual({
        _tag: "failure",
        reason: "infra: CloudLeaseMissing",
      });
      expect(leased.events).toContain("egress:agent");
      for (const request of leasedSent.filter((r) => r.url.includes("/v1/model/")))
        expect(request.url).toBe(AGENT_LEASE.modelGatewayUrl);

      vi.unstubAllGlobals();
      const bare = device(dir);
      const bareSent = stubFetch(bare.events);
      const without = await runLease(bare, run, agenticInput(run, base, head));
      expect(without.line.result).toEqual({ _tag: "failure", reason: "infra: CloudLeaseMissing" });
      expect(bareSent).toEqual([]);
      expect(bare.events).not.toContain("egress:agent");
    },
  );
});

describe("the staged write on a Container", () => {
  it("[FD-AGT-013] uploads the manifest and each blob under one-segment artifact names mameko's artifact grammar accepts", async () => {
    const { dir, base, head } = checkout();
    const d = device(dir);
    const layers = containerAgenticLayers({
      fetch: globalThis.fetch,
      env: process.env,
      editLoop: ["true"],
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ExecutionLease, {
            executionId: EXECUTION,
            epoch: 1,
            run: "improve-pr",
            input: { ...agenticInput("improve-pr", base, head), cloudLease: AGENT_LEASE },
          }),
          jobServices(d.client, { executionId: EXECUTION, epoch: 1, outputPaths: [] }),
          intentList().layer,
        ),
      ),
    );
    writeFileSync(join(dir, "README.md"), "readme\nmore\nstaged\n");
    const manifest = await Effect.runPromise(
      StagedWrites.use((s) =>
        s.stage({
          branch: "flare-dispatch/improve-size",
          baseBranch: "main",
          message: "m",
          pr: { title: "t", body: "b", draft: true, labels: [] },
        }),
      ).pipe(Effect.provide(layers)),
    );
    expect(manifest.baseCommit).toBe(head);
    const digest = sha256("readme\nmore\nstaged\n");
    expect(manifest.entries).toEqual([{ path: "README.md", mode: "100644", digest }]);
    expect(d.events.filter((e) => e.startsWith("artifact:"))).toEqual([
      `artifact:staged-write.blob.${digest}`,
      "artifact:staged-write.manifest.json",
    ]);
    expect([...d.artifacts.keys()]).toEqual([stagedBlobName(digest), STAGED_WRITE_MANIFEST]);
    for (const name of d.artifacts.keys()) expect(artifactName(name), name).toBe(true);
    expect(new TextDecoder().decode(d.artifacts.get(stagedBlobName(digest)))).toBe(
      "readme\nmore\nstaged\n",
    );
  });
});

const SHA = "c".repeat(40);
const scanInput = (run: string, cloudLease?: ScanLease) => ({
  repo: "https://github.com/acme/app.git",
  sha: SHA,
  ref: "refs/heads/feature",
  scope: "acme/app",
  ...(run === "security-gate" ? { base: { _tag: "TargetBranch", branch: "main" } } : {}),
  ...(cloudLease === undefined ? {} : { cloudLease }),
});

/**
 * One scan lease through the entry's run on the runner's services over the device's socket. The bundle's runner ends
 * a run that declares a grant before its body (MAMEKO-EXEC-163), so the scan bodies run here on the same services
 * outside that refusal.
 */
const runScan = (run: string, inputs: unknown, d: ReturnType<typeof device>) => {
  const served = runs.find((r) => r.spec.name === run)!;
  const services = Layer.mergeAll(
    intentList().layer,
    localContentLayer(memoryLocalContent(), "acme/app"),
    jobServices(d.client, { executionId: EXECUTION, epoch: 1, outputPaths: [] }),
    WorkflowEngine.layerMemory,
  );
  return Effect.runPromise(
    (served.workflow.execute(leasePayload(run, inputs) as never) as Effect.Effect<RunResult>).pipe(
      Effect.provide(
        Layer.provideMerge(
          served.layer as Layer.Layer<never, never, never>,
          services as Layer.Layer<never>,
        ),
      ),
    ) as Effect.Effect<RunResult>,
  );
};

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

describe("the scan runs' per-lease Layers", () => {
  it.each(SCAN)(
    "[FD-GATE-100] [FD-GATE-101] [FD-GATE-102] [FD-GATE-103] %s reads the scan bundle the lease pins through the lease's presigned read alone, and ends infra: CloudLeaseMissing on a lease with no scan values",
    async (run) => {
      const d = device(tempDir("fd-scan-ws-"));
      const events: string[] = [];
      const stored = new TextEncoder().encode("not the pinned bundle");
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        events.push(String(input));
        return new Response(stored);
      });
      const pin = "a".repeat(64);
      const url = "https://acct.r2.cloudflarestorage.com/cache/cas/a?X-Amz-Signature=s";
      const lease = (over: Partial<ScanLease>): ScanLease => ({
        advisoryMaxAgeHours: 48,
        advisories: [],
        ...over,
      });
      expect(await runScan(run, scanInput(run, lease({})), d)).toEqual({
        _tag: "failure",
        reason: "config: scan bundle not pinned",
      });
      expect(await runScan(run, scanInput(run, lease({ bundleDigest: pin })), d)).toEqual({
        _tag: "failure",
        reason: "config: scan bundle missing",
      });
      expect(events).toEqual([]);
      // The bytes the lease's read answers are the bytes the scan verifies against the pin.
      expect(
        await runScan(run, scanInput(run, lease({ bundleDigest: pin, bundleUrl: url })), d),
      ).toEqual({ _tag: "failure", reason: "config: scan bundle digest" });
      expect(events).toEqual([url]);
      expect(await runScan(run, scanInput(run), d)).toEqual({
        _tag: "failure",
        reason: "infra: CloudLeaseMissing",
      });
      expect(events).toEqual([url]);
      expect(d.events).toEqual([]);
    },
  );

  /** The scan Layers of one lease, over the device's socket. */
  const scanLayers = (lease: ScanLease, d: ReturnType<typeof device>) =>
    containerScanLayers(globalThis.fetch).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ExecutionLease, {
            executionId: EXECUTION,
            epoch: 1,
            run: "security-rescan",
            input: scanInput("security-rescan", lease),
          }),
          jobServices(d.client, { executionId: EXECUTION, epoch: 1, outputPaths: [] }),
          intentList().layer,
        ),
      ),
    );

  it("[FD-GATE-110] ends the scan's setup egress phase through the device executor, and fails the switch the device refuses", async () => {
    const lease: ScanLease = { advisoryMaxAgeHours: 48, advisories: [] };
    const held = device(tempDir("fd-scan-ws-"));
    await Effect.runPromise(
      Effect.flatMap(GateExec, (exec) => exec.endSetup).pipe(
        Effect.provide(scanLayers(lease, held)),
      ),
    );
    expect(held.events).toEqual(["egress:agent"]);
    const refused = device(tempDir("fd-scan-ws-"), () => ({
      type: "socket.error",
      message: "stale",
    }));
    const result = await Effect.runPromise(
      Effect.flatMap(GateExec, (exec) => Effect.result(exec.endSetup)).pipe(
        Effect.provide(scanLayers(lease, refused)),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).toContain("EgressPhaseFailed");
  });

  it("[FD-GATE-104] [FD-GATE-106] places a leased advisory archive read-only outside the checkout in OSV-Scanner's offline layout, and refuses an archive whose SHA-256 differs from the recorded digest", async () => {
    const archive = new TextEncoder().encode("osv all.zip bytes");
    const good = "https://acct.r2.cloudflarestorage.com/cache/cas/npm?X-Amz-Signature=s";
    const bad = "https://acct.r2.cloudflarestorage.com/cache/cas/pypi?X-Amz-Signature=s";
    vi.stubGlobal("fetch", async () => new Response(archive));
    const lease: ScanLease = {
      advisoryMaxAgeHours: 48,
      advisories: [
        { ecosystem: "npm", digest: sha256(archive), lastModified: 1, url: good },
        { ecosystem: "PyPI", digest: "0".repeat(64), lastModified: 2, url: bad },
      ],
    };
    const d = device(tempDir("fd-scan-ws-"));
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const snapshots = yield* AdvisorySnapshots;
        const settings = yield* ScanSettings;
        const npm = yield* snapshots.read("npm");
        const pypi = yield* Effect.result(snapshots.read("PyPI"));
        const crates = yield* snapshots.read("crates.io");
        const file = join(settings.advisoryDir, "osv-scanner", "npm", "all.zip");
        return {
          npm,
          pypi,
          crates,
          bytes: readFileSync(file),
          mode: statSync(file).mode & 0o777,
          dir: settings.advisoryDir,
        };
      }).pipe(Effect.provide(scanLayers(lease, d))),
    );
    expect(out.npm).toEqual({ ecosystem: "npm", digest: sha256(archive), lastModified: 1 });
    expect(new Uint8Array(out.bytes)).toEqual(archive);
    expect(out.mode).toBe(0o444);
    expect(out.pypi._tag).toBe("Failure");
    expect(out.crates).toBeNull();
    // The directory is the execution's own, and goes when the execution's Layers close.
    expect(() => statSync(out.dir)).toThrow();
  });
});
