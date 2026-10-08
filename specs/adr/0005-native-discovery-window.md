# Native discovery belongs to its durable admission

**Status:** accepted

## Context

Whole workflow history exhausts the finite API pagination budget even when a new dispatch's nonce is unique. A lost POST response requires reconciliation without granting another POST.

## Decision

The D1 dispatch reservation records database Unix time before the controller claims its single POST. An immutable column retains that admission across lost responses and process replay. Neither a workload receipt nor a later poll chooses its value.

Nonce discovery uses GitHub's documented `created` filter with a fixed lower bound derived by Core's `nativeDiscoveryWindow`. `NATIVE_DISCOVERY_CLOCK_ALLOWANCE_SECONDS` is a chosen allowance for controller/API clock difference, not a measured guarantee. The lower bound remains fixed; delayed dispatch and reconciliation receive no moving upper limit.

## Rationale

| Option | Criterion | Cost |
| --- | --- | --- |
| Persist admission and filter from its fixed allowance | Durable ownership | Clock differences beyond the allowance can leave an intent unresolved. |
| Refresh the bound at each poll | Lost-response recovery | A delayed authentic run can disappear from discovery. |
| Scan all workflow history | Bounded work | Old unrelated runs permanently exhaust pagination. |

## Consequences

Every filtered page retains the same authenticated scope. Missing pages, ambiguous matching runs, malformed or out-of-window creation times, and recent history beyond the existing page budget refuse without granting another POST. Exact bound collection retains its run-attempt GET.

Migration `0010_native_admission_time.sql` leaves earlier intents without an inferred timestamp. Those intents refuse admission and require explicit operator reconciliation; a timestamp cannot be refreshed or backfilled through the dispatch adapter.

## Revisit triggers

Measured controller/API skew exceeds the chosen allowance, or admitted recent traffic routinely exceeds the existing complete-page budget.
