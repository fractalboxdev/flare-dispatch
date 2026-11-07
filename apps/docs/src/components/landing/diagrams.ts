// Mermaid sources for the landing page's diagrams, rendered by Diagram.astro. Each one shows how the
// system is designed, and its caption says so: the system shape (specs/architecture.md), placement
// (specs/profile.md), the execution lifecycle (specs/github-output.md) and the fenced lease
// (mameko's placement-leases.md). /roadmap/ reports how much of each exists.

export const heroShape = `flowchart TB
  accTitle: The design: one control plane in your account places work on your machines, Cloudflare or other cloud executors
  trig["Webhook · Actions · cron · local"]:::accent --> ctl["Control plane in your Cloudflare account"]
  ctl -->|lease| dev["Your machines"]
  ctl -->|lease| pool["Cloudflare Containers"]
  ctl -->|lease| other["Other cloud executors"]
  dev --> rec["Verdict at the current epoch"]:::ok
  pool --> rec
  other --> rec
  rec --> gh["GitHub check run"]
`;

export const placement = `flowchart TB
  accTitle: The design: placement rules narrow the eligible executors before the deadline picks one
  ex["Admitted execution"]:::accent --> pin{"Fork PR, tag or release?"}
  pin -->|yes| cfc["Cloudflare Containers"]:::ok
  pin -->|no| lf["Owned hardware first"]
  lf -->|claimed before deadline| dev["Owned device"]:::ok
  lf -->|deadline passes| cfc
`;

export const lifecycle = `stateDiagram-v2
  accTitle: The design: a guaranteed execution queues, then fails; no capacity, budget, deadline or halt outcome concludes neutral
  [*] --> Queued: intake assigns a class
  Queued --> Leased: an executor claims
  Queued --> Failure: deadline passes, named reason
  Queued --> Cancelled: superseded
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
  accTitle: The design: a stale executor's result is never accepted
  participant CP as Control plane
  participant D as Owned device
  participant C as Cloud executor
  CP->>D: lease, epoch n
  D-->>CP: heartbeat
  Note over D: device sleeps
  Note over CP: heartbeats stop: reclaim
  CP->>C: lease, epoch n+1
  C->>CP: result, epoch n+1
  CP->>CP: accept
  Note over D: device wakes
  D->>CP: result, epoch n
  CP-->>D: rejected: stale epoch
`;
