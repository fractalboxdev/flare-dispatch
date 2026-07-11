// FlareDispatch Dispatcher — `GET /health`.
//
// A liveness probe that also surfaces the deploy's run catalog, so a caller
// can confirm a run exists before dispatching it. Response shape per
// specs/pm/plan.md § 5 acceptance step 4:
//
//   { "status": "ok", "runs": ["offload-test"] }
//
// `runs` is sourced from the run registry — it stays in sync as runs are
// added in V1+ with no change here.

import { runNames } from "../registry";

/**
 * Handle `GET /health` — `200 { status: "ok", runs: [...] }`.
 */
export const handleHealth = (): Response =>
  new Response(JSON.stringify({ status: "ok", runs: runNames() }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
