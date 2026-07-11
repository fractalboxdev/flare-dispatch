// Primitive: sharded — count-and-index parallel fan-out
//
// Runs `count` parallel copies of a body, each handed its own
// { index, total } (1-based), bounded by `concurrency`. Collapses the
// hand-rolled `Effect.forEach(Array.from({ length: n }, (_, i) => i + 1), …)`
// that every matrix-style recipe otherwise repeats, and gives the index
// plumbing one canonical shape.
//
// Fan-out across a *list* of heterogeneous items (scanners, review agents)
// stays plain `Effect.forEach` — `sharded` is specifically the count case.
//
// Pure Effect composition — no capability needed. Layer: 03-dsl § Primitives.

import { Effect } from "effect";

export type Shard = { index: number; total: number };

export const sharded = <A, E, R>(opts: {
  count: number;
  concurrency?: number; // default: count (all shards at once)
  body: (shard: Shard) => Effect.Effect<A, E, R>;
}): Effect.Effect<readonly A[], E, R> =>
  Effect.forEach(
    Array.from(
      { length: opts.count },
      (_, i): Shard => ({ index: i + 1, total: opts.count }),
    ),
    opts.body,
    { concurrency: opts.concurrency ?? opts.count },
  );
