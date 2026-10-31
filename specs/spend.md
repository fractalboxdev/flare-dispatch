# Spend

FlareDispatch runs mameko's spend meter: holds, settle, nested class lines, burn lanes, allowances and the operator halt are mameko's [spend.md](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/spend.md), and the amounts, lanes and rate card are FlareDispatch's profile values in [profile.md](profile.md) § Spend configuration. This file states what FlareDispatch decides beyond those values: the line a check re-run admits against, the spend endpoint, the attribution on a reserve debit, and the open spend decisions.

## Scope

This file covers the re-run line, the spend view on FlareDispatch's API, the requester attribution FlareDispatch supplies, and the open item on firm holds. It depends on:

- [profile.md](profile.md) for the budget, reserves, lines, burn lanes, look-ahead, warn ratio, thresholds and rate card;
- [intake.md](intake.md) for check re-runs and their families;
- [interfaces.md](interfaces.md) for the route table and the error model;
- [operability.md](operability.md) for the operator controls and alarm delivery.

The decision behind the meter is mameko's [ADR-0008](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/adr/0008-executor-aware-spend.md).

## Model

`B` is metered, not billed, as mameko's [§ Budget, reserves and lines](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/spend.md#budget-reserves-and-lines) defines it, and FlareDispatch's class lines are in [profile.md](profile.md) § Spend configuration.

A check re-run that exceeds its retry family allowance ([MAMEKO-SPD-031](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/spend.md)) admits against the `interactive` line and never draws on `R(release)` or `R_m`.

## Requirements

### Re-runs

- **FD-SPD-032** · phase 0 · `V-UNIT` — If a GitHub check re-run exceeds its retry family allowance ([MAMEKO-SPD-031](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/spend.md)), then the control plane must admit the attempt against the `interactive` line.

### Spend view

- **FD-SPD-057** · phase 0 · `V-UNIT` `V-E2E-LOCAL` — When an authorized viewer requests `GET /v1/spend`, the control plane must answer with the spend view of [MAMEKO-SPD-058](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/spend.md) for the current UTC month.
- **FD-SPD-058** · phase 0 · `V-UNIT` — If the spend view fails with `spend_unreadable` ([MAMEKO-SPD-059](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/spend.md)), then `GET /v1/spend` must answer `503` with error `spend_unreadable` from the error-model table in [interfaces.md](interfaces.md).

### Attribution

- **FD-SPD-060** · phase 0 · `V-UNIT` — When the coordinator debits a reserve, FlareDispatch must supply the team and the member that requested the execution as the requester attribution that [MAMEKO-SPD-061](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/spend.md) records with the repository, run and reason.

## Open items

- TODO(maintainer): the firm holds of `required` ([MAMEKO-SPD-041](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/spend.md) to [MAMEKO-SPD-045](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/spend.md)) count a queued cloud hold against burn headroom at one rate per hold; which rate applies when the eligible kinds differ in rate waits on mameko's rule ([spend.md](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/spend.md) § Open items), which must be settled before FlareDispatch's phase 3 opens.
