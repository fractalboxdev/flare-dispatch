import { createHash } from "node:crypto";
import { Effect, Layer, Schema } from "effect";
import { NativeExecution, NativeReleaseInput, NativeReleaseHandle, NativeReceiptRefused,
  admitNativeRequest, nativeCommandDigest, type NativeExecutionService, type NativeRequest } from "@fractalboxdev/flare-dispatch-core";
import { parseNativeControllerAppId, signAppJwt } from "@fractalboxdev/flare-dispatch-github-app";
import { NativeControllerCheckpoint, makeNativeResultR2, nativeResultKey, readNativeGithubContext } from "@fractalboxdev/flare-dispatch-runtime-cf/native";
import type { Env } from "./env";
import { nativeWorkflowId, readNativeWorkflowPolicy } from "./native-workflow-policy";

const refused = () => new NativeReceiptRefused({ reason: "native release owner identity or evidence refused" });
const Status = Schema.Struct({ status: Schema.Literal("queued", "running", "waiting", "waitingForPause", "paused", "complete", "errored", "terminated"), output: Schema.optional(Schema.Unknown) });
type Source = { executionId: string; repo: string; head: string };

/** Only trusted runtime construction supplies source identity, operator policy and App credentials. */
export const makeNativeReleaseLayer = (env: Env, source: Source,
  transport: Pick<Parameters<typeof readNativeGithubContext>[0], "apiBase" | "fetchImpl"> = {}) => {
  const requestFor = (raw: unknown) => Effect.gen(function* () {
    const input = yield* Schema.decodeUnknown(NativeReleaseInput, { onExcessProperty: "error" })(raw).pipe(Effect.mapError(refused));
    const policy = yield* readNativeWorkflowPolicy(env.NATIVE_EXECUTION_POLICY);
    if (env.NATIVE_WORKFLOW === undefined || !env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY
      || source.executionId.length === 0 || input.head !== source.head || policy.repo !== source.repo)
      return yield* Effect.fail(refused());
    yield* Effect.try({ try: () => parseNativeControllerAppId(env.GITHUB_APP_ID!), catch: refused });
    const nonce = createHash("sha256").update(JSON.stringify([source.executionId, "release", input.profile, input.target, policy.executor_ref])).digest("hex");
    const unsigned: NativeRequest = { repo: source.repo, head: source.head, base: source.head,
      executor_ref: policy.executor_ref, nonce, target: input.target, mode: "release", profile: input.profile,
      command_sha256: "0".repeat(64) };
    const request = yield* admitNativeRequest({ ...unsigned, command_sha256: yield* nativeCommandDigest(unsigned) });
    return { request, policy };
  });
  const validate = (raw: unknown) => Effect.gen(function* () {
    const handle = yield* Schema.decodeUnknown(NativeReleaseHandle, { onExcessProperty: "error" })(raw).pipe(Effect.mapError(refused));
    const expected = yield* requestFor({ head: handle.request.head, profile: handle.request.profile, target: handle.request.target });
    if ((Object.keys(expected.request) as (keyof NativeRequest)[]).some(key => expected.request[key] !== handle.request[key]))
      return yield* Effect.fail(refused());
    return expected;
  });
  const resultOwner = (request: NativeRequest) => Effect.gen(function* () {
    const appId = env.GITHUB_APP_ID, privateKeyPem = env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !privateKeyPem) return yield* Effect.fail(refused());
    const appJwt = yield* Effect.tryPromise({ try: () => signAppJwt({ appId, privateKeyPem }), catch: refused });
    const context = yield* readNativeGithubContext({ appId, appJwt, repo: request.repo, ...transport }, Math.floor(Date.now() / 1000));
    return makeNativeResultR2(env.RUNS_STORAGE, context.controller.actorLogin);
  });
  const bindingFor = (request: NativeRequest) => ({ version: 1 as const, repo: request.repo, head: request.head, base: request.base,
    nonce: request.nonce, target: request.target, command_sha256: request.command_sha256,
    executor_ref: request.executor_ref, expires_at: Math.floor(Date.now() / 1000) + 60 });
  const verified = (raw: unknown) => Effect.gen(function* () {
    const { request } = yield* validate(raw);
    const id = yield* Effect.tryPromise({ try: () => nativeWorkflowId(request), catch: refused });
    const instance = yield* Effect.tryPromise({ try: () => env.NATIVE_WORKFLOW!.get(id), catch: refused });
    if (instance.id !== id) return yield* Effect.fail(refused());
    const status = yield* Effect.tryPromise({ try: () => instance.status(), catch: refused }).pipe(
      Effect.flatMap(value => Schema.decodeUnknown(Status)(value)), Effect.mapError(refused));
    if (status.status === "errored" || status.status === "terminated") return yield* Effect.fail(refused());
    if (status.status !== "complete") return null;
    const checkpoint = yield* Schema.decodeUnknown(NativeControllerCheckpoint)(status.output).pipe(Effect.mapError(refused));
    if (!Schema.is(NativeControllerCheckpoint)(checkpoint) || !('manifestKey' in checkpoint)) return yield* Effect.fail(refused());
    const owner = yield* resultOwner(request);
    const result = yield* owner.read(bindingFor(request), Math.floor(Date.now() / 1000));
    if (result.receipt.run_id !== String(checkpoint.runId) || result.receipt.run_attempt !== String(checkpoint.runAttempt)
      || checkpoint.manifestKey !== nativeResultKey(request)
      || result.request.mode !== "release" || result.request.profile !== request.profile)
      return yield* Effect.fail(refused());
    return { request, result, owner };
  });
  const service: NativeExecutionService = {
    admitRelease: input => Effect.gen(function* () {
      const { request, policy } = yield* requestFor(input);
      const id = yield* Effect.tryPromise({ try: () => nativeWorkflowId(request), catch: refused });
      yield* Effect.tryPromise({ try: () => env.NATIVE_WORKFLOW!.create({ id, params: { request, policy } }), catch: refused }).pipe(
        Effect.catchTag("NativeReceiptRefused", () => Effect.gen(function* () {
          const instance = yield* Effect.tryPromise({ try: () => env.NATIVE_WORKFLOW!.get(id), catch: refused });
          if (instance.id !== id) return yield* Effect.fail(refused());
          const status = yield* Effect.tryPromise({ try: () => instance.status(), catch: refused }).pipe(
            Effect.flatMap(value => Schema.decodeUnknown(Status)(value)), Effect.mapError(refused));
          if (status.status === "errored" || status.status === "terminated") return yield* Effect.fail(refused());
          return instance;
        })),
        Effect.flatMap(instance => instance.id === id ? Effect.void : Effect.fail(refused())),
      );
      return { request };
    }),
    observeRelease: handle => verified(handle).pipe(Effect.map(value => value === null ? { status: "pending" as const } : {
      status: "ready" as const, files: value.result.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
    })),
    readReleaseFile: (handle, path) => Effect.gen(function* () {
      const value = yield* verified(handle);
      if (value === null) return yield* Effect.fail(refused());
      const file = yield* value.owner.readFile(bindingFor(value.request), path, Math.floor(Date.now() / 1000));
      return { body: file.body, size: file.bytes, sha256: file.sha256 };
    }),
  };
  return Layer.succeed(NativeExecution, service);
};
