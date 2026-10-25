# ADR-0006: Executor-aware spend meter with holds, nested lines and burn lanes

Status: Accepted · 2026-10-24

## Context

- Cloudflare has no account-level spending cap, and AWS budgets alert on billing data that lags spend by hours. The control plane's admission is the only point where a cap can hold before money is spent.
- Execution runs on owned devices, whose container time costs nothing beyond power, and on cloud executors billed per second. Hosted model tokens bill per token wherever the step runs.
- A meter that costs an execution only after it finishes cannot bound a month: an execution with no upper bound on its cost can overrun any budget. The Lean model `FdFormal.Spend` proves budget safety (`Spend.run_safe`) only under the assumption that no execution settles above its hold, and `Spend.unbounded_settle_overruns` shows the assumption is necessary.
- Required checks need a guarantee that money exists for them when the fleet is down; release work needs its own. A single shared budget lets background work exhaust both.
- Container list rates priced at provisioned size read several times the billed amount, so a metered budget admits less real spend than its figure suggests.

## Decision

1. **One meter, priced by executor kind.** Each placement row records its executor kind, and the rate card prices it: `cloudflare` at provisioned list rate, `device` at 0 for container time, `aws` and `gha` at their task and runner rates. Hosted model tokens count on every executor. All money is integer micro-USD; lines use metered micro-USD (list rate × an overhead factor, default 1.1).
2. **Hold before admission.** Each admission reserves `⌈rate × (deadline_at − admission time + settle margin)⌉ + model allowance + network estimate` in one D1 batch led by one conditional statement that checks the line, which every later statement, the placement assignment included, is guarded on. Settlement replaces the hold with the metered cost in one D1 batch (`db.batch()`), each statement guarded on the batch's accept compare-and-set; release returns an unused hold. Every executor stops a job at `deadline_at`, and the gateway refuses a model call past the allowance, which keeps settles at or under their holds; a settle above its hold pages the drift alarm.
3. **Nested lines on one meter.** P3 stops at `0.45 × G`, P2 at `B − R0 − R1`, P1 and ops runs at `B − R0`, P0 at `B`. `R1` is recomputed daily from trailing required-check volume to cover `D` days of fleet-down spill, and only rises within a month.
4. **Nested burn lanes.** Each class admits while the summed list hourly rate of admitted executions of its class and every lower class stays under its lane, across pools.
5. **A required check's hold lives from admission to verdict.** A P1 placed on a device keeps its cloud hold. A reclaim replaces any execution's hold with the metered cost of its earlier epochs plus the new executor's remaining window to `deadline_at`, and checks only the increase against the class line, so a P1 that keeps its cloud hold moves to the cloud with no new check.
6. `spendKernel` is a pure function equal to the `FdFormal.Spend` oracle, linked by differential testing ([ADR-0018](0018-formal-models.md)).

## Options considered

| Option | What it buys | What it costs |
| --- | --- | --- |
| Executor-blind meter at container list rate | One rate card | A device execution spends the cloud budget, so owned hardware never saves money on the meter |
| Cost after completion, no hold | Accurate settled figures | No bound before spend; `Spend.unbounded_settle_overruns` shows one execution can overrun the budget |
| Separate fixed budgets per class | Simple isolation | Unused P1 money cannot serve P2 in a normal month; each partition is its own cliff |
| **Nested lines with holds and reserves** | Hard monthly cap; P1 keeps `R1` when lower classes exhaust the general band; a proof of budget safety | Holds refuse affordable work near a line; `R0 + R1` sits idle in a normal month |
| Calibrate the meter to billed dollars daily | The same budget admits several times more container work | Can undercount between reconciliations, which breaks the hold bound the proof assumes |
| One global burn ceiling | One number | Batch work in another pool can hold a required check behind the ceiling |

## Criteria

1. Committed spend never exceeds `B` except by the settle error the drift alarm reports (decided holds over cost-after-completion and over billed calibration).
2. P1 keeps money to run during a fleet-down period of `D` days after the general band closes.
3. Owned-device execution costs nothing on the meter, while hosted model tokens still count.
4. The admission decision is one D1 batch led by one conditional statement that every later statement is guarded on, so concurrent claims cannot read the same balance.
5. The kernel is small enough to prove and to test against a compiled oracle.

## Consequences

- Conservative holds: an execution reserves its whole window to `deadline_at` plus the settle margin, well above its typical settle, so lines close earlier than settled spend alone would. Tightening `maxDurationSec` from measured p99 is the lever; the estimate-drift metric shows the gap.
- `R0 + R1` stays unspent in a normal month and is never lent to P2 or P3.
- Worst-case hourly burn rises to the P0 lane for P0 and P1 only; P2 and P3 together stay under their lane.
- The meter overstates container cost, so every line admits less billed spend than its figure until `B` is defined in billed dollars, an open decision recorded in [spend.md](../spend.md).
- At a small budget and high required-check volume, `R1` absorbs most of `B` and the `budget-too-small` alarm stays on; P3 cloud spend then stops near 0.
- The claim batch gains spend, lane, browser-session and control-state subqueries; their D1 cost under load needs measurement.
- Unknown completions (an evicted container, an offline device) keep their reservation counted as `unresolved` until reconciliation, which can close a line early during an incident.

## Revisit triggers

- A billed-usage reconciliation keeps settle error under 5% per recipe for 30 days, which would allow `B` in billed dollars.
- The estimate-drift notification fires for more than 3 recipes in one week.
- Cloudflare offers an account-level hard spend limit.
- `R1` exceeds half of `B − F` for 2 consecutive months.
