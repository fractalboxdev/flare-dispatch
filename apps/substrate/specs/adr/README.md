# Architecture Decision Records

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-substrate-as-its-own-component.md) | The execution substrate is its own component | Accepted |
| [0002](0002-substrate-inside-the-flare-dispatch-monorepo.md) | Inside the flare-dispatch monorepo, no name of its own | Accepted |
| [0003](0003-facade-only-consumption.md) | Consumers reach the substrate only through a service-binding facade | Proposed |
| [0004](0004-admission-enforced-by-ticket.md) | Admission enforced by ticket; the substrate alone owns the ceiling | Proposed |
| [0005](0005-deny-all-egress-with-grant-profiles.md) | Deny-all egress with named grant profiles | Proposed |
| [0006](0006-credential-boundary.md) | No long-lived credential reachable from inside a container | Proposed |
| [0007](0007-approval-attestation-at-exec.md) | Irreversible commands require an approval attestation at exec | Proposed |
| [0008](0008-verdict-neutral-execution-facts.md) | Verdict-neutral — execution facts only | Accepted |
| [0009](0009-two-tier-budgets.md) | Two-tier budgets: per-execution metering + per-consumer ceiling | Proposed |
| [0010](0010-named-image-classes-policy-selected.md) | Named image classes, selected by policy | Proposed |
| [0011](0011-sdk-pin-as-security-surface.md) | The sandbox SDK pin is a security surface | Proposed |
