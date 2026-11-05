// The dispatch exchange `fd dispatch` and the dispatch action share (specs/interfaces.md § Dispatch with wait): a POST
// retried on a 5xx or a network failure up to 3 attempts with a backoff of attempt × 5 s, every 4xx final (FD-IFC-057,
// FD-IFC-066), then polls with `wait=60` until the execution is done or the wait timeout passes (FD-IFC-059).
import type {
  DispatchBody,
  Dispatched,
  ExecutionView,
} from "@fractalboxdev/flare-dispatch-api/declaration";
import { Duration, Effect } from "effect";
import { call, type ApiClient } from "./client.ts";
import { EXIT, FdFailure } from "./outcome.ts";

export const DISPATCH_ATTEMPTS = 3;
export const BACKOFF_STEP_MS = 5_000;
export const POLL_WAIT_S = 60;
export const DEFAULT_WAIT_TIMEOUT_S = 3_600;

/** A 5xx or a failure with no status (the network) is retried; every 4xx is final. */
export const retryable = (failure: FdFailure): boolean =>
  failure.status === undefined ? failure.code === "transport" : failure.status >= 500;

/** Runs `attempt` up to 3 times, sleeping attempt × 5 s after each retryable failure. */
export const withDispatchRetry = <A, R, R2 = never>(
  attempt: Effect.Effect<A, FdFailure, R>,
  onRetry: (failure: FdFailure, next: number) => Effect.Effect<void, never, R2> = () => Effect.void,
): Effect.Effect<A, FdFailure, R | R2> => {
  const loop = (n: number): Effect.Effect<A, FdFailure, R | R2> =>
    attempt.pipe(
      Effect.catch((failure) =>
        n >= DISPATCH_ATTEMPTS || !retryable(failure)
          ? Effect.fail(failure)
          : onRetry(failure, n + 1).pipe(
              Effect.andThen(Effect.sleep(Duration.millis(n * BACKOFF_STEP_MS))),
              Effect.andThen(loop(n + 1)),
            ),
      ),
    );
  return loop(1);
};

/** A dispatch carries no `Idempotency-Key`; the commit-scoped dedup key dedups its retries (FD-IFC-056). */
export const dispatchOnce = (
  client: ApiClient,
  run: string,
  body: DispatchBody,
): Effect.Effect<Dispatched, FdFailure> =>
  call(client.dispatch.dispatch({ params: { run }, headers: {}, payload: body }));

export const dispatchWithRetry = <R2 = never>(
  client: ApiClient,
  run: string,
  body: DispatchBody,
  onRetry?: (failure: FdFailure, next: number) => Effect.Effect<void, never, R2>,
): Effect.Effect<Dispatched, FdFailure, R2> =>
  withDispatchRetry(dispatchOnce(client, run, body), onRetry);

/** The execution once it is done, or exit 6 when the timeout passes first. */
export const awaitDone = (
  client: ApiClient,
  executionId: string,
  timeoutS: number,
): Effect.Effect<ExecutionView, FdFailure> =>
  Effect.gen(function* () {
    const until = Date.now() + timeoutS * 1000;
    while (true) {
      const remaining = Math.ceil((until - Date.now()) / 1000);
      const wait = Math.max(1, Math.min(POLL_WAIT_S, remaining));
      const view = yield* call(
        client.executions.get({ params: { id: executionId }, query: { wait: String(wait) } }),
      );
      if (view.status === "done") return view;
      if (Date.now() >= until)
        return yield* new FdFailure({
          code: "wait_ended",
          message: `execution ${executionId} is ${view.status} after ${timeoutS} s`,
          exitCode: EXIT.waitEnded,
          body: view,
        });
    }
  });
