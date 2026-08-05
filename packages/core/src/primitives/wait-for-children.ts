// @fractalboxdev/flare-dispatch-core/primitives — waitForChildren: join on a fan-out.
//
// The other half of `fanOut`: poll the `childRuns` capability for the status of
// each spawned child execution until every one has settled (success / failure /
// cancelled), then return their records — including each terminal child's
// `summaryJson`, so a parent can decode and roll up its children's outputs
// (merge N shard reports into one, count pass/fail, etc.).
//
// Shaped exactly like `cdp-acceptance`'s `pollSentinelExit`: short, cheap polls
// (a single D1 read each) separated by `io.sleep`, never a long-held connection.
// Wall-clock per step is unbounded in CF Workflows, so a parent can wait out a
// 25-minute matrix from inside one `step("await-children", ...)`; only CPU is
// bounded, and a poll is I/O. The loop is bounded by `maxAttempts` derived from
// `timeout / pollEvery` (a count, not a wall-clock read) so it stays
// replay-deterministic — `io.now` drift across a checkpoint resume cannot change
// how many polls run.
//
// Spec: specs/03-dsl.md § Primitives + § spawnChildRun, specs/01-architecture.md
//       § Long-running test handling.

import { Duration, Effect } from "effect";
import { ChildWaitTimeout } from "../errors";
import { type ChildStatusRecord, ChildRuns, isTerminalChildStatus } from "../services/child-runs";
import { IO, io } from "../services/io";

const POLL_EVERY_DEFAULT = "5 seconds";
const TIMEOUT_DEFAULT = "30 minutes";

/**
 * Wait until every child in `ids` reaches a terminal status, returning their
 * status records (input order). Fails `ChildWaitTimeout` if the overall ceiling
 * elapses with children still pending.
 *
 * @example
 * const handles = yield* step("fanout", () => fanOut({ ... }));
 * const results = yield* step("await-children", () =>
 *   waitForChildren({ ids: handles.map((h) => h.executionId) }),
 * );
 * const failed = results.filter((r) => r.status === "failure");
 */
export const waitForChildren = (opts: {
  /** The child execution ids to join on — typically `fanOut` handle ids. */
  readonly ids: readonly string[];
  /** Delay between polls. Default 5s. */
  readonly pollEvery?: Duration.DurationInput;
  /** Overall wait ceiling before `ChildWaitTimeout`. Default 30m. */
  readonly timeout?: Duration.DurationInput;
}): Effect.Effect<readonly ChildStatusRecord[], ChildWaitTimeout, ChildRuns | IO> => {
  const pollEvery = Duration.decode(opts.pollEvery ?? POLL_EVERY_DEFAULT);
  const pollEveryMs = Duration.toMillis(pollEvery);
  const timeoutMs = Duration.toMillis(Duration.decode(opts.timeout ?? TIMEOUT_DEFAULT));
  // At least one poll; one poll per `pollEvery` up to the ceiling.
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollEveryMs)));

  return Effect.gen(function* () {
    // Nothing to wait for — a fan-out over zero items, or a caller that already
    // filtered everything out.
    if (opts.ids.length === 0) return [];

    const childRuns = yield* ChildRuns;
    let last: readonly ChildStatusRecord[] = [];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      last = yield* childRuns.poll({ ids: opts.ids });
      const pending = last.filter((r) => !isTerminalChildStatus(r.status));
      if (pending.length === 0) return last;

      // Don't sleep after the final attempt — fall straight through to timeout.
      if (attempt < maxAttempts - 1) {
        yield* io.sleep(pollEvery);
      } else {
        return yield* Effect.fail(
          new ChildWaitTimeout({
            pending: pending.map((r) => r.executionId),
            waitedMs: attempt * pollEveryMs,
          }),
        );
      }
    }
    // Unreachable (the final-attempt branch returns/fails), but keeps the
    // function total without a non-null assertion.
    return last;
  });
};
