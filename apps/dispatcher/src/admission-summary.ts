// FlareDispatch Dispatcher — admission-queue presentation (issue #109).
//
// While a run waits for a global admission slot, the check-run stays
// `in_progress` and its summary carries the queue position so a PR author
// sees back-pressure, not silence. This module holds ONLY the pure line
// formatting — kept out of workflow.ts (which imports `cloudflare:workers`
// and so cannot load under plain Node + Vitest), mirroring
// failure-summary.ts.

/**
 * The "queued" line the admission gate posts to the in-progress check-run —
 * only when the position CHANGES, to bound GitHub API writes.
 *
 * @param position   live queued runs ahead of this one.
 * @param poolBusy   admission slots in use in the run's pool.
 * @param cap        the pool's slot cap (`ADMISSION_CAP`).
 * @param timesOutAt ms-epoch the dispatch-age ceiling lapses (enqueue + max age).
 */
export const queuedSummary = (
  position: number,
  poolBusy: number,
  cap: number,
  timesOutAt: number,
): string => {
  const d = new Date(timesOutAt);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return (
    `Queued — waiting for a sandbox slot behind ${position} ` +
    `run${position === 1 ? "" : "s"} (${poolBusy}/${cap} in use); ` +
    `times out ${hh}:${mm} UTC`
  );
};
