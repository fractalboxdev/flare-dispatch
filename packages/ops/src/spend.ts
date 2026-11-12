// The spend view `GET /v1/spend` reads and the requester attribution of a reserve debit (specs/spend.md FD-SPD-057,
// FD-SPD-060). The spend view itself is mameko's (MAMEKO-SPD-058); `SpendView` is the coordinator operation the
// operability group's `spend` handler calls.
import type { SpendViewBody } from "@fractalboxdev/flare-dispatch-api/declaration";
import { Context, Effect, Schema } from "effect";

/** The spend view of MAMEKO-SPD-058, in micro-USD: the declaration's response schema of `GET /v1/spend`. */
export { SpendViewBody } from "@fractalboxdev/flare-dispatch-api/declaration";

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
