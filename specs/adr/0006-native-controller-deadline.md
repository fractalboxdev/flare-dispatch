# Native controller deadlines belong to durable admission

**Status:** accepted

## Context

A resumed controller can outlive its initial process. Recomputing a deadline from the current operator configuration widens or refreshes the same nonce's authority. The executor's job timeout bounds neither native queueing nor controller verification.

## Decision

The deploying operator supplies an explicit positive controller duration. Core's `NativeControllerPolicy` owns its validation; no duration is implicit. D1 records that duration and an absolute deadline alongside its database-owned admission timestamp before claiming a POST. The policy and deadline remain immutable for the nonce.

A policy-aware controller refuses a legacy policy-less intent, a different duration, or an expired deadline. A policy-less client cannot adopt a policy-bearing intent. Existing policy-less intents retain their existing behavior; neither adapter infers a missing policy. Verified-result reader expiry remains a separate signed capability.

The reserved-to-dispatching CAS tests the absolute deadline against database time. The dispatch adapter rechecks after a delayed claim acknowledgement before POST. Controller observation and publication admission reuse the same D1 owner; Workflow checkpoints carry the stored deadline rather than choosing one.

## Rationale

| Option | Criterion | Cost |
| --- | --- | --- |
| Immutable database policy and deadline | Same nonce retains one admission window across replay | Earlier policy-less intents need explicit reconciliation rather than automatic adoption. |
| Current configuration plus original timestamp | Resume uses current operator policy | Widened configuration grants new authority to an existing intent. |
| Duration in Workflow checkpoints alone | Minimal checkpoint state | Another instance or restart can replace the policy. |

## Consequences

Migration `0011_native_controller_deadline.sql` leaves legacy policy columns null and rejects inconsistent insertion or policy updates. An expired intent does not grant another POST or a successful controller publication.

Deadline admission checks do not impose a hard process wall-clock bound. Archive/R2 stream reads and disposal include unbounded awaits; expiry refuses the next admitted side effect after they return. Workflow eviction does not imply cancellation of the external GitHub job.

## Revisit triggers

An explicit operator reconciliation protocol admits legacy intents, or bounded stream and cleanup primitives provide a hard wall-clock guarantee.
