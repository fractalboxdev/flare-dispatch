import { Effect, Schema } from "effect";

const Revision = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{40}$/));
const Digest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
const Target = Schema.Literal("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc");
export const NativeControllerLogin = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/));
export const NativeArtifactPath = Schema.String.pipe(Schema.filter((path) => path.split("/").every((segment) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)
    && !segment.endsWith(".")
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment),
)));
const Artifact = Schema.Struct({
  path: NativeArtifactPath,
  sha256: Digest,
  bytes: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

export const NativeRequest = Schema.Struct({
  repo: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  head: Revision, base: Revision, executor_ref: Revision,
  nonce: Schema.String.pipe(Schema.pattern(/^[a-z0-9-]{16,64}$/)),
  target: Target, mode: Schema.Literal("gate", "release"),
  profile: Schema.Literal("", "contextful-edge", "contextful-full"), command_sha256: Digest,
});
export type NativeRequest = typeof NativeRequest.Type;

export const NativeReceipt = Schema.Struct({
  version: Schema.Literal(1), repo: NativeRequest.fields.repo, head: Revision, base: Revision,
  executor_ref: Revision, nonce: NativeRequest.fields.nonce, command_sha256: Digest,
  command: Schema.Array(Schema.String), target: Target,
  runner_os: Schema.Literal("Windows"), runner_arch: Schema.Literal("X64", "ARM64"),
  run_id: Schema.String.pipe(Schema.pattern(/^[1-9][0-9]*$/)),
  run_attempt: Schema.String.pipe(Schema.pattern(/^[1-9][0-9]*$/)),
  job: Schema.Literal("x86_64", "aarch64"), exit_code: Schema.Number.pipe(Schema.int()),
  failure: Schema.NullOr(Schema.String), started_at: Schema.String, completed_at: Schema.String,
  artifacts: Schema.Array(Artifact),
});
export type NativeReceipt = typeof NativeReceipt.Type;

export const NativeApiEvidence = Schema.Struct({
  repo: NativeRequest.fields.repo, runId: Schema.Number.pipe(Schema.filter((id) => Number.isSafeInteger(id) && id > 0)),
  runAttempt: Schema.Number.pipe(Schema.filter((id) => Number.isSafeInteger(id) && id > 0)), event: Schema.String,
  executorRef: Revision, workflowPath: Schema.String, runName: Schema.String,
  status: Schema.String, conclusion: Schema.NullOr(Schema.String), job: Schema.String,
  actorLogin: Schema.String, actorType: Schema.Literal("Bot", "User"),
  jobStatus: Schema.String, jobConclusion: Schema.NullOr(Schema.String), labels: Schema.Array(Schema.String),
});
export type NativeApiEvidence = typeof NativeApiEvidence.Type;

const NativeRunEvidence = NativeApiEvidence.pipe(Schema.pick(
  "repo", "runId", "runAttempt", "event", "executorRef", "workflowPath", "runName", "actorLogin", "actorType", "status", "conclusion",
));
export const NativePendingStatus = Schema.Literal("queued", "in_progress", "requested", "waiting", "pending");
export const NativeTerminalConclusion = Schema.Literal(
  "success", "failure", "cancelled", "timed_out", "neutral", "skipped", "action_required", "stale", "startup_failure",
);
const NativeRunLifecycle = Schema.Union(
  Schema.Struct({ status:NativePendingStatus, conclusion:Schema.Null }),
  Schema.Struct({ status:Schema.Literal("completed"), conclusion:NativeTerminalConclusion }),
);

export class NativeReceiptRefused extends Schema.TaggedError<NativeReceiptRefused>()(
  "NativeReceiptRefused", { reason: Schema.String },
) {}

/** Chosen clock policy: include five minutes before the durable controller admission. */
export const NATIVE_DISCOVERY_CLOCK_ALLOWANCE_SECONDS = 300;
export const NativeAdmissionTime = Schema.Number.pipe(Schema.filter((time) => Number.isSafeInteger(time)
  && time >= NATIVE_DISCOVERY_CLOCK_ALLOWANCE_SECONDS && Number.isFinite(new Date(time * 1000).getTime())));
export const NativeRunCreatedAt = Schema.String.pipe(Schema.filter((time) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(time)
  && Number.isFinite(Date.parse(time))
  && new Date(time).toISOString() === (time.includes(".") ? time : time.replace("Z", ".000Z")),
));
/** The lower bound remains tied to the admission, never to a poll or workload receipt. */
export const nativeDiscoveryWindow = (raw: unknown) => Effect.gen(function* () {
  const admittedAt = yield* Schema.decodeUnknown(NativeAdmissionTime)(raw).pipe(
    Effect.mapError(() => new NativeReceiptRefused({ reason: "native admission timestamp invalid or absent" })),
  );
  const lowerSeconds = admittedAt - NATIVE_DISCOVERY_CLOCK_ALLOWANCE_SECONDS;
  const createdAfter = new Date(lowerSeconds * 1000).toISOString().replace(".000Z", "Z");
  if (!Schema.is(NativeRunCreatedAt)(createdAfter))
    return yield* Effect.fail(new NativeReceiptRefused({ reason: "native discovery timestamp is not canonical" }));
  return { admittedAt, lowerSeconds, createdAfter };
});

/** This array is also the wrapper's literal subprocess argv, never shell text. */
export const nativeCommand = (request: NativeRequest): readonly string[] => {
  const cargo = ["cargo", "+1.97.0", "run", "--locked", "-q", "-p", "contextful-ci", "--"];
  return request.mode === "gate"
    ? [...cargo, "gate", "--stage", request.target === "x86_64-pc-windows-msvc" ? "windows.x86_64-msvc" : "windows.aarch64-msvc", "--base", request.base]
    : [...cargo, "release", "--target", request.target, "--profile", request.profile, "--out", "../native-output/dist"];
};

export const nativeCommandDigest = (request: NativeRequest) => Effect.tryPromise({
  try: async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(nativeCommand(request)));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  },
  catch: () => new NativeReceiptRefused({ reason: "command digest unavailable" }),
});

