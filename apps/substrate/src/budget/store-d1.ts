// D1-backed two-tier model budgets (specs/adr/0009-two-tier-budgets.md).
//
// Same shape and the same reason as the admission semaphore next door: D1 is
// single-threaded per database, so ONE conditional UPDATE is a real atomic
// claim. A budget enforced as `read → call → decrement` across isolates is not
// enforced at all — every concurrent call reads the same remaining balance and
// they all pass. The cap here holds under concurrency because the check and the
// decrement are the same statement, and `meta.changes` is the verdict.
//
// The ADR names a Durable Object for the per-consumer ceiling. This uses the
// substrate's existing D1 for both tiers, which is the same consistency
// guarantee from the store that already owns the account's other hard cap: the
// admission semaphore. It also avoids a second DO class, and DO classes are the
// one thing in this worker whose deploy churns running containers. If the
// ceiling later needs alarms or per-consumer isolation, moving it is a store
// swap behind this interface, not a change to the rule.
//
// Reserve-then-settle rather than charge-on-completion: usage is only known
// after a call returns, and a cap applied only on settle admits every
// concurrent call before any of them reports. The reservation is the estimate;
// settle reconciles it against what the call actually cost.
import { budgetStop, decideSpend, type MicroUsd, type TierState } from "./meter";
import type { BudgetStop } from "@fractalboxdev/flare-dispatch-substrate-contract";

export type BudgetScope = "execution" | "consumer";

export type BudgetRow = TierState & { epoch: number };

export type ReserveOutcome =
  | { ok: true; heldMicroUsd: MicroUsd; execution: BudgetRow; consumer: BudgetRow }
  | { ok: false; refusal: BudgetStop };

export type ModelBudgetStore = {
  /**
   * Arm a tier at its cap. Never refills: a retried arm on a partially-spent
   * budget is a durable step replaying, and a replay that restores the balance
   * turns a cap into a subscription.
   */
  arm(scope: BudgetScope, subject: string, capMicroUsd: MicroUsd): Promise<BudgetRow>;
  /** Current state, arming at `capMicroUsd` if the row does not exist yet. */
  read(scope: BudgetScope, subject: string, capMicroUsd: MicroUsd): Promise<BudgetRow>;
  /** Hold an estimate against both tiers, or refuse with the tier that stopped it. */
  reserve(
    subjects: { executionId: string; consumer: string },
    caps: { executionMicroUsd: MicroUsd; consumerMicroUsd: MicroUsd },
    estimateMicroUsd: MicroUsd,
  ): Promise<ReserveOutcome>;
  /** Reconcile a held reservation against actual usage, on both tiers. */
  settle(
    subjects: { executionId: string; consumer: string },
    heldMicroUsd: MicroUsd,
    actualMicroUsd: MicroUsd,
  ): Promise<void>;
  /** Bump the revocation epoch — every token minted for this subject dies. */
  revoke(scope: BudgetScope, subject: string): Promise<number>;
};

const now = (): number => Date.now();

type Row = {
  spent_micro_usd: number;
  cap_micro_usd: number;
  epoch: number;
};

const toState = (row: Row): BudgetRow => ({
  spentMicroUsd: row.spent_micro_usd,
  capMicroUsd: row.cap_micro_usd,
  epoch: row.epoch,
});

