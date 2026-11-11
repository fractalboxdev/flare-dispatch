// The `check.conclude` intents of a fan-out parent's children (specs/github-output.md FD-GH-020). Once a parent is
// terminal, each child that owns a check run and has no conclusion applied gets one `cp:check:conclude` row carrying
// `{ verdict }`: the child's own recorded outcome, or `failure` "parent closed before this part settled" for a child
// that settled none. mameko's coordinator exposes no `insertIntent` (MAMEKO-OUT-052) at the pinned commit, and that
// guard refuses a terminal execution, which every child of an ended parent is after the parent-ended cascade
// (MAMEKO-RUN-084); the rows go in through host-cloudflare's `insertOutboxRows`, which leaves a key that already has a
// row as it is.
import { insertOutboxRows, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { Effect, Schema } from "effect";
import { CHILD_CONCLUDE_KEY, childConclusions, type ChildCheck } from "./bindings.ts";
import { PARENT_ENDED, recordedVerdict } from "./conclusion.ts";

export { CHILD_CONCLUDE_KEY };

/**
 * The indexes the pass reads through: ended parents by `finished_at`, and every child of a parent, terminal or not, by
 * `parent_id` (mameko's `executions_live_children` holds only live children). A rebuild of `executions` drops them, so
 * they are created on every start, after mameko's migrations.
 */
export const CHILD_CONCLUSIONS_INDEXES: readonly string[] = [
  `create index if not exists executions_finished on executions (finished_at)`,
  `create index if not exists executions_parent on executions (parent_id)`,
];

/** Creates `CHILD_CONCLUSIONS_INDEXES` on a store mameko's migrations have run on. */
export const migrateChildConclusions = (db: D1Like) =>
  attempt("indexes", () => db.batch(CHILD_CONCLUSIONS_INDEXES.map((s) => db.prepare(s)))).pipe(Effect.asVoid);

/** The control plane's store could not be read or written; the next pass tries again. */
export class ChildConclusionsUnavailable extends Schema.TaggedError<ChildConclusionsUnavailable>()(
  "ChildConclusionsUnavailable",
  { message: Schema.String },
) {}

/** The profile's `check.conclude` entry and the class catalogue's ranks, which every row of the kind carries. */
export interface ConcludeKind {
  readonly tier: "outcome" | "effect" | "progress";
  readonly priority: number;
  readonly effectClass: "replay-safe" | "adoptable" | "reconcile-only";
  readonly drawsReserve: boolean;
  readonly classRanks: Readonly<Record<string, number>>;
}

interface ChildRow {
  readonly id: string;
  readonly scope_id: string;
  readonly class: string;
  readonly status: string;
  readonly reason: string | null;
  readonly concluded: number;
}

/** How far back a pass looks for ended parents: a parent is read on every pass for an hour after its end. */
export const CHILD_CONCLUSIONS_LOOKBACK_MS = 3_600_000;

/**
 * Every child of a parent that ended in the lookback and owns a check run (admission inserted its `cp:check:open`)
 * and has no `cp:check:conclude` row yet, with whether a `check.conclude` row of it is already applied. The parent
 * counts as ended under the cascade's own test: a status other than `pending` and `running` (MAMEKO-RUN-084). The
 * read starts from the parents in the lookback through `executions_finished` and reaches their children through
 * `executions_parent`, so it reads no execution outside the lookback; `cross join` holds that order, since SQLite's
 * planner would otherwise walk every child in `id` order to serve the `order by`.
 */
export const CHILDREN = `select c.id, c.scope_id, c.class, c.status, c.reason,
    exists (select 1 from outbox o where o.execution_id = c.id and o.kind = 'check.conclude' and o.state = 'applied')
      as concluded
  from executions p cross join executions c on c.parent_id = p.id
  where p.finished_at >= ? and p.status not in ('pending', 'running')
    and exists (select 1 from outbox o where o.execution_id = c.id and o.intent_key = 'cp:check:open')
    and not exists (select 1 from outbox o where o.execution_id = c.id and o.intent_key = '${CHILD_CONCLUDE_KEY}')
  order by c.id`;

/** A child's own verdict: none while it is not terminal, and none when the parent-ended cascade cancelled it. */
const ownVerdict = (row: ChildRow) =>
  row.status === "cancelled" && row.reason === PARENT_ENDED
    ? null
    : recordedVerdict(row.status, row.reason);

const sha256Hex = (text: string) =>
  Effect.promise(async () => {
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    );
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  });

const attempt = <A>(what: string, f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (e) => new ChildConclusionsUnavailable({ message: `${what}: ${e}` }),
  });

/**
 * Inserts one `cp:check:conclude` row per child check run of an ended fan-out parent that has not concluded
 * (FD-GH-020), and answers the children it inserted for. A child whose row is already present gets none, so a repeat
 * inserts nothing.
 */
export const insertChildConclusions = (db: D1Like, kind: ConcludeKind, now: number) =>
  Effect.gen(function* () {
    const { results } = yield* attempt("children", () =>
      db
        .prepare(CHILDREN)
        .bind(now - CHILD_CONCLUSIONS_LOOKBACK_MS)
        .all(),
    );
    const rows = results as readonly ChildRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const children: readonly ChildCheck[] = rows.map((r) => ({
      executionId: r.id,
      verdict: ownVerdict(r),
      concluded: r.concluded === 1,
    }));
    const intents = childConclusions(children);
    const stored = yield* Effect.forEach(intents, (intent) =>
      Effect.gen(function* () {
        const child = byId.get(intent.executionId)!;
        const payload = { verdict: intent.verdict };
        return {
          id: `${intent.executionId}:${intent.intentKey}`,
          limitKey: child.scope_id,
          tier: kind.tier,
          priority: kind.priority,
          classRank: kind.classRanks[child.class] ?? 0,
          drawsReserve: kind.drawsReserve,
          intent: {
            executionId: intent.executionId,
            scopeId: child.scope_id,
            intentKey: intent.intentKey,
            kind: "check.conclude",
            payload,
            payloadDigest: yield* sha256Hex(JSON.stringify(payload)),
            effectClass: kind.effectClass,
            attempts: 0,
          },
          row: newRow({ effectClass: kind.effectClass, insertedAt: now }),
        };
      }),
    );
    if (stored.length > 0) yield* attempt("outbox insert", () => insertOutboxRows(db, stored));
    return intents.map((i) => i.executionId);
  });
