// `GET /v1/spend` and the requester attribution of a reserve debit (specs/spend.md FD-SPD-057, FD-SPD-058, FD-SPD-060).
// The spend view itself is mameko's (MAMEKO-SPD-058); `SpendView` is the coordinator operation the route calls.
import { Context, Effect, Schema } from "effect";

/** The spend view of MAMEKO-SPD-058, in micro-USD. */
export const SpendViewBody = Schema.Struct({
  month: Schema.String,
  budget: Schema.Number,
  settled: Schema.Number,
  reserved: Schema.Number,
  committed: Schema.Number,
  classes: Schema.Array(
    Schema.Struct({
      class: Schema.String,
      line: Schema.Number,
      lane: Schema.Number,
      admitted_list_rate: Schema.Number,
      reserve: Schema.Number,
    }),
  ),
  floor: Schema.Number,
  measured_reserve_runway_days: Schema.NullOr(Schema.Number),
  control_state: Schema.Literals(["run", "halt-cloud", "halt-all"]),
  resets_at: Schema.Number,
});
export type SpendViewBody = typeof SpendViewBody.Type;

/** The runtime adapter's store could not be read for the view (MAMEKO-SPD-059). */
export class SpendUnreadable extends Schema.TaggedError<SpendUnreadable>()("SpendUnreadable", {
  reason: Schema.String,
}) {}

/** The coordinator's spend view for one UTC month. */
export class SpendView extends Context.Service<
  SpendView,
  { readonly view: (month: string) => Effect.Effect<SpendViewBody, SpendUnreadable> }
>()("@fractalboxdev/flare-dispatch-ops/SpendView") {}

/** The UTC month `YYYY-MM` of `now`. */
export const utcMonth = (now: number): string => new Date(now).toISOString().slice(0, 7);

/**
 * `GET /v1/spend` for an authorized viewer: the view of the current UTC month (FD-SPD-057), or `503
 * spend_unreadable` when the store cannot be read (FD-SPD-058).
 */
export const spendRoute = (now: number, requestId: string) =>
  Effect.gen(function* () {
    const spend = yield* SpendView;
    return yield* spend.view(utcMonth(now)).pipe(
      Effect.map((body) => Response.json(body)),
      Effect.catchTag("SpendUnreadable", () =>
        Effect.succeed(
          Response.json(
            {
              error: "spend_unreadable",
              message: "the spend store cannot be read",
              request_id: requestId,
            },
            { status: 503 },
          ),
        ),
      ),
    );
  });

/** The team and member that requested an execution, which a reserve debit records (FD-SPD-060, MAMEKO-SPD-061). */
export interface RequesterAttribution {
  readonly team: string | null;
  readonly member: string | null;
}

/**
 * The requester of an execution: the team is the repository's owner and the member the GitHub login that triggered
 * it, the webhook `sender`, the OIDC `actor` or the Access identity of a dispatch.
 */
export const requesterAttribution = (request: {
  readonly repository: string;
  readonly sender?: string;
  readonly actor?: string;
  readonly accessIdentity?: string;
}): RequesterAttribution => ({
  team: request.repository.includes("/")
    ? request.repository.slice(0, request.repository.indexOf("/"))
    : null,
  member: request.sender ?? request.actor ?? request.accessIdentity ?? null,
});
