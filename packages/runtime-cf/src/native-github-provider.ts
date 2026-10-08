import { Effect, Schema } from "effect";
import {
  admitNativeApiEvidence, admitNativeRequest, NativeApiEvidence, NativeControllerLogin, NativeReceiptRefused,
  NativeRunCreatedAt, nativeDiscoveryWindow,
} from "@fractalboxdev/flare-dispatch-core";
import {
  dispatchNativeWindows, readNativeWindowsRun, readNativeWindowsRuns, readNativeWindowsJobs, readNativeWindowsArtifacts,
} from "@fractalboxdev/flare-dispatch-github-app";
import { NATIVE_ARCHIVE_MAX_BYTES } from "./native-archive-r2";

type Client = {
  readonly repo: string; readonly token: string;
  readonly apiBase?: string; readonly fetchImpl?: typeof fetch;
};
const PositiveId = Schema.Number.pipe(Schema.filter((id) => Number.isSafeInteger(id) && id > 0));
const ApiRun = Schema.Struct({
  id: PositiveId, run_attempt: PositiveId,
  event: NativeApiEvidence.fields.event, head_sha: NativeApiEvidence.fields.executorRef,
  path: NativeApiEvidence.fields.workflowPath, display_title: NativeApiEvidence.fields.runName,
  repository: Schema.Struct({ full_name: NativeApiEvidence.fields.repo }),
  actor: Schema.Struct({ login: NativeApiEvidence.fields.actorLogin, type: NativeApiEvidence.fields.actorType }),
});
const CompletedRun = Schema.Struct({ ...ApiRun.fields,
  status: NativeApiEvidence.fields.status, conclusion: NativeApiEvidence.fields.conclusion });
const DiscoveryRun = Schema.Struct({ ...ApiRun.fields, created_at: NativeRunCreatedAt });
const Binding = Schema.Struct({ runId: PositiveId, runAttempt: PositiveId });
const ApiJob = Schema.Struct({ id: PositiveId, run_id: PositiveId,
  head_sha: NativeApiEvidence.fields.executorRef, name: NativeApiEvidence.fields.job,
  status: NativeApiEvidence.fields.jobStatus, conclusion: NativeApiEvidence.fields.jobConclusion,
  labels: NativeApiEvidence.fields.labels });
const ApiArtifact = Schema.Struct({ id: PositiveId, name: Schema.String, expired: Schema.Boolean,
  size_in_bytes: Schema.Number.pipe(Schema.filter((n) => Number.isSafeInteger(n) && n >= 22 && n <= NATIVE_ARCHIVE_MAX_BYTES)),
  workflow_run: Schema.Struct({ id: PositiveId, head_sha: NativeApiEvidence.fields.executorRef }) });
const refuse = (reason: string) => new NativeReceiptRefused({ reason });
const decode = <A, I>(schema: Schema.Schema<A, I>, raw: unknown) => Schema.decodeUnknown(schema)(raw).pipe(
  Effect.mapError(() => refuse("native GitHub evidence malformed")),
);

