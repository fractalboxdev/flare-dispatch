// Test support: the log-append intents in memory, with the semantics of the D1 store (append.ts `d1LogAppendStore`):
// an insert keyed by envelope digest that leaves an existing intent as it is, and updates that touch only a pending
// intent. The sim and replay harnesses run in Node without workerd, so they keep the intents here; the unit suite
// checks the D1 store itself. `writes` counts every insert and update that changed an intent.
import { Effect } from "effect";
import { LogAppendStatus, type LogAppendIntent, type LogAppendStore } from "./append.ts";

export type MemoryLogAppendStore = LogAppendStore["Service"] & {
  readonly intents: Map<string, LogAppendIntent>;
  readonly writes: { readonly key: string }[];
};

const pendingOf = (intent: LogAppendIntent) =>
  LogAppendStatus.$match(intent.status, { Pending: (p) => p, Logged: () => undefined });

export const memoryLogAppendStore = (
  intents: Map<string, LogAppendIntent> = new Map(),
): MemoryLogAppendStore => {
  const writes: { key: string }[] = [];
  const update = (digest: string, status: LogAppendStatus) =>
    Effect.sync(() => {
      const intent = intents.get(digest);
      if (intent === undefined || pendingOf(intent) === undefined) return;
      intents.set(digest, { ...intent, status });
      const state = LogAppendStatus.$match(status, {
        Pending: () => "pending",
        Logged: () => "logged",
      });
      writes.push({ key: `provenance_log_appends ${digest} ${state}` });
    });
  const pendingDue = () =>
    [...intents.values()].flatMap((intent) => {
      const pending = pendingOf(intent);
      return pending === undefined
        ? []
        : [{ digest: intent.envelopeDigest, at: pending.nextAttemptAt }];
    });
  return {
    intents,
    writes,
    insert: (intent) =>
      Effect.sync(() => {
        if (intents.has(intent.envelopeDigest)) return false;
        intents.set(intent.envelopeDigest, intent);
        writes.push({ key: `provenance_log_appends ${intent.envelopeDigest} insert` });
        return true;
      }),
    get: (digest) => Effect.sync(() => intents.get(digest) ?? null),
    due: (now) =>
      Effect.sync(() =>
        pendingDue()
          .filter((d) => d.at <= now)
          .sort((a, b) => a.at - b.at || (a.digest < b.digest ? -1 : 1))
          .map((d) => d.digest),
      ),
    nextDue: () =>
      Effect.sync(() => {
        const due = pendingDue();
        return due.length === 0 ? null : Math.min(...due.map((d) => d.at));
      }),
    forExecution: (executionId) =>
      Effect.sync(() => [...intents.values()].filter((i) => i.executionId === executionId)),
    logged: (digest, attempts, entry) =>
      update(digest, LogAppendStatus.Logged({ attempts, entry })),
    failed: (digest, attempts, nextAttemptAt, error) =>
      update(digest, LogAppendStatus.Pending({ attempts, nextAttemptAt, lastError: error })),
  };
};
