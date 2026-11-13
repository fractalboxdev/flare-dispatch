// An admitted execution as the control plane records it: its intake record and mameko's execution row, on a D1 with
// mameko's and intake's tables.
import {
  d1IntakeStore,
  IntakeStore,
  type IntakeRecord,
} from "@fractalboxdev/flare-dispatch-intake";
import type { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { LOG_APPEND_SCHEMA } from "@fractalboxdev/flare-dispatch-cache";
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

/** A countersigned envelope's canonical JSON whose statement names one `sha256` subject. */
export const envelopeNaming = (name: string, sha256: string) =>
  JSON.stringify({
    payload: Buffer.from(
      JSON.stringify({
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ name, digest: { sha256 } }],
      }),
    ).toString("base64"),
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ keyid: "device-1", sig: "MEUCIQ==" }],
  });

/**
 * One log-append intent as the countersign step records it in `provenance_log_appends` and its subject in
 * `provenance_statement_subjects`; `logged` gives its log entry, a pending intent has none.
 */
export const seedStatement = (
  db: TestD1,
  statement: {
    readonly envelopeDigest: string;
    readonly executionId: string;
    readonly log: "rekor" | "private";
    readonly subject: string;
    readonly logged?: { readonly logIndex: number; readonly entryId: string };
    readonly insertedAt?: number;
  },
) => {
  for (const sql of LOG_APPEND_SCHEMA) db.sqlite.exec(sql);
  db.sqlite
    .prepare(
      `insert into provenance_log_appends (envelope_digest, execution_id, repository, log, envelope, verifiers, attempts,
         next_attempt_at, log_index, entry_id, integrated_time, inserted_at)
       values (?, ?, 'acme/app', ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      statement.envelopeDigest,
      statement.executionId,
      statement.log,
      envelopeNaming("app.tar", statement.subject),
      statement.logged === undefined ? 0 : 1,
      statement.logged === undefined ? NOW : null,
      statement.logged?.logIndex ?? null,
      statement.logged?.entryId ?? null,
      statement.logged === undefined ? null : NOW,
      statement.insertedAt ?? NOW,
    );
  db.sqlite
    .prepare(
      "insert into provenance_statement_subjects (subject_digest, envelope_digest) values (?, ?)",
    )
    .run(`sha256:${statement.subject}`, statement.envelopeDigest);
};
