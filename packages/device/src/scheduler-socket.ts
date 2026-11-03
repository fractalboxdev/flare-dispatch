// The client of the local scheduler's Unix socket: one JSON request per line, one JSON answer per line. The socket's
// operations are submit, outcome, failure summary, cancel, queue and lease status (mameko specs/local-scheduler.md
// § Model).
import net from "node:net";
import { Context, Effect, Layer, Schema } from "effect";

export const SOCKET_OPERATIONS = [
  "submit",
  "outcome",
  "failure_summary",
  "cancel",
  "queue",
  "lease_status",
] as const;
export type SocketOperation = (typeof SOCKET_OPERATIONS)[number];

export class SchedulerUnreachable extends Schema.TaggedError<SchedulerUnreachable>()(
  "SchedulerUnreachable",
  {
    detail: Schema.String,
  },
) {}

export class SchedulerRefused extends Schema.TaggedError<SchedulerRefused>()("SchedulerRefused", {
  code: Schema.String,
  message: Schema.String,
}) {}

export class SchedulerSocket extends Context.Service<
  SchedulerSocket,
  {
    readonly call: (
      op: SocketOperation,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<unknown, SchedulerUnreachable | SchedulerRefused>;
  }
>()("@fractalboxdev/flare-dispatch-device/SchedulerSocket") {}

const Answer = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  }),
]);
const decodeAnswer = Schema.decodeUnknownEffect(Answer);

/** Opens one connection per call to the socket at `path`; the scheduler identifies the caller by its peer uid. */
export const schedulerSocketLayer = (
  path: string,
  timeoutMs = 700_000,
): Layer.Layer<SchedulerSocket> =>
  Layer.succeed(SchedulerSocket, {
    call: (op, args) =>
      Effect.gen(function* () {
        const line = yield* Effect.callback<string, SchedulerUnreachable>((resume) => {
          const socket = net.createConnection(path);
          let buffer = "";
          const timer = setTimeout(() => {
            socket.destroy();
            resume(Effect.fail(new SchedulerUnreachable({ detail: "timeout" })));
          }, timeoutMs);
          socket.on("connect", () => socket.write(`${JSON.stringify({ op, ...args })}\n`));
          socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            const end = buffer.indexOf("\n");
            if (end < 0) return;
            clearTimeout(timer);
            socket.end();
            resume(Effect.succeed(buffer.slice(0, end)));
          });
          socket.on("error", (e) => {
            clearTimeout(timer);
            resume(Effect.fail(new SchedulerUnreachable({ detail: e.message })));
          });
          return Effect.sync(() => {
            clearTimeout(timer);
            socket.destroy();
          });
        });
        const parsed = yield* Effect.try({
          try: () => JSON.parse(line) as unknown,
          catch: () =>
            new SchedulerUnreachable({ detail: "the scheduler answered a line that is not JSON" }),
        });
        const answer = yield* decodeAnswer(parsed).pipe(
          Effect.mapError(
            () => new SchedulerUnreachable({ detail: "the scheduler answered an unknown shape" }),
          ),
        );
        if (!answer.ok) return yield* new SchedulerRefused(answer.error);
        return answer.result;
      }),
  });
