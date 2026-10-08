import { Effect, Schema } from "effect";
import {
  NativeApiEvidence, NativeControllerLogin, NativeReceiptRefused, NativeRequest,
  nativeCommandDigest,
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
});
const Snapshot = Schema.Struct({
  state: Schema.Literal("reserved", "dispatching", "accepted", "bound"),
  runId: Schema.NullOr(Run.fields.runId), runAttempt: Schema.NullOr(Run.fields.runAttempt),
});
type Snapshot = typeof Snapshot.Type;
type Controller = typeof Controller.Type;
type Provider = {
  readonly dispatch: (request: NativeRequest) => Effect.Effect<void, NativeReceiptRefused>;
  /** Complete bounded API evidence; partial pages refuse inside the provider. */
  readonly listRuns: (request: NativeRequest) => Effect.Effect<readonly unknown[], NativeReceiptRefused>;
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

/** A dispatching intent never grants a second POST, including after a lost response or process eviction. */
export const makeNativeDispatchD1 = (db: Pick<D1Database, "prepare">, configured: Controller, provider: Provider) => {
  const identity = (raw: unknown) => Effect.gen(function* () {
    const controller = yield* decode(Controller, configured);
    const request = yield* decode(NativeRequest, raw);
    if ((request.mode === "gate") !== (request.profile === "")
      || request.command_sha256 !== (yield* nativeCommandDigest(request)))
      return yield* refuse("native dispatch command or mode mismatch");
    return { request, controller, text: JSON.stringify(request) };
  });
  type Identity = Effect.Effect.Success<ReturnType<typeof identity>>;

  const read = (id: Identity): Effect.Effect<Snapshot, NativeReceiptRefused> => Effect.gen(function* () {
    const row = yield* query(() => db.prepare(
      `SELECT request_json, controller_app_id, controller_login, state,
              run_id AS runId, run_attempt AS runAttempt
         FROM native_dispatches WHERE repo=? AND nonce=?`,
    ).bind(id.request.repo, id.request.nonce).first<{
      request_json: string; controller_app_id: number; controller_login: string;
      state: string; runId: number | null; runAttempt: number | null;
    }>());
    if (row === null) return yield* refuse("native dispatch intent absent");
    if (row.request_json !== id.text || row.controller_app_id !== id.controller.appId
      || row.controller_login !== id.controller.actorLogin)
      return yield* refuse("native dispatch nonce or controller ownership conflicts");
    const snapshot = yield* decode(Snapshot, { state: row.state, runId: row.runId, runAttempt: row.runAttempt });
    if ((snapshot.state === "bound") !== (snapshot.runId !== null && snapshot.runAttempt !== null))
      return yield* refuse("native dispatch stored run identity invalid");
    return snapshot;
  });
  const observe = (raw: unknown) => Effect.gen(function* () { return yield* read(yield* identity(raw)); });

  const start = (raw: unknown) => Effect.gen(function* () {
    const id = yield* identity(raw);
    yield* query(() => db.prepare(
      `INSERT OR IGNORE INTO native_dispatches
         (repo, nonce, request_json, controller_app_id, controller_login, state)
       VALUES (?, ?, ?, ?, ?, 'reserved')`,
    ).bind(id.request.repo, id.request.nonce, id.text, id.controller.appId, id.controller.actorLogin).run());
    const prior = yield* read(id);
    if (prior.state !== "reserved") return prior;
    const claim = yield* query(() => db.prepare(
      `UPDATE native_dispatches SET state='dispatching'
       WHERE repo=? AND nonce=? AND request_json=? AND controller_app_id=?
         AND controller_login=? AND state='reserved'`,
    ).bind(id.request.repo, id.request.nonce, id.text, id.controller.appId, id.controller.actorLogin).run());
    if (claim.meta.changes !== 1) return yield* read(id);
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
    const rawRuns = yield* provider.listRuns(id.request);
    if (rawRuns.length > 100) return yield* refuse("native dispatch API evidence exceeds its page budget");
    const runs = yield* Effect.forEach(rawRuns, (rawRun) => decode(Run, rawRun));
    const matches = runs.filter((run) => run.runName === `native-${id.request.nonce}`);
    if (matches.length === 0) return prior;
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
