import { Effect, Schema } from "effect";
import {
  admitNativeRequest, NativeApiEvidence, NativeReceiptRefused,
} from "@fractalboxdev/flare-dispatch-core";
import {
  dispatchNativeWindows, readNativeWindowsRuns,
} from "@fractalboxdev/flare-dispatch-github-app";

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
  const listRuns = (raw: unknown) => Effect.gen(function* () {
    yield* scoped(raw);
    const entries = yield* Effect.tryPromise({
      try: () => readNativeWindowsRuns(client),
      catch: () => new NativeReceiptRefused({ reason: "complete native GitHub run evidence unavailable" }),
    });
    const runs = yield* Effect.forEach(entries, (entry) => Schema.decodeUnknown(ApiRun)(entry).pipe(
      Effect.mapError(() => new NativeReceiptRefused({ reason: "native GitHub run evidence malformed" })),
    ));
    return runs.map((run) => ({
      repo: run.repository.full_name, runId: run.id, runAttempt: run.run_attempt, event: run.event,
      executorRef: run.head_sha, workflowPath: run.path, runName: run.display_title,
      actorLogin: run.actor.login, actorType: run.actor.type,
    }));
  });
  return { dispatch, listRuns };
};
