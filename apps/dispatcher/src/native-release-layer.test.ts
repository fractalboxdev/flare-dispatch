import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { Artifact, NativeExecution, nativeCommand, type NativeRequest } from "@fractalboxdev/flare-dispatch-core";
import { makeTestBindings } from "@fractalboxdev/flare-dispatch-runtime-cf/testing";
import { makeNativeFilesR2, makeNativeResultR2, makeR2ArtifactLive, nativeResultKey } from "@fractalboxdev/flare-dispatch-runtime-cf/native";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { contextfulRelease, contextfulReleaseCell } from "@fractalboxdev/flare-dispatch-runs";
import { makeNativeReleaseLayer } from "./native-release-layer";
import { makeFakeEnv, makeFakeR2, makeFakeWorkflow } from "./test-helpers";
import type { Env } from "./env";

const source = { executionId: "fixture-release-cell", repo: "owner/project", head: "1".repeat(40) };
const policy = { repo: source.repo, executor_ref: "3".repeat(40), timeoutSec: 600, pollIntervalSec: 30 };
const input = { head: source.head, target: "aarch64-pc-windows-msvc" as const, profile: "contextful-edge" as const };
const fixture = () => {
  const workflow = makeFakeWorkflow();
  const env: Env = { ...makeFakeEnv({ workflow, storage: makeFakeR2(), hmacSecret: "fixture", githubAppId: "42" }),
    NATIVE_WORKFLOW: workflow.binding, NATIVE_EXECUTION_POLICY: JSON.stringify(policy) };
  return { env, workflow };
};
const credential = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const fetchFor = (repo: string): typeof fetch => async (url) => {
  const path = new URL(String(url)).pathname;
  if (path === "/app") return Response.json({ id: 42, slug: "native-controller" });
  if (path.endsWith("/installation")) return Response.json({ id: 10, app_id: 42, account: { login: repo.split("/")[0] }, suspended_at: null, permissions: { actions: "write" } });
  if (path.endsWith("/access_tokens")) return Response.json({ token: "fixture-not-live", expires_at: new Date(Math.floor(Date.now() / 1000) * 1000 + 600000).toISOString(),
    repository_selection: "selected", repositories: [{ name: repo.split("/")[1], full_name: repo }], permissions: { actions: "write", metadata: "read" } }, { status: 201 });
  throw new Error("fixture refuses any undeclared provider request");
};