/** Every native transport and receipt uses this complete request and canonical literal command. */
export const admitNativeRequest = (raw: unknown) => Effect.gen(function* () {
  const request = yield* Schema.decodeUnknown(NativeRequest, { onExcessProperty: "error" })(raw).pipe(
    Effect.mapError(() => new NativeReceiptRefused({ reason: "invalid native request" })),
  );
  if ((request.mode === "gate") !== (request.profile === ""))
    return yield* Effect.fail(new NativeReceiptRefused({ reason: "mode/profile mismatch" }));
  if (request.command_sha256 !== (yield* nativeCommandDigest(request)))
    return yield* Effect.fail(new NativeReceiptRefused({ reason: "command mismatch" }));
  return request;
});

const matchesNativeRunIdentity = (
  request: NativeRequest, api: typeof NativeRunEvidence.Type, trustedControllerLogin: string,
) => Schema.is(NativeControllerLogin)(trustedControllerLogin)
  && api.repo === request.repo && api.event === "workflow_dispatch"
  && api.actorType === "Bot" && api.actorLogin === trustedControllerLogin
  && api.executorRef === request.executor_ref && api.workflowPath === ".github/workflows/native-windows.yml"
  && api.runName === `native-${request.nonce}`;

/** An authentic terminal run conclusion is observation, never job or artifact admission. */
export const admitNativeRunObservation = (rawRequest: unknown, rawApi: unknown, trustedControllerLogin: string) =>
  Effect.gen(function* () {
    const request = yield* admitNativeRequest(rawRequest);
    const api = yield* Schema.decodeUnknown(NativeRunEvidence, { onExcessProperty:"error" })(rawApi).pipe(
      Effect.mapError(() => new NativeReceiptRefused({ reason:"invalid native run evidence" })),
    );
    if (!matchesNativeRunIdentity(request, api, trustedControllerLogin))
      return yield* Effect.fail(new NativeReceiptRefused({ reason:"authentic API run identity mismatch" }));
    const lifecycle = yield* Schema.decodeUnknown(NativeRunLifecycle)({ status:api.status, conclusion:api.conclusion }).pipe(
      Effect.mapError(() => new NativeReceiptRefused({ reason:"native run lifecycle malformed" })),
    );
    const identity = { runId:api.runId, runAttempt:api.runAttempt };
    return lifecycle.status === "completed"
      ? { _tag:"Terminal" as const, conclusion:lifecycle.conclusion, ...identity }
      : { _tag:"Pending" as const, status:lifecycle.status, ...identity };
  });