/** Installation credentials remain headers on the reviewed repository's fixed native workflow. */
export const makeNativeGithubProvider = (client: Client) => {
  const scoped = (raw: unknown) => Effect.gen(function* () {
    const request = yield* admitNativeRequest(raw);
    if (request.repo !== client.repo || client.token.length === 0)
      return yield* Effect.fail(new NativeReceiptRefused({ reason: "native GitHub repository or credential scope invalid" }));
    return request;
  });
  const dispatch = (raw: unknown) => Effect.gen(function* () {
    const request = yield* scoped(raw);
    yield* Effect.tryPromise({
      try: () => dispatchNativeWindows({ ...client, executorRef: request.executor_ref, request }),
      catch: () => new NativeReceiptRefused({ reason: "native GitHub dispatch outcome uncertain" }),
    });
  });
  const listRuns = (raw: unknown, rawAdmission: unknown) => Effect.gen(function* () {
    yield* scoped(raw);
    const window = yield* nativeDiscoveryWindow(rawAdmission);
    const entries = yield* Effect.tryPromise({
      try: () => readNativeWindowsRuns({ ...client, createdAfter: window.createdAfter }),
      catch: () => new NativeReceiptRefused({ reason: "complete native GitHub run evidence unavailable" }),
    });
    const runs = yield* Effect.forEach(entries, (entry) => Schema.decodeUnknown(DiscoveryRun)(entry).pipe(
      Effect.mapError(() => new NativeReceiptRefused({ reason: "native GitHub run evidence malformed" })),
    ));
    return runs.map((run) => ({
      repo: run.repository.full_name, runId: run.id, runAttempt: run.run_attempt, event: run.event,
      executorRef: run.head_sha, workflowPath: run.path, runName: run.display_title,
      actorLogin: run.actor.login, actorType: run.actor.type,
      createdAt: run.created_at,
    }));
  });
  const collect = (raw: unknown, rawBinding: unknown, controllerLogin: string) => Effect.gen(function* () {
    const request = yield* scoped(raw);
    const binding = yield* Schema.decodeUnknown(Binding, { onExcessProperty: "error" })(rawBinding).pipe(
      Effect.mapError(() => refuse("native durable run binding invalid")),
    );
    if (!Schema.is(NativeControllerLogin)(controllerLogin))
      return yield* Effect.fail(refuse("native controller identity invalid"));
    const rawRun = yield* Effect.tryPromise({
      try: () => readNativeWindowsRun({ ...client, runId: binding.runId, attempt: binding.runAttempt }),
      catch: () => refuse("complete native GitHub run evidence unavailable") });
    const run = yield* decode(CompletedRun, rawRun);
    if (run.id !== binding.runId || run.run_attempt !== binding.runAttempt)
      return yield* Effect.fail(refuse("native run differs from durable binding"));
    const rawJobs = yield* Effect.tryPromise({
      try: () => readNativeWindowsJobs({ ...client, runId: binding.runId, attempt: binding.runAttempt }),
      catch: () => refuse("complete native GitHub job evidence unavailable"),
    });
    const jobs = yield* Effect.forEach(rawJobs, (entry) => decode(ApiJob, entry));
    const targetJobs = jobs.filter((job) => job.name === (request.target === "x86_64-pc-windows-msvc" ? "x86_64" : "aarch64"));
    if (targetJobs.length !== 1) return yield* Effect.fail(refuse("native target job absent or ambiguous"));
    const job = targetJobs[0]!;
    if (job.run_id !== binding.runId || job.head_sha !== run.head_sha)
      return yield* Effect.fail(refuse("native target job run identity mismatch"));
    const api = yield* admitNativeApiEvidence(request, {
      repo: run.repository.full_name, runId: run.id, runAttempt: run.run_attempt, event: run.event,
      executorRef: run.head_sha, workflowPath: run.path, runName: run.display_title,
      actorLogin: run.actor.login, actorType: run.actor.type, status: run.status, conclusion: run.conclusion,
      job: job.name, jobStatus: job.status, jobConclusion: job.conclusion, labels: job.labels,
    }, controllerLogin);
    const rawArtifacts = yield* Effect.tryPromise({
      try: () => readNativeWindowsArtifacts({ ...client, runId: binding.runId }),
      catch: () => refuse("complete native GitHub artifact evidence unavailable"),
    });
    const artifacts = yield* Effect.forEach(rawArtifacts, (entry) => decode(ApiArtifact, entry));
    const targetArtifacts = artifacts.filter((artifact) => artifact.name === api.runName);
    if (targetArtifacts.length !== 1) return yield* Effect.fail(refuse("native archive identity absent or ambiguous"));
    const artifact = targetArtifacts[0]!;
    if (artifact.expired || artifact.workflow_run.id !== binding.runId || artifact.workflow_run.head_sha !== request.executor_ref)
      return yield* Effect.fail(refuse("native archive expired or run identity mismatch"));
    return { api, artifactId: artifact.id };
  });
  return { dispatch, listRuns, collect };
};
