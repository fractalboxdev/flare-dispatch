// Mermaid sources for the landing page's diagrams, rendered by Diagram.astro. Each one
// summarizes, at landing-page size, a mechanism a specification defines: the system shape
// (specs/architecture.md), placement constraints (specs/qos-admission.md), the execution
// lifecycle (specs/github-output.md) and the fenced lease (specs/placement-leases.md).

export const heroShape = `flowchart TB
  accTitle: Cloudflare schedules; owned hardware runs first; the cloud takes the spill
  trig["Webhook · Actions · cron · local"]:::accent --> intake
  subgraph cp["Control plane · your Cloudflare account"]
    intake["Intake: verify, dedup, class"] --> admit{"Spend guard: hold fits?"}
    admit -->|yes| place["Placement: fenced lease"]
  end
  subgraph ex["Executors, in placement order"]
    dev["1 · Owned hardware: VM per job"]
    pool["2 · Cloudflare Containers"]
    ec2["3 · AWS launcher"]
  end
  place -->|claim| dev
  place -->|deadline| pool
  place -->|P1, breaker open| ec2
  dev --> gh["Check run: current epoch only"]:::ok
  pool --> gh
  ec2 --> gh
`;

export const placement = `flowchart TB
  accTitle: Placement constraints narrow the eligible executors before the deadline picks one
  ex["Admitted execution"]:::accent --> cc{"confidential-compute repo?"}
  cc -->|yes| pin{"Fork PR, tag or P0?"}
  pin -->|yes| refuse["failure: placement: no eligible executor"]:::danger
  pin -->|no| owned["Owned devices only"]
  owned -->|no device by deadline_at| fail["failure: capacity"]:::danger
  owned -->|claimed| odev["Owned device"]:::ok
  cc -->|no| pin2{"Fork PR, tag or P0?"}
  pin2 -->|yes| cfc["Cloudflare Containers"]:::ok
  pin2 -->|no| lf["Local-first"]
  lf -->|claimed before deadline| dev["Owned device"]:::ok
  lf -->|deadline passes| cfc
  cfc -->|P1 only, breaker open| aws["AWS"]:::ok
`;

export const lifecycle = `stateDiagram-v2
  accTitle: A guaranteed execution queues, then fails; no capacity, budget, deadline or halt outcome concludes neutral
  [*] --> Queued: intake assigns a class
  Queued --> Held: hold fits under the class line
  Queued --> Failure: deadline_at passes, named reason
  Queued --> Cancelled: superseded
  Held --> Leased: an executor claims, epoch n
  Leased --> Leased: reclaim, epoch n+1
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
  accTitle: A stale executor's result is never accepted
  participant CP as Control plane
  participant D as Owned device
  participant C as Cloudflare Container
  CP->>D: lease, epoch 1
  D-->>CP: heartbeat every 15 s
  Note over D: device sleeps
  Note over CP: no heartbeat for 90 s: reclaim
  CP->>C: lease, epoch 2, hold re-admitted
  C->>CP: result, epoch 2
  CP->>CP: accept, post the check
  Note over D: device wakes
  D->>CP: result, epoch 1
  CP-->>D: rejected: stale epoch, token revoked
`;