/** Completed API identity admits archive collection independently of workload-authored files. */
export const admitNativeApiEvidence = (rawRequest: unknown, rawApi: unknown, trustedControllerLogin: string) =>
  Effect.gen(function* () {
    const request = yield* admitNativeRequest(rawRequest);
    const api = yield* Schema.decodeUnknown(NativeApiEvidence, { onExcessProperty: "error" })(rawApi).pipe(
      Effect.mapError(() => new NativeReceiptRefused({ reason: "invalid native API evidence" })),
    );
    const x64 = request.target === "x86_64-pc-windows-msvc";
    if (!matchesNativeRunIdentity(request, api, trustedControllerLogin)
      || api.status !== "completed" || api.conclusion !== "success"
      || api.jobStatus !== "completed" || api.jobConclusion !== "success"
      || api.job !== (x64 ? "x86_64" : "aarch64") || !api.labels.includes(x64 ? "windows-2025" : "windows-11-arm"))
      return yield* Effect.fail(new NativeReceiptRefused({ reason: "authentic API job mismatch or failure" }));
    return api;
  });

/** Reviewed same-repository execution is trusted; an API conclusion is still independent of its files. */
export const bindNativeReceipt = (
  admitted: NativeRequest, rawReceipt: unknown, rawApi: unknown, verifiedArtifacts: unknown,
  trustedControllerLogin: string,
) => Effect.gen(function* () {
  if (!Schema.is(NativeControllerLogin)(trustedControllerLogin))
    return yield* Effect.fail(new NativeReceiptRefused({ reason: "configured native controller identity is invalid" }));
  const decode = <A, I>(schema: Schema.Schema<A, I>, raw: unknown) =>
    Schema.decodeUnknown(schema, { onExcessProperty: "error" })(raw).pipe(
      Effect.mapError(() => new NativeReceiptRefused({ reason: "invalid native evidence" })),
    );
  const request = yield* admitNativeRequest(admitted);
  const receipt = yield* decode(NativeReceipt, rawReceipt);
  const api = yield* admitNativeApiEvidence(request, rawApi, trustedControllerLogin);
  const artifacts = yield* decode(Schema.Array(Artifact), verifiedArtifacts);
  const command = nativeCommand(request);
  const x64 = request.target === "x86_64-pc-windows-msvc";
  const fail = (reason: string) => Effect.fail(new NativeReceiptRefused({ reason }));
  if (JSON.stringify(receipt.command) !== JSON.stringify(command))
    return yield* fail("command mismatch");
  for (const key of ["repo", "head", "base", "executor_ref", "nonce", "target", "command_sha256"] as const) {
    if (receipt[key] !== request[key]) return yield* fail(`receipt ${key} mismatch`);
  }
  if (String(api.runId) !== receipt.run_id || String(api.runAttempt) !== receipt.run_attempt || api.job !== receipt.job
    || receipt.runner_arch !== (x64 ? "X64" : "ARM64")) return yield* fail("authentic API job mismatch or failure");
  if (receipt.exit_code !== 0 || receipt.failure !== null) return yield* fail("native subprocess failed");
  const completed = Date.parse(receipt.completed_at), started = Date.parse(receipt.started_at);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started)
    return yield* fail("native completion timestamp mismatch");
  const names = receipt.artifacts.map((item) => item.path.toLowerCase());
  if (names.length === 0 || new Set(names).size !== names.length || !names.includes("command.log"))
    return yield* fail("artifact inventory is empty, ambiguous or lacks command log");
  const sort = (items: readonly typeof Artifact.Type[]) => [...items].sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(sort(receipt.artifacts)) !== JSON.stringify(sort(artifacts)))
    return yield* fail("artifact digest or size mismatch");
  return receipt;
});
