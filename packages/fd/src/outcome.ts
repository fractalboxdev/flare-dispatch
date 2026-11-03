// What a command ends with: the exit code of specs/interfaces.md § `fd` commands (FD-IFC-065), the failure that caused
// a non-zero one, and the output rule of `--json`: exactly one JSON document on stdout, every diagnostic on stderr
// (FD-IFC-064).
import { statusOf, type ErrorCode } from "@fractalboxdev/flare-dispatch-api/errors";
import { Context, Effect, Layer, Match, Schema } from "effect";

export const EXIT = {
  /** Command succeeded; with a wait, the verdict is `success`. */
  ok: 0,
  failure: 1,
  usage: 2,
  cancelled: 3,
  skipped: 4,
  /** No verdict: authentication, transport or scheduler unreachable. */
  noVerdict: 5,
  /** The wait ended before a verdict. */
  waitEnded: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A command's failure: the error-model code (or `fd`'s own), its message and the exit code it maps to. */
export class FdFailure extends Schema.TaggedError<FdFailure>()("FdFailure", {
  code: Schema.String,
  message: Schema.String,
  exitCode: Schema.Number,
  /** The error body the route answered, written as the `--json` document. */
  body: Schema.optionalKey(Schema.Unknown),
  /** The HTTP status, when the route answered one; a dispatch retries only a 5xx (FD-IFC-066). */
  status: Schema.optionalKey(Schema.Number),
}) {}

/** The end of a command that already wrote its output. */
export class FdExit extends Schema.TaggedError<FdExit>()("FdExit", { code: Schema.Number }) {}

/**
 * A route's error maps to an exit code by status: an authentication refusal or a server or transport failure leaves no
 * verdict (5); any other 4xx is a request the caller has to change (2).
 */
export const exitForStatus = (status: number): ExitCode =>
  status === 401 || status === 403 || status === 429 || status >= 500 ? EXIT.noVerdict : EXIT.usage;

export const routeFailure = (error: {
  readonly error: string;
  readonly message: string;
  readonly request_id?: string;
  readonly execution_id?: string;
}): FdFailure => {
  const status = statusOf(error.error as ErrorCode);
  const body: Record<string, unknown> = { error: error.error, message: error.message };
  if (error.request_id !== undefined) body["request_id"] = error.request_id;
  if (error.execution_id !== undefined) body["execution_id"] = error.execution_id;
  return new FdFailure({
    code: error.error,
    message: error.message,
    exitCode: exitForStatus(status),
    body,
    status,
  });
};

export const transportFailure = (message: string): FdFailure =>
  new FdFailure({ code: "transport", message, exitCode: EXIT.noVerdict });

/** The exit code of a finished execution's verdict; no verdict (`deferred`, `expired`) is a failure to gate on. */
export const exitForVerdict = (verdict: string | null): ExitCode =>
  Match.value(verdict).pipe(
    Match.when("success", () => EXIT.ok),
    Match.when("cancelled", () => EXIT.cancelled),
    Match.when("skipped", () => EXIT.skipped),
    Match.orElse(() => EXIT.failure),
  );

/** Where a command writes: stdout for its result, stderr for every diagnostic. */
export class Output extends Context.Service<
  Output,
  {
    readonly stdout: (text: string) => Effect.Effect<void>;
    readonly stderr: (text: string) => Effect.Effect<void>;
  }
>()("@fractalboxdev/flare-dispatch-fd/Output") {}

export const OutputLive = Layer.succeed(Output)({
  stdout: (text) => Effect.sync(() => void process.stdout.write(`${text}\n`)),
  stderr: (text) => Effect.sync(() => void process.stderr.write(`${text}\n`)),
});

/** Writes a result: with `--json`, the one JSON document; otherwise the human rendering. */
export const emit = (json: boolean, document: unknown, human: string) =>
  Effect.flatMap(Output, (out) => out.stdout(json ? JSON.stringify(document) : human));

export const diagnostic = (text: string) => Effect.flatMap(Output, (out) => out.stderr(text));

/**
 * Ends a command: a failure writes its body as the JSON document (or its message on stderr) and exits with its code;
 * an explicit exit keeps its code.
 */
export const reporting =
  (json: boolean) =>
  <A, R>(effect: Effect.Effect<A, FdFailure | FdExit, R>): Effect.Effect<A, FdExit, R | Output> =>
    effect.pipe(
      Effect.catchTag("FdFailure", (failure) =>
        Effect.gen(function* () {
          const out = yield* Output;
          if (json)
            yield* out.stdout(
              JSON.stringify(failure.body ?? { error: failure.code, message: failure.message }),
            );
          else yield* out.stderr(`${failure.code}: ${failure.message}`);
          return yield* new FdExit({ code: failure.exitCode });
        }),
      ),
    );
