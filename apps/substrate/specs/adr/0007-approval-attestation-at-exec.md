# ADR-0007: Irreversible commands require an approval attestation at the exec surface

- **Status:** Proposed
- **Date:** 2026-08-06

## Context

fractalbot's `ALWAYS_APPROVE` regex floor (`git push`, `wrangler deploy|secret|d1`,
`terraform apply`, publishes) is enforced in exactly one path — its TaskWorkflow — while its
`sandbox_exec` tool loop reaches exec with no approval check at all, and flare-dispatch has no
command-level approval anywhere. A floor enforced in one consumer path and bypassed in another is
not a floor. Applied naively to CI it also breaks the catalog: `worker-deploy` and `self-heal-pr`
run floor-matching commands non-interactively by design.

## Decision

The irreversible-command floor moves into the substrate's exec surface: `execUnderGrant` refuses a matching
command unless the call carries an **approval attestation**. Who may assert differs by consumer:

- fractalbot asserts after a human approval lands (its Block Kit flow), passing the attestation
  through the facade — both its exec paths route through the same the substrate check.
- flare-dispatch runs assert in their code-reviewed definitions (`worker-deploy` pre-asserts
  `wrangler deploy`) — never from dispatch inputs.

The regex list lives in the substrate and is versioned with it.

## Consequences

- The tool-loop bypass closes structurally at fractalbot's bind (its stage 3).
- Honesty clause, stated to consumers: a regex floor is an ordinary-path control, trivially evaded
  by hostile code. Containment remains deny-all egress plus credential-free containers (ADR-0005,
  ADR-0006); the attestation exists to stop a well-behaved loop doing an irreversible thing without
  a human or a reviewed definition behind it.
