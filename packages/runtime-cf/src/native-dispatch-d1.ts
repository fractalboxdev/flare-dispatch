import { Effect, Schema } from "effect";
import {
  NativeApiEvidence, NativeControllerLogin, NativeReceiptRefused, NativeRequest,
  admitNativeRequest,
  NativeAdmissionTime, NativeRunCreatedAt, nativeDiscoveryWindow,
  admitNativeReadBinding, bindNativeReadRequest,
  NativeControllerPolicy, nativeControllerDeadline, assertNativeControllerDeadline,
} from "@fractalboxdev/flare-dispatch-core";

const Controller = Schema.Struct({
  appId: Schema.Number.pipe(Schema.filter((id) => Number.isSafeInteger(id) && id > 0)),
  actorLogin: NativeControllerLogin,
});
const Run = Schema.Struct({
  repo: NativeApiEvidence.fields.repo, runId: NativeApiEvidence.fields.runId,
  runAttempt: NativeApiEvidence.fields.runAttempt, event: NativeApiEvidence.fields.event,
  executorRef: NativeApiEvidence.fields.executorRef, workflowPath: NativeApiEvidence.fields.workflowPath,
  runName: NativeApiEvidence.fields.runName, actorLogin: NativeApiEvidence.fields.actorLogin,
  actorType: NativeApiEvidence.fields.actorType,
  createdAt: NativeRunCreatedAt,
});
const Snapshot = Schema.Struct({
  state: Schema.Literal("reserved", "dispatching", "accepted", "bound"),
  runId: Schema.NullOr(Run.fields.runId), runAttempt: Schema.NullOr(Run.fields.runAttempt),
  admittedAt: NativeAdmissionTime,
  deadlineAt: Schema.optional(NativeAdmissionTime),
});
type Snapshot = typeof Snapshot.Type;
type Controller = typeof Controller.Type;
type Provider = {
  readonly dispatch: (request: NativeRequest) => Effect.Effect<void, NativeReceiptRefused>;
  /** Complete bounded API evidence; partial pages refuse inside the provider. */
  readonly listRuns: (request: NativeRequest, admittedAt: number) => Effect.Effect<readonly unknown[], NativeReceiptRefused>;
  readonly readRun: (request: NativeRequest, binding: { readonly runId: number; readonly runAttempt: number }) => Effect.Effect<unknown, NativeReceiptRefused>;
};
const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknown(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => new NativeReceiptRefused({ reason: "native dispatch identity invalid" })),
  );
const query = <A>(operation: () => Promise<A>) => Effect.tryPromise({
  try: operation,
  catch: () => new NativeReceiptRefused({ reason: "native dispatch persistence outcome uncertain" }),
});
const refuse = (reason: string) => Effect.fail(new NativeReceiptRefused({ reason }));

/** Dispatch and reader admission use the same persisted ownership and state validation. */
const readDispatchRecord = (db: Pick<D1Database, "prepare">, repo: string, nonce: string) => Effect.gen(function* () {
  const row = yield* query(() => db.prepare(
    `SELECT request_json, controller_app_id, controller_login, state,
            run_id AS runId, run_attempt AS runAttempt, admitted_at AS admittedAt,
            timeout_sec AS timeoutSec, deadline_at AS deadlineAt, unixepoch('now') AS observedAt
       FROM native_dispatches WHERE repo=? AND nonce=?`,
  ).bind(repo, nonce).first<{
    request_json:string; controller_app_id:number; controller_login:string;
    state:string; runId:number | null; runAttempt:number | null; admittedAt:number | null;
    timeoutSec:number | null; deadlineAt:number | null; observedAt:number;
  }>());
  if (row === null) return yield* refuse("native dispatch intent absent");
  const controller = yield* decode(Controller, { appId:row.controller_app_id, actorLogin:row.controller_login });
  const snapshot = yield* decode(Snapshot, { state:row.state, runId:row.runId, runAttempt:row.runAttempt, admittedAt:row.admittedAt });
  yield* nativeDiscoveryWindow(snapshot.admittedAt);
  if ((snapshot.state === "bound") !== (snapshot.runId !== null && snapshot.runAttempt !== null))
    return yield* refuse("native dispatch stored run identity invalid");
  const request = yield* admitNativeRequest(yield* decode(Schema.parseJson(NativeRequest), row.request_json));
  if (request.repo !== repo || request.nonce !== nonce) return yield* refuse("native dispatch stored request identity conflicts");
  const policy = row.timeoutSec === null && row.deadlineAt === null ? undefined
    : yield* nativeControllerDeadline({ timeoutSec:row.timeoutSec }, snapshot.admittedAt);
  if (policy !== undefined && row.deadlineAt !== policy.deadlineAt)
    return yield* refuse("native dispatch stored deadline conflicts");
  const observedAt = yield* decode(NativeAdmissionTime, row.observedAt);
  return { request, controller, snapshot, policy, observedAt, text:row.request_json };
});

