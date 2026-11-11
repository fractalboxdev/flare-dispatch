// An admitted execution as the control plane records it: its intake record and mameko's execution row, on a D1 with
// mameko's and intake's tables.
import {
  d1IntakeStore,
  IntakeStore,
  type IntakeRecord,
} from "@fractalboxdev/flare-dispatch-intake";
import type { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import {
  emptyQuotaLedger,
  quotaObjectOver,
  quotaOptionsDefault,
  type QuotaLedger,
  type QuotaObject,
} from "@fractalboxdev/flare-dispatch-github";
import { Effect } from "effect";
import type { ControlPlaneEnv } from "../src/config.ts";

/** An `INSTALLATION_QUOTA` namespace whose objects hold their ledgers in memory, one per name. */
export const memoryQuotaNamespace = (): ControlPlaneEnv["INSTALLATION_QUOTA"] => {
  const objects = new Map<string, QuotaObject>();
  return {
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id);
      let object = objects.get(name);
      if (object === undefined) {
        let ledger: QuotaLedger = emptyQuotaLedger;
        object = quotaObjectOver(quotaOptionsDefault, {
          read: () => ledger,
          write: async (next) => {
            ledger = next;
          },
        });
        objects.set(name, object);
      }
      return object;
    },
  };
};

export type TestD1 = Awaited<ReturnType<typeof migratedD1>>;

export const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
export const LINK_KEY = "link-key-for-tests";
export const ORIGIN = "https://fd.example.com";

export const record = (
  executionId: string,
  overrides: Partial<IntakeRecord> = {},
): IntakeRecord => ({
  executionId,
  trigger: "dispatch",
  run: "check",
  label: "ci",
  repo: "acme/app",
  sha: "b".repeat(40),
  ref: "refs/heads/main",
  inputs: {},
  className: "required",
  labels: [],
  attempt: 1,
  familyRoot: executionId,
  installation: 7,
  caller: null,
  notBefore: null,
  spendLine: null,
  placementConstraint: null,
  cacheTrigger: { _tag: "Other" },
  eligibleKinds: ["device"],
  repositoryPublic: null,
  inputAssociations: [],
  createdAt: NOW,
  ...overrides,
});

/** An admitted execution: its intake record and mameko's execution row. */
export const seedExecution = async (db: TestD1, executionId: string, status = "running") => {
  await Effect.runPromise(
    IntakeStore.use((s) => s.put(record(executionId))).pipe(Effect.provide(d1IntakeStore(db))),
  );
  db.sqlite
    .prepare(
      `insert into executions (id, scope_id, run, class, status, enqueued_at) values (?, 'acme/app', 'check', 'required', ?, ?)`,
    )
    .run(executionId, status, NOW);
};

/** The control plane's bindings over the test's D1. */
export const envOf = (db: unknown, extra: Record<string, string> = {}) =>
  ({
    DB: db,
    PLANE_ID: "flare-dispatch",
    DEPLOYMENT: "production",
    INSTALLATION_QUOTA: memoryQuotaNamespace(),
    ...extra,
  }) as unknown as ControlPlaneEnv;
