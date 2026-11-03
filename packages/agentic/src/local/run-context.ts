// The local run context's `Intents`: how each append of a local execution is sorted by kind
// (specs/local-scheduler.md § Intents of a local execution).
import { Effect, Schema } from "effect";

/** The kinds that only decorate a local execution's own outcome; each is a logged no-op (FD-LOCAL-018). */
export const DECORATION_KINDS: readonly string[] = ["check.summary", "check.annotations"];

/** An unregistered execution appended a kind that writes outside its own outcome (FD-LOCAL-020, MAMEKO-LOCAL-018). */
export class RegistrationRequired extends Schema.TaggedError<RegistrationRequired>()(
  "RegistrationRequired",
  {
    kind: Schema.String,
  },
) {}

/** The local scheduler holds the request: offline, or the newest grant rejected the execution. */
export class WritebackHeld extends Schema.TaggedError<WritebackHeld>()("WritebackHeld", {
  reason: Schema.Literals(["offline", "grant-rejected"]),
}) {}

/** One intent of a `local.writeback` request, keyed by the run-authored `run:<step name>:<index>` (MAMEKO-RUN-068). */
export interface WritebackIntent {
  readonly intent_key: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface WritebackRequest {
  readonly execution_id: string;
  readonly intents: readonly WritebackIntent[];
}

/** The local scheduler's state the context reads before it sends a writeback request. */
export interface SchedulerState {
  readonly offline: () => boolean;
  /** Whether the newest capacity grant rejected the registered execution. */
  readonly grantRejected: (executionId: string) => boolean;
}

export interface LocalRunContext {
  readonly executionId: string;
  /** Set when the control plane answered `local.register` with an execution id. */
  readonly registered: boolean;
  readonly journal: (entry: {
    readonly kind: string;
    readonly key: string;
    readonly noOp: true;
  }) => void;
  readonly send: (request: WritebackRequest) => Effect.Effect<void>;
  readonly scheduler: SchedulerState;
}

/** The run-authored intent key of the `index`-th append of a step (FD-LOCAL-055). */
export const intentKey = (step: string, index: number): string => `run:${step}:${index}`;

/**
 * One `Intents` append. A decoration kind is journalled as a logged no-op and reaches nothing (FD-LOCAL-018); any other
 * kind fails an unregistered execution's step with `RegistrationRequired` (FD-LOCAL-020) and becomes one
 * `local.writeback` request of a registered execution, keyed by the execution id and `run:<step>:<index>`
 * (FD-LOCAL-019, FD-LOCAL-055). No request is sent while offline (FD-LOCAL-067) or once a grant rejected the
 * execution (FD-LOCAL-071).
 */
export const appendIntent = (
  ctx: LocalRunContext,
  step: string,
  index: number,
  kind: string,
  payload: unknown,
): Effect.Effect<void, RegistrationRequired | WritebackHeld> =>
  Effect.gen(function* () {
    const key = intentKey(step, index);
    if (DECORATION_KINDS.includes(kind)) {
      ctx.journal({ kind, key, noOp: true });
      return;
    }
    if (!ctx.registered) return yield* new RegistrationRequired({ kind });
    if (ctx.scheduler.offline()) return yield* new WritebackHeld({ reason: "offline" });
    if (ctx.scheduler.grantRejected(ctx.executionId))
      return yield* new WritebackHeld({ reason: "grant-rejected" });
    yield* ctx.send({
      execution_id: ctx.executionId,
      intents: [{ intent_key: key, kind, payload }],
    });
  });

/**
 * The control plane's side of the key: a writeback whose (execution id, intent key) it already holds is a duplicate,
 * so a rerun step never writes twice (FD-LOCAL-055).
 */
export const dedupWriteback = (
  seen: Set<string>,
  request: WritebackRequest,
): { readonly fresh: readonly WritebackIntent[]; readonly duplicate: boolean } => {
  const fresh = request.intents.filter((i) => !seen.has(`${request.execution_id}/${i.intent_key}`));
  for (const i of fresh) seen.add(`${request.execution_id}/${i.intent_key}`);
  return { fresh, duplicate: fresh.length === 0 };
};
