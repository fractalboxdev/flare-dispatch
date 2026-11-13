// Test support: the policy versions, the key history and the transparency log in memory, with the semantics of the D1
// stores (policy.ts): an insert that leaves an existing version as it is, a logged version that keeps its first entry,
// and key-history entries that are retired, never removed. The API suite runs in Node without workerd, so it keeps
// them here; the cache suite checks the D1 stores themselves.
import { Effect, Layer } from "effect";
import { LogAppendFailed, type LogEntry } from "./append.ts";
import {
  KeyHistoryStore,
  PolicyStore,
  PolicyTransparencyLog,
  type KeyHistoryEntry,
  type KeyRole,
  type StoredPolicy,
} from "./policy.ts";

export interface MemoryPolicyStores {
  readonly policies: Map<string, StoredPolicy>;
  readonly history: Record<KeyRole, KeyHistoryEntry[]>;
  /** Every envelope the log appended, in order. */
  readonly appended: string[];
  /** While set, the next append fails with this message. */
  failAppend: string | undefined;
  readonly layer: Layer.Layer<KeyHistoryStore | PolicyStore | PolicyTransparencyLog>;
}

export const memoryPolicyStores = (clock: () => number = Date.now): MemoryPolicyStores => {
  const policies = new Map<string, StoredPolicy>();
  const order: string[] = [];
  const history: Record<KeyRole, KeyHistoryEntry[]> = { provenance: [], log: [] };
  const appended: string[] = [];
  const stores: MemoryPolicyStores = {
    policies,
    history,
    appended,
    failAppend: undefined,
    layer: Layer.mergeAll(
      Layer.succeed(PolicyStore)({
        get: (version) => Effect.sync(() => policies.get(version)),
        current: () =>
          Effect.sync(() => {
            const last = order.at(-1);
            return last === undefined ? undefined : policies.get(last);
          }),
        insert: (version, envelope) =>
          Effect.sync(() => {
            if (policies.has(version)) return false;
            policies.set(version, { policyVersion: version, envelope, entry: undefined });
            return true;
          }),
        logged: (version, entry) =>
          Effect.sync(() => {
            const stored = policies.get(version);
            if (stored === undefined || stored.entry !== undefined) return;
            policies.set(version, { ...stored, entry });
            order.push(version);
          }),
      }),
      Layer.succeed(KeyHistoryStore)({
        entries: (role) => Effect.sync(() => [...history[role]]),
        apply: (role, use) =>
          Effect.sync(() => {
            const entries = history[role];
            if (use.retire !== undefined) {
              const i = entries.findIndex(
                (e) => e.kid === use.retire!.kid && e.not_after === undefined,
              );
              if (i >= 0) entries[i] = { ...entries[i]!, not_after: use.retire.not_after! };
            }
            if (use.insert !== undefined && !entries.some((e) => e.kid === use.insert!.kid))
              entries.push(use.insert);
          }),
      }),
      Layer.succeed(PolicyTransparencyLog)({
        append: (json) =>
          Effect.suspend(() => {
            if (stores.failAppend !== undefined)
              return Effect.fail(
                new LogAppendFailed({ log: "private", message: stores.failAppend }),
              );
            appended.push(json);
            const entry: LogEntry = {
              log: "private",
              logIndex: appended.length - 1,
              entryId: `leaf-${appended.length - 1}`,
              integratedTime: clock(),
            };
            return Effect.succeed(entry);
          }),
      }),
    ),
  };
  return stores;
};
