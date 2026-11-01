// Mermaid sources for the landing page's diagrams, rendered by Diagram.astro. The hero separates
// what runs in development (solid lines, `packages/dogfood`) from what is specified (dashed lines,
// specs/architecture.md). The other three summarize specified mechanisms, and their captions say
// so: placement constraints (specs/profile.md), the execution lifecycle (specs/github-output.md)
// and the fenced lease (mameko's placement-leases.md).

export const heroShape = `flowchart TB
  accTitle: A control plane leases work to a machine you own; the cloud executors and GitHub output are specified
  sub["pnpm dogfood"]:::accent --> ctl["Control plane: mameko coordinator"]
  trig["Webhook · Actions · cron"] -.-> ctl
  ctl -->|lease| dev["Owned machine: device executor"]
  ctl -.->|claim deadline| pool["Cloudflare Containers"]
  ctl -.->|required check| ec2["AWS launcher"]
  dev --> rec["Verdict in the coordinator's record"]:::ok
  pool -.-> rec
  ec2 -.-> rec
  rec -.-> gh["GitHub check run"]
`;

export const placement = `flowchart TB
  accTitle: Specified placement, where constraints narrow the eligible executors before the deadline picks one
  ex["Admitted execution"]:::accent --> cc{"confidential-compute repo?"}
  cc -->|yes| pin{"Fork PR, tag or release?"}
  pin -->|yes| refuse["failure: placement: no eligible executor"]:::danger
  pin -->|no| owned["Owned devices only"]
  owned -->|no device by deadline_at| fail["failure: capacity"]:::danger
  owned -->|claimed| odev["Owned device"]:::ok
  cc -->|no| pin2{"Fork PR, tag or release?"}
  pin2 -->|yes| cfc["Cloudflare Containers"]:::ok
  pin2 -->|no| lf["Owned hardware first"]
  lf -->|claimed before deadline| dev["Owned device"]:::ok
  lf -->|deadline passes| cfc
`;

export const lifecycle = `stateDiagram-v2
  accTitle: As specified, a guaranteed execution queues, then fails; no capacity, budget, deadline or halt outcome concludes neutral
  [*] --> Queued: intake assigns a class
  Queued --> Held: hold fits under the class line
  Queued --> Failure: deadline_at passes, named reason
  Queued --> Cancelled: superseded
  Held --> Leased: an executor claims
  Leased --> Leased: reclaim, next epoch
  Leased --> Success: current-epoch verdict
  Leased --> Failure: current-epoch verdict
  Leased --> Cancelled: superseded
  Success --> [*]
  Failure --> [*]
  Cancelled --> [*]
  class Failure danger
  class Success ok
`;

export const fencedLease = `sequenceDiagram
  accTitle: As specified, a stale executor's result is never accepted
  participant CP as Control plane
  participant D as Owned device
  participant C as Cloudflare Container
  CP->>D: lease, epoch n
  D-->>CP: heartbeat every 15 s
  Note over D: device sleeps
  Note over CP: no heartbeat for 90 s: reclaim
  CP->>C: lease, epoch n+1
  C->>CP: result, epoch n+1
  CP->>CP: accept, post the check
  Note over D: device wakes
  D->>CP: result, epoch n
  CP-->>D: rejected: stale epoch
`;