/** HMAC verification belongs to the route; durable controller authority remains a D1 fact. */
export const readNativeResultOwnerD1 = (
  db: Pick<D1Database, "prepare">, rawBinding: unknown, configuredAppId: number, now: number,
) => Effect.gen(function* () {
  const binding = yield* admitNativeReadBinding(rawBinding, now);
  const appId = yield* decode(Controller.fields.appId, configuredAppId);
  const record = yield* readDispatchRecord(db, binding.repo, binding.nonce);
  if (record.controller.appId !== appId) return yield* refuse("native reader controller ownership conflicts");
  if (record.snapshot.state !== "bound" || record.snapshot.runId === null || record.snapshot.runAttempt === null)
    return yield* refuse("native reader run binding absent");
  const request = yield* bindNativeReadRequest(binding, record.request);
  return { request, controllerLogin:record.controller.actorLogin, runId:record.snapshot.runId, runAttempt:record.snapshot.runAttempt };
});

/** A dispatching intent never grants a second POST, including after a lost response or process eviction. */
export const makeNativeDispatchD1 = (
  db: Pick<D1Database, "prepare">, configured: Controller, provider: Provider, configuredPolicy?: NativeControllerPolicy,
) => {
  const identity = (raw: unknown) => Effect.gen(function* () {
    const controller = yield* decode(Controller, configured);
    const request = yield* admitNativeRequest(raw);
    const policy = configuredPolicy === undefined ? undefined : yield* decode(NativeControllerPolicy, configuredPolicy);
    if (policy !== undefined) yield* nativeControllerDeadline(policy, Math.floor(Date.now() / 1000));
    return { request, controller, policy, text: JSON.stringify(request) };
  });
  type Identity = Effect.Effect.Success<ReturnType<typeof identity>>;

  const read = (id: Identity): Effect.Effect<Snapshot, NativeReceiptRefused> => Effect.gen(function* () {
    const record = yield* readDispatchRecord(db, id.request.repo, id.request.nonce);
    if (record.text !== id.text || record.controller.appId !== id.controller.appId
      || record.controller.actorLogin !== id.controller.actorLogin)
      return yield* refuse("native dispatch nonce or controller ownership conflicts");
    if (id.policy?.timeoutSec !== record.policy?.timeoutSec)
      return yield* refuse("native controller deadline policy conflicts or is absent");
    if (record.policy !== undefined) {
      yield* assertNativeControllerDeadline(record.policy.deadlineAt, record.observedAt);
      // Database responses can arrive late; the trusted live clock admits the next side effect after the response.
      yield* assertNativeControllerDeadline(record.policy.deadlineAt, Math.floor(Date.now() / 1000));
    }
    return record.policy === undefined ? record.snapshot : { ...record.snapshot, deadlineAt: record.policy.deadlineAt };
  });
  const observe = (raw: unknown) => Effect.gen(function* () { return yield* read(yield* identity(raw)); });

  const start = (raw: unknown) => Effect.gen(function* () {
    const id = yield* identity(raw);
    yield* query(() => db.prepare(
      `INSERT OR IGNORE INTO native_dispatches
         (repo, nonce, request_json, controller_app_id, controller_login, state, admitted_at, timeout_sec, deadline_at)
       VALUES (?, ?, ?, ?, ?, 'reserved', unixepoch('now'), ?,
         CASE WHEN ? IS NULL THEN NULL ELSE unixepoch('now') + ? END)`,
    ).bind(id.request.repo, id.request.nonce, id.text, id.controller.appId, id.controller.actorLogin,
      id.policy?.timeoutSec ?? null, id.policy?.timeoutSec ?? null, id.policy?.timeoutSec ?? null).run());
    const prior = yield* read(id);
    if (prior.state !== "reserved") return prior;
    const claim = yield* query(() => db.prepare(
      `UPDATE native_dispatches SET state='dispatching'
       WHERE repo=? AND nonce=? AND request_json=? AND controller_app_id=?
         AND controller_login=? AND state='reserved'
         AND ((timeout_sec IS NULL AND deadline_at IS NULL AND ? IS NULL)
           OR (timeout_sec=? AND deadline_at=admitted_at+timeout_sec AND deadline_at>unixepoch('now')))`,
    ).bind(id.request.repo, id.request.nonce, id.text, id.controller.appId, id.controller.actorLogin,
      id.policy?.timeoutSec ?? null, id.policy?.timeoutSec ?? null).run());
    if (claim.meta.changes !== 1) return yield* read(id);
    // A successful claim response can be delayed; immutable admission still precedes the actual POST.
    yield* read(id);
    return yield* provider.dispatch(id.request).pipe(Effect.matchEffect({
      onFailure: () => read(id),
      onSuccess: () => Effect.gen(function* () {
        yield* query(() => db.prepare(
          `UPDATE native_dispatches SET state='accepted'
           WHERE repo=? AND nonce=? AND state='dispatching'`,
        ).bind(id.request.repo, id.request.nonce).run());
        return yield* read(id);
      }),
    }));
  });

  const reconcile = (raw: unknown) => Effect.gen(function* () {
    const id = yield* identity(raw);
    const prior = yield* read(id);
    if (prior.state === "reserved") return prior;
    const window = yield* nativeDiscoveryWindow(prior.admittedAt);
    const rawRuns = prior.state === "bound"
      ? [yield* provider.readRun(id.request, { runId: prior.runId!, runAttempt: prior.runAttempt! })]
      : yield* provider.listRuns(id.request, prior.admittedAt);
    if (rawRuns.length > 100) return yield* refuse("native dispatch API evidence exceeds its page budget");
    const runs = yield* Effect.forEach(rawRuns, (rawRun) => decode(Run, rawRun));
    if (runs.some((run) => Date.parse(run.createdAt) < window.lowerSeconds * 1000))
      return yield* refuse("native dispatch API candidate predates admission window");
    const matches = runs.filter((run) => run.runName === `native-${id.request.nonce}`);
    if (matches.length === 0) {
      if (prior.state === "bound") return yield* refuse("native exact run nonce conflicts with durable binding");
      return prior;
    }
    if (matches.length !== 1) return yield* refuse("native dispatch API identity is ambiguous");
    const run = matches[0]!;
    if (!Number.isSafeInteger(run.runId) || !Number.isSafeInteger(run.runAttempt)
      || run.repo !== id.request.repo || run.event !== "workflow_dispatch"
      || run.executorRef !== id.request.executor_ref || run.workflowPath !== ".github/workflows/native-windows.yml"
      || run.actorType !== "Bot" || run.actorLogin !== id.controller.actorLogin)
      return yield* refuse("native dispatch API identity mismatch");
    if (prior.state === "bound" && (prior.runId !== run.runId || prior.runAttempt !== run.runAttempt))
      return yield* refuse("native dispatch API identity conflicts with durable binding");
    yield* query(() => db.prepare(
      `UPDATE native_dispatches SET state='bound', run_id=?, run_attempt=?
       WHERE repo=? AND nonce=? AND state IN ('dispatching','accepted')`,
    ).bind(run.runId, run.runAttempt, id.request.repo, id.request.nonce).run());
    const bound = yield* read(id);
    if (bound.state !== "bound" || bound.runId !== run.runId || bound.runAttempt !== run.runAttempt)
      return yield* refuse("native dispatch binding changed during reconciliation");
    return bound;
  });
  return { start, observe, reconcile };
};
