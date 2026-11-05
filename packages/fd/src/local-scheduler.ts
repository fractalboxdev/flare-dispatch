// The local scheduler's Unix socket, which `fd mcp` and the `rehearse`, `queue` and `lease` commands reach. The socket's
// operations are submit, outcome, failure summary, cancel, queue and lease status ([mameko local-scheduler.md
// § Overview]). An absent socket, or one that refuses the connection, answers `scheduler_unreachable` and exit 5
// (FD-IFC-069).
import { connect } from "node:net";
import type { IncidentV1 } from "@fractalboxdev/flare-dispatch-api/declaration";
import type { LeaseStatus, LocalExecution } from "@fractalboxdev/flare-dispatch-api/mcp-tools";
import { Context, Effect, Layer } from "effect";
import { FdConfig } from "./config.ts";
import { EXIT, FdFailure } from "./outcome.ts";

/** Local execution ids are `local-` and a ULID (FD-IFC-076); every other id is the control plane's. */
export const isLocalId = (id: string): boolean => id.startsWith("local-");

export interface LocalSubmission {
  readonly run: string;
  readonly inputs: unknown;
  /** `rehearsal` unless the caller names another local class. */
  readonly class: string;
}

export class LocalScheduler extends Context.Service<
  LocalScheduler,
  {
    readonly submit: (submission: LocalSubmission) => Effect.Effect<LocalExecution, FdFailure>;
    readonly outcome: (id: string, waitSeconds: number) => Effect.Effect<LocalExecution, FdFailure>;
    readonly failureSummary: (id: string) => Effect.Effect<IncidentV1, FdFailure>;
    readonly cancel: (id: string) => Effect.Effect<LocalExecution, FdFailure>;
    readonly queue: Effect.Effect<readonly LocalExecution[], FdFailure>;
    readonly leaseStatus: Effect.Effect<LeaseStatus, FdFailure>;
  }
>()("@fractalboxdev/flare-dispatch-fd/LocalScheduler") {}

export const schedulerUnreachable = (message: string) =>
  new FdFailure({ code: "scheduler_unreachable", message, exitCode: EXIT.noVerdict });

/** Connects to the socket and closes again: `undefined` when it accepts, the failure when it is absent or refuses. */
export const probeSocket = (path: string | undefined): Effect.Effect<void, FdFailure> =>
  path === undefined
    ? Effect.fail(schedulerUnreachable("no local scheduler socket: set FD_SCHEDULER_SOCKET"))
    : Effect.callback<void, FdFailure>((resume) => {
        const socket = connect(path);
        socket.once("connect", () => {
          socket.destroy();
          resume(Effect.void);
        });
        socket.once("error", (error: NodeJS.ErrnoException) =>
          resume(
            Effect.fail(
              schedulerUnreachable(
                `the local scheduler socket ${path} is unreachable (${error.code ?? error.message})`,
              ),
            ),
          ),
        );
      });

/**
 * The socket client. mameko names the socket's operations but not their wire format, so once the socket accepts, every
 * operation answers `scheduler_protocol` naming that gap rather than guessing a format.
 */
export const LocalSchedulerSocket = Layer.effect(LocalScheduler)(
  Effect.gen(function* () {
    const { schedulerSocket } = yield* FdConfig;
    const unspecified = <A>(operation: string): Effect.Effect<A, FdFailure> =>
      probeSocket(schedulerSocket).pipe(
        Effect.andThen(
          Effect.fail(
            new FdFailure({
              code: "scheduler_protocol",
              message: `the local scheduler's ${operation} operation has no wire format in the pinned mameko release`,
              exitCode: EXIT.noVerdict,
            }),
          ),
        ),
      );
    return LocalScheduler.of({
      submit: () => unspecified("submit"),
      outcome: () => unspecified("outcome"),
      failureSummary: () => unspecified("failure summary"),
      cancel: () => unspecified("cancel"),
      queue: unspecified("queue"),
      leaseStatus: unspecified("lease status"),
    });
  }),
);