const publish = async (bucket: R2Bucket, request: NativeRequest, path: string, bytes: Uint8Array,
  extra: readonly { path: string; bytes: Uint8Array }[] = []) => {
  const now = Math.floor(Date.now() / 1000);
  const isArm = request.target.startsWith("aarch64");
  const artifact = { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const log = new TextEncoder().encode("fixture command exits zero\n");
  const logArtifact = { path: "command.log", bytes: log.length, sha256: createHash("sha256").update(log).digest("hex") };
  const extraArtifacts = extra.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: createHash("sha256").update(file.bytes).digest("hex") }));
  const api = { repo: request.repo, runId: 123, runAttempt: 1, event: "workflow_dispatch", executorRef: request.executor_ref,
    workflowPath: ".github/workflows/native-windows.yml", runName: `native-${request.nonce}`, actorLogin: "native-controller[bot]", actorType: "Bot",
    status: "completed", conclusion: "success", job: isArm ? "aarch64" : "x86_64", jobStatus: "completed", jobConclusion: "success",
    labels: [isArm ? "windows-11-arm" : "windows-2025"] };
  const receipt = { version: 1, repo: request.repo, head: request.head, base: request.base, executor_ref: request.executor_ref,
    nonce: request.nonce, target: request.target, command_sha256: request.command_sha256, command: nativeCommand(request),
    runner_os: "Windows", runner_arch: isArm ? "ARM64" : "X64", run_id: "123", run_attempt: "1", job: api.job,
    exit_code: 0, failure: null, started_at: "2026-10-08T00:00:00Z", completed_at: "2026-10-08T00:00:01Z", artifacts: [artifact, logArtifact, ...extraArtifacts] };
  async function* entries() {
    yield { path, body: new Response(bytes).body! };
    yield { path: "command.log", body: new Response(log).body! };
    for (const file of extra) yield { path: file.path, body: new Response(file.bytes).body! };
  }
  const captured = await Effect.runPromise(makeNativeFilesR2(bucket).verify({ request, receipt, api, controllerLogin: api.actorLogin }, entries()));
  await Effect.runPromise(makeNativeResultR2(bucket, api.actorLogin).publish({ request, api, ...captured, verifiedAt: now }, now));
  return { _tag: "Published", admittedAt: now, deadlineAt: now + 600, runId: 123, runAttempt: 1, manifestKey: nativeResultKey(request) };
};
describe("native release owner", () => {
  it("reconciles an uncertain admission only with a live matching Workflow", async () => {
    const f = fixture();
    vi.spyOn(f.workflow.binding, "create").mockRejectedValue(new Error("fixture response lost"));
    const get = f.workflow.binding.get.bind(f.workflow.binding);
    let state: "running" | "errored" = "errored";
    vi.spyOn(f.workflow.binding, "get").mockImplementation(async id => {
      const instance = await get(id);
      vi.spyOn(instance, "status").mockImplementation(async () => ({ status: state }));
      return instance;
    });
    const layer = makeNativeReleaseLayer({ ...f.env, GITHUB_APP_PRIVATE_KEY: credential }, source);
    try {
      const admit = Effect.flatMap(NativeExecution, owner => owner.admitRelease(input)).pipe(Effect.provide(layer));
      expect(Exit.isFailure(await Effect.runPromiseExit(admit))).toBe(true);
      state = "running";
      expect(Exit.isSuccess(await Effect.runPromiseExit(admit))).toBe(true);
      expect(f.workflow.binding.create).toHaveBeenCalledTimes(2);
    } finally { vi.restoreAllMocks(); }
  });

  it("refuses incomplete App configuration before Workflow admission", async () => {
    const f = fixture();
    const result = await Effect.runPromiseExit(Effect.flatMap(NativeExecution, owner => owner.admitRelease(input))
      .pipe(Effect.provide(makeNativeReleaseLayer(f.env, source))));
    expect(Exit.isFailure(result)).toBe(true);
    expect(f.workflow.calls).toHaveLength(0);
  });

  it("binds release-only scope and refuses forged head, base, mode, nonce, executor or command", async () => {
    const f = fixture();
    const layer = makeNativeReleaseLayer({ ...f.env, GITHUB_APP_PRIVATE_KEY: credential }, source);
    await Effect.runPromise(Effect.gen(function* () {
      const owner = yield* NativeExecution;
      const handle = yield* owner.admitRelease(input);
      expect(handle.request).toMatchObject({ mode: "release", base: source.head, head: source.head });
      for (const patch of [{ head: "2".repeat(40) }, { base: "2".repeat(40) }, { mode: "gate", profile: "" },
        { nonce: "f".repeat(64) }, { executor_ref: "4".repeat(40) }, { command_sha256: "f".repeat(64) },
        { profile: "contextful-full" }, { target: "x86_64-pc-windows-msvc" }]) {
        const forged = { request: { ...handle.request, ...patch } };
        expect(Exit.isFailure(yield* Effect.exit(owner.observeRelease(forged as typeof handle)))).toBe(true);
      }
    }).pipe(Effect.provide(layer)));
    expect(f.workflow.calls).toHaveLength(1);
  });

  it("consumes authentic API-bound immutable bytes through the real artifact owner", async () => {
    const raw = await makeTestBindings();
    const bucket = { get: raw.bucket.get.bind(raw.bucket), put: ((key, value, options) => raw.bucket.put(key, value, {
      ...options, ...(options?.onlyIf instanceof Headers ? { onlyIf: { etagDoesNotMatch: options.onlyIf.get("if-none-match")! } } : {}),
    })) as R2Bucket["put"] } as R2Bucket;
    const f = fixture();
    let checkpoint: unknown;
    const originalGet = f.workflow.binding.get.bind(f.workflow.binding);
    vi.spyOn(f.workflow.binding, "get").mockImplementation(async id => {
      const instance = await originalGet(id);
      vi.spyOn(instance, "status").mockResolvedValue({ status: "complete", output: checkpoint });
      return instance;
    });
    const layer = makeNativeReleaseLayer({ ...f.env, RUNS_STORAGE: bucket, GITHUB_APP_PRIVATE_KEY: credential }, source, { fetchImpl: fetchFor(source.repo) });
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const owner = yield* NativeExecution;
        const handle = yield* owner.admitRelease(input);
        const bytes = new TextEncoder().encode("MZ\0native-fixture");
        checkpoint = { _tag: "Published", admittedAt: Math.floor(Date.now() / 1000), runId: 123, runAttempt: 1,
          manifestKey: nativeResultKey(handle.request) };
        expect(Exit.isFailure(yield* Effect.exit(owner.observeRelease(handle)))).toBe(true);
        checkpoint = yield* Effect.promise(() => publish(bucket, handle.request, "release.exe", bytes));
        expect((yield* owner.observeRelease(handle)).status).toBe("ready");
        const admitted = checkpoint;
        for (const patch of [{ runId: 124 }, { runAttempt: 2 }, { manifestKey: "foreign/result.json" }]) {
          checkpoint = { ...admitted as Record<string, unknown>, ...patch };
          expect(Exit.isFailure(yield* Effect.exit(owner.observeRelease(handle)))).toBe(true);
          expect(Exit.isFailure(yield* Effect.exit(owner.readReleaseFile(handle, "release.exe")))).toBe(true);
        }
        checkpoint = admitted;
        expect(Exit.isFailure(yield* Effect.exit(owner.readReleaseFile(handle, "absent.exe")))).toBe(true);
        const file = yield* owner.readReleaseFile(handle, "release.exe");
        yield* Effect.flatMap(Artifact, artifacts => artifacts.uploadVerified({ name: "release.exe", body: file.body,
          size: file.size, sha256: file.sha256, contentType: "application/octet-stream" }));
        const stored = yield* Effect.promise(() => raw.bucket.get(`artifacts/${source.executionId}/release.exe`));
        expect(new Uint8Array(yield* Effect.promise(() => stored!.arrayBuffer()))).toEqual(bytes);
      }).pipe(Effect.provide(layer), Effect.provide(makeR2ArtifactLive(raw.bucket, source.executionId))));
    } finally { vi.restoreAllMocks(); await raw.dispose(); }
  });

  it("joins fourteen declared cells after all four native cells import verified publication bytes", async () => {
    const raw = await makeTestBindings();
    const bucket = { get: raw.bucket.get.bind(raw.bucket), put: ((key, value, options) => raw.bucket.put(key, value, {
      ...options, ...(options?.onlyIf instanceof Headers ? { onlyIf: { etagDoesNotMatch: options.onlyIf.get("if-none-match")! } } : {}),
    })) as R2Bucket["put"] } as R2Bucket;
    const tag = "v0.5.0", head = source.head;
    const repo = contextfulRelease.triggers![0]!.inputs({ payload: { ref: `refs/tags/${tag}`, after: head } }).repo;
    const cells = ["contextful-control", "contextful-edge", "contextful-full"].flatMap(profile =>
      (profile.endsWith("control") ? ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"] :
        ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "x86_64-apple-darwin", "aarch64-apple-darwin", "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"])
        .map(target => ({ profile, target })));
    const plan = cells.map(cell => `${cell.profile} ${cell.target}`).join("\n");
    const summaries: Record<string, unknown>[] = [];
    let nativeCreates = 0;
    try {
      for (const cell of cells) {
        const name = `contextful-${cell.profile.replace("contextful-", "")}-0.5.0-${cell.target}`;
        const bytes = new TextEncoder().encode(`MZ\0fixture-${cell.profile}-${cell.target}`);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const manifest = JSON.stringify({ ...cell, archive: `${name}.tar.gz`, sha256, sbom: `${name}.cdx.json` });
        if (!cell.target.endsWith("-pc-windows-msvc")) {
          summaries.push({ ...cell, manifest, assets: [`${name}.tar.gz`, `${name}.tar.gz.sha256`, `${name}.cdx.json`],
            ...(cell.target === "x86_64-unknown-linux-musl" ? { imageLayer: { archiveName: `${cell.profile}-0.5.0-linux-amd64.oci.tar` } } : {}) });
          continue;
        }
        const f = fixture();
        const nativeSource = { executionId: `fixture-${cell.profile}-${cell.target}`, repo, head };
        let checkpoint: unknown;
        const create = f.workflow.binding.create.bind(f.workflow.binding), get = f.workflow.binding.get.bind(f.workflow.binding);
        vi.spyOn(f.workflow.binding, "create").mockImplementation(async opts => {
          if (opts === undefined || opts.params === undefined) throw new Error("fixture native request missing");
          const request = (opts.params as { request: NativeRequest }).request;
          checkpoint = await publish(bucket, request, `dist/${name}.release.json`, new TextEncoder().encode(manifest), [
            { path: `dist/${name}.tar.gz`, bytes },
            { path: `dist/${name}.tar.gz.sha256`, bytes: new TextEncoder().encode(`${sha256}  ${name}.tar.gz\n`) },
            { path: `dist/${name}.cdx.json`, bytes: new TextEncoder().encode('{"bomFormat":"CycloneDX"}') },
          ]);
          nativeCreates++; return create(opts);
        });
        vi.spyOn(f.workflow.binding, "get").mockImplementation(async id => {
          const instance = await get(id); vi.spyOn(instance, "status").mockResolvedValue({ status: "complete", output: checkpoint }); return instance;
        });
        const env = { ...f.env, RUNS_STORAGE: bucket, GITHUB_APP_PRIVATE_KEY: credential,
          NATIVE_EXECUTION_POLICY: JSON.stringify({ ...policy, repo }) };
        const base = makeCFRuntimeTest({ sandboxProgram: { "release --plan": { exitCode: 0, stdout: plan } } });
        const output = await Effect.runPromise(contextfulReleaseCell.run({ ...cell, repo, sha: head, tag, releaseId: 0, dryRun: true }).pipe(
          Effect.provide(makeNativeReleaseLayer(env, nativeSource, { fetchImpl: fetchFor(repo) })),
          Effect.provide(makeR2ArtifactLive(raw.bucket, nativeSource.executionId)), Effect.provide(base.layer)));
        summaries.push(output);
        const archived = await raw.bucket.get(`artifacts/${nativeSource.executionId}/${name}.tar.gz`);
        expect(new Uint8Array(await archived!.arrayBuffer())).toEqual(bytes);
        expect(base.handles.sandbox.execs.some(exec => exec.command.includes("zigbuild"))).toBe(false);
      }
      const parent = makeCFRuntimeTest({
        github: { files: { [`${repo}:Cargo.toml`]: '[workspace.package]\nversion = "0.5.0"\n' } },
        sandboxProgram: { "release --plan": { exitCode: 0, stdout: plan } },
        childRuns: { pollFn: ids => ids.map(id => ({ executionId: id, status: "success", summaryJson: JSON.stringify(
          id.startsWith("contextful-release-formula") ? { assets: ["control.rb", "edge.rb", "full.rb", "default.rb", "SHA256SUMS", "install.sh"] }
            : summaries[Number(id.split(":").at(-1))]) })) },
      });
      const result = await Effect.runPromise(contextfulRelease.run({ repo, tag, sha: head, dryRun: true }).pipe(Effect.provide(parent.layer)));
      expect(result.cells).toBe(14); expect(result.assets).toBe(48); expect(nativeCreates).toBe(4);
      expect(parent.handles.childRuns.spawned.filter(child => child.run === contextfulReleaseCell.name)).toHaveLength(14);
    } finally { vi.restoreAllMocks(); await raw.dispose(); }
  });
});