export function makeModelBudgetStoreD1(db: D1Database): ModelBudgetStore {
  const armRow = async (
    scope: BudgetScope,
    subject: string,
    capMicroUsd: MicroUsd,
  ): Promise<BudgetRow> => {
    const at = now();
    // `DO NOTHING` is the no-refill rule. An operator raising a cap does it
    // with a deliberate UPDATE, not by re-arming.
    await db
      .prepare(
        `INSERT INTO sub_model_budgets
           (scope, subject, spent_micro_usd, cap_micro_usd, epoch, armed_at, updated_at)
         VALUES (?1, ?2, 0, ?3, 0, ?4, ?4)
         ON CONFLICT (scope, subject) DO NOTHING`,
      )
      .bind(scope, subject, Math.max(0, capMicroUsd), at)
      .run();

    const row = await db
      .prepare(
        `SELECT spent_micro_usd, cap_micro_usd, epoch FROM sub_model_budgets
          WHERE scope = ?1 AND subject = ?2`,
      )
      .bind(scope, subject)
      .first<Row>();

    // A row that vanished between the insert and the read is infrastructure
    // failing, not a budget with room. Report the cap as fully spent so the
    // caller refuses rather than proceeds.
    return row === null
      ? { spentMicroUsd: capMicroUsd, capMicroUsd, epoch: 0 }
      : toState(row);
  };

  /**
   * Atomically add `amount` to one tier if it still fits. The predicate lives
   * in the WHERE clause, so two racing charges cannot both see the same
   * headroom — the second one changes no rows and is refused.
   */
  const charge = async (
    scope: BudgetScope,
    subject: string,
    amount: MicroUsd,
  ): Promise<boolean> => {
    const result = await db
      .prepare(
        `UPDATE sub_model_budgets
            SET spent_micro_usd = spent_micro_usd + ?3, updated_at = ?4
          WHERE scope = ?1 AND subject = ?2
            AND spent_micro_usd + ?3 <= cap_micro_usd`,
      )
      .bind(scope, subject, amount, now())
      .run();
    return (result.meta.changes ?? 0) > 0;
  };

  /** Give back an over-reservation. Clamped at zero — spend never goes negative. */
  const credit = async (
    scope: BudgetScope,
    subject: string,
    amount: MicroUsd,
  ): Promise<void> => {
    if (amount <= 0) return;
    await db
      .prepare(
        `UPDATE sub_model_budgets
            SET spent_micro_usd = MAX(0, spent_micro_usd - ?3), updated_at = ?4
          WHERE scope = ?1 AND subject = ?2`,
      )
      .bind(scope, subject, amount, now())
      .run();
  };

  return {
    arm: armRow,
    read: armRow,

    async reserve(subjects, caps, estimateMicroUsd) {
      const estimate = Math.max(0, estimateMicroUsd);
      const execution = await armRow("execution", subjects.executionId, caps.executionMicroUsd);
      const consumer = await armRow("consumer", subjects.consumer, caps.consumerMicroUsd);

      // Decide first so the refusal names the tier that stopped it with the
      // state a consumer can render, then apply — the conditional UPDATEs below
      // are what make the decision hold under concurrency, and the pure
      // `decideSpend` is what makes it testable.
      const decision = decideSpend({ execution, consumer }, estimate);
      if (!decision.ok) return { ok: false, refusal: decision.refusal };

      // A charge that loses the race changes no rows: another call took the
      // headroom between the decision and the UPDATE. The refusal is the same
      // one `decideSpend` would have produced.
      if (!(await charge("execution", subjects.executionId, estimate)))
        return { ok: false, refusal: budgetStop("execution", execution) };

      if (!(await charge("consumer", subjects.consumer, estimate))) {
        // The tiers must not disagree about what was spent: an execution charge
        // that the ceiling then refuses is given back before the refusal
        // returns, or the execution's budget bleeds on every ceiling stop.
        await credit("execution", subjects.executionId, estimate);
        return { ok: false, refusal: budgetStop("consumer", consumer) };
      }

      return { ok: true, heldMicroUsd: estimate, execution, consumer };
    },

    async settle(subjects, heldMicroUsd, actualMicroUsd) {
      const delta = actualMicroUsd - heldMicroUsd;
      if (delta === 0) return;
      if (delta < 0) {
        await credit("execution", subjects.executionId, -delta);
        await credit("consumer", subjects.consumer, -delta);
        return;
      }
      // An underestimate is charged unconditionally: the call already happened
      // and the money is already spent. The overrun lands as spend above the
      // cap, which is exactly the state that refuses every later reservation.
      await db
        .prepare(
          `UPDATE sub_model_budgets
              SET spent_micro_usd = spent_micro_usd + ?3, updated_at = ?4
            WHERE scope = ?1 AND subject = ?2`,
        )
        .bind("execution", subjects.executionId, delta, now())
        .run();
      await db
        .prepare(
          `UPDATE sub_model_budgets
              SET spent_micro_usd = spent_micro_usd + ?3, updated_at = ?4
            WHERE scope = ?1 AND subject = ?2`,
        )
        .bind("consumer", subjects.consumer, delta, now())
        .run();
    },

    async revoke(scope, subject) {
      await db
        .prepare(
          `UPDATE sub_model_budgets SET epoch = epoch + 1, updated_at = ?3
            WHERE scope = ?1 AND subject = ?2`,
        )
        .bind(scope, subject, now())
        .run();
      const row = await db
        .prepare(
          `SELECT spent_micro_usd, cap_micro_usd, epoch FROM sub_model_budgets
            WHERE scope = ?1 AND subject = ?2`,
        )
        .bind(scope, subject)
        .first<Row>();
      return row?.epoch ?? 0;
    },
  };
}
