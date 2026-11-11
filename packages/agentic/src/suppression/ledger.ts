// The suppression ledger (specs/runs/agentic.md § Suppression ledger): one D1 row per suppression key, either declined
// for good or dated by the matching pull request's `closed_at`, read before a recipe opens a pull request or an issue.
// A key that is declined, or whose pull request closed less than the cooldown ago, opens nothing (FD-AGT-043); a read
// that fails concludes `suppression: read failed` and opens nothing (FD-AGT-044).
import type { RunResult } from "@fractalboxdev/mameko-run";
import { Clock, Effect, Layer } from "effect";
import type { D1Binding } from "../local/store.ts";
import {
  SuppressionLedger,
  SuppressionReadFailed,
  type SuppressionEntry,
} from "../recipes/services.ts";

/** The cooldown after the matching pull request closed unmerged, by default. */
export const SUPPRESSION_COOLDOWN_DAYS_DEFAULT = 30;
const DAY_MS = 86_400_000;

/** The verdict of a run whose suppression ledger read failed (FD-AGT-044). */
export const SUPPRESSION_READ_FAILED = {
  _tag: "failure",
  reason: "suppression: read failed",
} as const satisfies RunResult;

/**
 * A proposal's suppression key: the repository and the head branch of the pull request it opens or refreshes. The
 * ledger matches the key as an exact string, so `o/r:flare-dispatch/improve-size` never matches
 * `o/r:flare-dispatch/improve-size-2`.
 */
export const suppressionKey = (
  repo: { readonly owner: string; readonly name: string },
  branch: string,
): string => `${repo.owner}/${repo.name}:${branch}`;

export type SuppressionDecision =
  | { readonly suppressed: false }
  | { readonly suppressed: true; readonly why: "declined" }
  | { readonly suppressed: true; readonly why: "cooldown"; readonly until: number };

/**
 * Whether the ledger's row for a key suppresses the proposal at `now`: a declined key always does; a key whose matching
 * pull request closed at `closedAt` does until `closedAt + cooldownDays` days; no row does not.
 */
export const decideSuppression = (
  entry: SuppressionEntry | null,
  now: number,
  cooldownDays: number = SUPPRESSION_COOLDOWN_DAYS_DEFAULT,
): SuppressionDecision => {
  if (entry === null) return { suppressed: false };
  if (entry.declined) return { suppressed: true, why: "declined" };
  if (entry.closedAt === null) return { suppressed: false };
  const until = entry.closedAt + cooldownDays * DAY_MS;
  return now < until ? { suppressed: true, why: "cooldown", until } : { suppressed: false };
};

/** Reads the key's row and decides on it at the clock's time. A failed read fails with `SuppressionReadFailed`. */
export const checkSuppression = (
  key: string,
  cooldownDays: number = SUPPRESSION_COOLDOWN_DAYS_DEFAULT,
) =>
  Effect.gen(function* () {
    const ledger = yield* SuppressionLedger;
    const entry = yield* ledger.lookup(key);
    const now = yield* Clock.currentTimeMillis;
    return decideSuppression(entry, now, cooldownDays);
  });

/** The ledger's table in the control plane's database, forward-only. */
export const SUPPRESSION_LEDGER_MIGRATIONS: readonly {
  readonly name: string;
  readonly sql: readonly string[];
}[] = [
  {
    name: "fd_suppressions",
    sql: [
      `create table if not exists fd_suppressions (
        key text primary key,
        declined integer not null default 0,
        closed_at integer
      )`,
    ],
  },
];

const entryOf = (key: string, row: { readonly [column: string]: unknown }): SuppressionEntry => {
  const declined = row["declined"];
  const closedAt = row["closed_at"];
  if (row["key"] !== key) throw new Error("the row's key differs from the key read");
  if (declined !== 0 && declined !== 1) throw new Error("declined is neither 0 nor 1");
  if (closedAt !== null && (typeof closedAt !== "number" || !Number.isFinite(closedAt)))
    throw new Error("closed_at is not an epoch-ms number");
  return { key, declined: declined === 1, closedAt };
};

/**
 * `SuppressionLedger` over the control plane's D1 database, after `SUPPRESSION_LEDGER_MIGRATIONS`. The lookup compares
 * the key with `=`, so it matches the exact string, letter case included. A query that throws and a row outside the
 * table's shape each fail the read.
 */
export const suppressionLedgerD1 = (db: D1Binding): Layer.Layer<SuppressionLedger> =>
  Layer.succeed(SuppressionLedger, {
    lookup: (key) =>
      Effect.tryPromise({
        try: async () => {
          const { results } = await db
            .prepare("select key, declined, closed_at from fd_suppressions where key = ?")
            .bind(key)
            .all();
          const row = results[0] as { readonly [column: string]: unknown } | undefined;
          return row === undefined ? null : entryOf(key, row);
        },
        catch: (cause) => new SuppressionReadFailed({ key, detail: String(cause).slice(0, 200) }),
      }),
  });
