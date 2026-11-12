// `GET /v1/executions`, `GET /v1/executions/:id`, its failure summary and its cancel (FD-IFC-037 to FD-IFC-046).
import { Effect, Match } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ApiConfig } from "../config.ts";
import { FlareDispatchApi, type ExecutionView } from "../declaration.ts";
import { apiError, type ApiError } from "../errors.ts";
import { CurrentIdentity, inGroup } from "../identity.ts";
import { boundIncident, confidentialIncident } from "../incident.ts";
import { Cancellation, Executions, FailureSummaries, type ExecutionRecord } from "../ports.ts";
import { RequestId } from "../request-id.ts";

export const DEFAULT_PAGE = 50;
export const WAIT_POLL_MS = 500;

/** The view a route returns: the record without who dispatched it. */
export const viewOf = ({ dispatchedBy: _by, ...view }: ExecutionRecord): ExecutionView => view;

/** `wait` is a whole number of seconds from 1 to 60 (FD-IFC-041); absent, the route answers at once. */
export const parseWait = (raw: string | undefined): Effect.Effect<number, ApiError> => {
  if (raw === undefined) return Effect.succeed(0);
  const seconds = Number(raw);
  return /^\d+$/.test(raw) && seconds >= 1 && seconds <= 60
    ? Effect.succeed(seconds)
    : Effect.fail(apiError("invalid_wait", "wait is a whole number from 1 to 60"));
};

const found = (id: string) =>
  Effect.gen(function* () {
    const executions = yield* Executions;
    const record = yield* executions.get(id);
    if (record === undefined) return yield* apiError("execution_not_found", `no execution ${id}`);
    return record;
  });

/**
 * An Actions identity reads only its own repository's executions; any other answers `execution_not_found`, so an id
 * reveals nothing outside the token's repository.
 */
export const ownedByCaller = (id: string) =>
  Effect.gen(function* () {
    const identity = yield* CurrentIdentity;
    const record = yield* found(id);
    const foreign = Match.value(identity).pipe(
      Match.tag(
        "Actions",
        ({ repository }) => repository.toLowerCase() !== record.repository.toLowerCase(),
      ),
      Match.orElse(() => false),
    );
    if (foreign) return yield* apiError("execution_not_found", `no execution ${id}`);
  });

/** Holds the answer until the execution is `done` or the wait ends (FD-IFC-040). */
export const awaitExecution = (id: string, waitSeconds: number) =>
  Effect.gen(function* () {
    const until = Date.now() + waitSeconds * 1000;
    while (true) {
      const record = yield* found(id);
      if (record.status === "done" || Date.now() >= until) return record;
      yield* Effect.sleep(Math.min(WAIT_POLL_MS, Math.max(0, until - Date.now())));
    }
  });

/**
 * The bounded `incident/v1` pack of a failed execution (FD-IFC-042 to FD-IFC-044); a `confidential-compute`
 * repository's pack carries only the reason and the failing step names (FD-IFC-045).
 */
export const failureSummary = (id: string) =>
  Effect.gen(function* () {
    const record = yield* found(id);
    if (record.status !== "done")
      return yield* apiError("not_finished", `execution ${id} has not finished`);
    if (record.verdict !== "failure")
      return yield* apiError("not_failed", `execution ${id} did not fail`);
    const summaries = yield* FailureSummaries;
    const mode = yield* summaries.confidentiality(record.repository);
    const pack = yield* summaries.pack(record);
    return boundIncident(mode === "confidential-compute" ? confidentialIncident(pack) : pack);
  });

/** Only the identity that dispatched an execution, an operator or a `containment` identity may cancel it (FD-IFC-046). */
export const cancelExecution = (id: string) =>
  Effect.gen(function* () {
    const identity = yield* CurrentIdentity;
    const config = yield* ApiConfig;
    const requestId = yield* RequestId;
    const record = yield* found(id);
    const caller = Match.value(identity).pipe(
      Match.tag("Access", "Actions", ({ id: who }) => who),
      Match.orElse(() => undefined),
    );
    const allowed =
      caller !== undefined &&
      (record.dispatchedBy === caller || inGroup(config, "containment", caller));
    if (!allowed)
      return yield* apiError(
        "forbidden",
        "only the dispatcher, an operator or a containment identity may cancel this execution",
      );
    const cancellation = yield* Cancellation;
    yield* cancellation.cancel({ executionId: id, identity: caller, requestId });
    return viewOf(yield* found(id));
  });

export const ExecutionsHandlers = HttpApiBuilder.group(FlareDispatchApi, "executions", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      Effect.gen(function* () {
        const executions = yield* Executions;
        const limit = query.limit ?? DEFAULT_PAGE;
        const { rows, more } = yield* executions.list({
          limit,
          ...(query.run === undefined ? {} : { run: query.run }),
          ...(query.repository === undefined ? {} : { repository: query.repository }),
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.class === undefined ? {} : { class: query.class }),
          ...(query.executor_kind === undefined ? {} : { executorKind: query.executor_kind }),
          ...(query.before === undefined ? {} : { before: query.before }),
          ...(query.finished_since === undefined ? {} : { finishedSince: query.finished_since }),
        });
        const last = rows.at(-1);
        return {
          executions: rows.map(viewOf),
          ...(more && last !== undefined ? { next_before: last.execution_id } : {}),
        };
      }),
    )
    .handle("get", ({ params, query }) =>
      Effect.gen(function* () {
        const wait = yield* parseWait(query.wait);
        yield* ownedByCaller(params.id);
        return viewOf(yield* awaitExecution(params.id, wait));
      }),
    )
    .handle("failureSummary", ({ params }) => failureSummary(params.id))
    .handle("cancel", ({ params }) => cancelExecution(params.id)),
);
