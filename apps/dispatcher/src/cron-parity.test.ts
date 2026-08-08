// Cron parity — every armed `triggers.crons` expression MUST bind a registered
// run, and every run whose schedule is not deliberately unarmed MUST be armed.
//
// The two halves of arming a scheduled run live in different files: the cron in
// `wrangler.jsonc`, the run in `RUN_REGISTRY`. Exporting a run from
// `@fractalboxdev/flare-dispatch-runs` is NOT registration — a run exported but
// not in the registry deploys a cron that fires into
// `console.warn("matched no registered runs")`, which nobody reads, and the
// symptom is a scheduled run that silently never ran.
//
// The reverse drift is quieter still: retiring a run leaves an expression that
// wakes the Worker daily to do nothing.
//
// Runs under plain Node (the dispatcher's vitest project), so reading the
// committed wrangler config is fine here.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runNames, schedulesByCron, scheduledRuns } from "./registry";

/**
 * `wrangler.jsonc` is JSONC — comments and trailing commas. Strip both rather
 * than adding a parser dependency for one test.
 */
const readArmedCrons = (): readonly string[] => {
  const raw = readFileSync(new URL("../../../wrangler.jsonc", import.meta.url), "utf8");
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
  const config = JSON.parse(stripped) as { triggers?: { crons?: string[] } };
  return config.triggers?.crons ?? [];
};

/**
 * Runs that declare a schedule and are deliberately NOT armed, each because
 * arming it is a product decision — mirrored from the `wrangler.jsonc` comment
 * that explains why. Adding a name here is the deliberate act; forgetting to is
 * what this test catches.
 */
const DELIBERATELY_UNARMED = new Set(["release-notes", "product-demo"]);

describe("cron parity", () => {
  it("every armed cron binds at least one registered run", () => {
    const armed = readArmedCrons();
    // Guard against the parity test's own failure mode: a JSONC strip that
    // silently yields no crons passes every assertion below while checking
    // nothing.
    expect(armed.length).toBeGreaterThan(0);
    expect(armed.filter((cron) => schedulesByCron(cron).length === 0)).toEqual([]);
  });

  it("every scheduled run is armed unless deliberately left off", () => {
    const armed = new Set(readArmedCrons());
    const missing = scheduledRuns()
      .filter((r) => !DELIBERATELY_UNARMED.has(r.name))
      .filter((r) => !r.crons.some((cron) => armed.has(cron)));
    expect(missing.map((r) => r.name)).toEqual([]);
  });

  it("names every deliberately-unarmed run, so the list can't outlive its runs", () => {
    const known = new Set(runNames());
    expect([...DELIBERATELY_UNARMED].filter((n) => !known.has(n))).toEqual([]);
  });
});
