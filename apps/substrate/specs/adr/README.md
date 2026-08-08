# Architecture Decision Records

## Reading the two fields

**`Status` is about the decision. `Implementation` is about the code.** They shared one word until
now, and one word could not carry both — which is how this directory got read two opposite ways in
a single day: once as "nine Proposed ADRs, all with shipped code — the field is stale metadata,
ignore it", and once as "0012 is Proposed, so that surface shipped ahead of ratification and the
conservative catalog entry is right". Both readings survive contact with the same files. That is
the defect.

`Implementation` was filled by reading the code, one ADR at a time:

| Value | Means |
| --- | --- |
| `shipped` | Implementing code and tests exist and are wired into a path that runs |
| `partial` | Part of the decision is implemented; the row says what is missing |
| `not-implemented` | No implementing code found |

`Status` values are **unchanged**, deliberately. Ratification is an act someone performs, not a
property inferred from code existing — inferring it is the precise error this change exists to
prevent, so nothing here promotes an ADR.

### The convention exists, and this set never adopted it

It is written down once, in the **root** ADR set — [`specs/adr/README.md`](../../../../specs/adr/README.md):

> A record is only binding once its Status reads `accepted`. Treat `proposed` rows as under
> discussion — in particular, do not implement against a proposed record's interfaces or assume
> they exist.

Nothing says it governs this directory, and this directory does not look like it does: the root set
writes lowercase `accepted` / `proposed` on a single `**Status:** proposed 2026-08-06` line, while
these use capitalised `Accepted` / `Proposed` split across `- **Status:**` and `- **Date:**`. This
README defined nothing until now, and [`../README.md`](../README.md) describes this directory as
"one record per **settled** decision" — which reads against nine of the twelve saying `Proposed`.

Two facts decide how much weight the field can bear:

- **No status here has ever changed.** Measured across all fifteen ADRs in both sets
  (`git log -G '\*\*Status:\*\*'`), the only commit that has ever touched a `Status:` line is the
  commit that created the file. Zero transitions. The root convention is consistent with that — it
  says records are "never edited after acceptance" — but it names no act that *reaches* acceptance,
  so nothing ever has.
- **Status does not track implementation.** Seven `Proposed` records are `shipped` — including
  ADR-0004 and ADR-0005, the ticket gate and the egress floor, both wired and heavily tested. If the
  root convention governed here, "do not implement against a proposed record's interfaces" would
  have been broken seven times. It ran the other way too, until ADR-0002's promised lint rule was
  written: `Accepted` and `partial` at the same time. Both records still `partial` are `Proposed`,
  so today the divergence runs one way — a fact about the current code, not something the field
  guarantees.

**This is left open, not settled here.** If `Proposed` is meant to be a real gate, someone has to
define the act that clears it — who ratifies, on what signal, recorded where — and either extend the
root convention to this set or write one for it. If it is not meant to be a gate, the honest fix is
to drop the field rather than keep a word that reads like one. Either is the substrate owners' call;
this change only stops the two facts sharing one word in the meantime.

| ADR | Decision | Status | Implementation |
| --- | --- | --- | --- |
| [0001](0001-substrate-as-its-own-component.md) | The execution substrate is its own component | Accepted | shipped |
| [0002](0002-substrate-inside-the-flare-dispatch-monorepo.md) | Inside the flare-dispatch monorepo, no name of its own | Accepted | shipped — `.oxlintrc.json` forbids reaching substrate internals by path or by workspace package, repo-wide with the substrate exempted; its shape is held by `src/facade-boundary.test.ts` |
| [0003](0003-facade-only-consumption.md) | Consumers reach the substrate only through a service-binding facade | Proposed | shipped |
| [0004](0004-admission-enforced-by-ticket.md) | Admission enforced by ticket; the substrate alone owns the ceiling | Proposed | shipped |
| [0005](0005-deny-all-egress-with-grant-profiles.md) | Deny-all egress with named grant profiles | Proposed | shipped |
| [0006](0006-credential-boundary.md) | No long-lived credential reachable from inside a container | Proposed | partial — machinery shipped, adoption pending per [`../credential-boundary.md`](../credential-boundary.md) |
| [0007](0007-approval-attestation-at-exec.md) | Irreversible commands require an approval attestation at exec | Proposed | shipped |
| [0008](0008-verdict-neutral-execution-facts.md) | Verdict-neutral — execution facts only | Accepted | shipped — a negative decision, enforced by the contract carrying no verdict field |
| [0009](0009-two-tier-budgets.md) | Two-tier budgets: per-execution metering + per-consumer ceiling | Proposed | partial — both tiers are pure logic with **no caller**; nothing outside `budget/` imports it and no metered proxy route exists |
| [0010](0010-named-image-classes-policy-selected.md) | Named image classes, selected by policy | Proposed | shipped |
| [0011](0011-sdk-pin-as-security-surface.md) | The sandbox SDK pin is a security surface | Proposed | shipped — literal pins on both halves, the transitive one walked through the `apps/substrate` lockfile edge; scoped to the substrate, so the dispatcher's own `@cloudflare/sandbox` 0.10.1 is unasserted |
| [0012](0012-processes-that-outlive-the-exec-fence.md) | A process that outlives the exec fence holds no grant | Proposed | shipped — selective teardown and the `killAllProcesses` fallback both real |
