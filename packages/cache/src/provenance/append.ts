// The transparency-log append of a countersigned statement (specs/provenance.md § Countersignature and transparency
// log). When the control plane countersigns a statement it records a log-append intent keyed by the envelope digest
// (FD-PROV-034): one row of `provenance_log_appends` per countersigned envelope, inserted with `on conflict do
// nothing`, so a replayed countersign step whose envelope its journal holds adds no second row and no second entry.
// The intent names its log once, at insert: the public Rekor log where the repository's GitHub visibility is `public`
// (FD-PROV-035), the private log in R2 otherwise, a visibility that cannot be read included (FD-PROV-036).
//
// Applying an intent appends the envelope's canonical JSON to its log. A failed append leaves the intent pending with
// its next attempt `retryDelayMs` later, 5 s doubling to 10 min, with no attempt limit, and the check summary shows the
// statement as `log-pending` meanwhile (FD-PROV-041). A logged intent holds the log entry, whose integrated time is the
// statement's time; no executor clock is read (FD-PROV-040).
//
// The intent is not an outbox row: the outbox drainer backs off from 1 s under the installation's applier permit
// (MAMEKO-OUT-018), where FD-PROV-041 fixes a 5 s floor and a log append takes no GitHub permit.
import { Context, Data, Effect, Option, Schema } from "effect";
import { canonicalJson, sha256Hex, utf8 } from "../crypto.ts";
import { countersignAccepted, CountersignOutcome, type StatementBinding } from "./countersign.ts";
import type { DsseEnvelope, ProvenanceKey } from "./dsse.ts";
import { AppendOutcome } from "./log.ts";
import { sha256Subjects, statementSubjects } from "./subjects.ts";

/** The log a statement is appended to: the public Rekor log, or the control plane's private log in R2. */
export const LogKind = Schema.Literals(["rekor", "private"]);
export type LogKind = typeof LogKind.Type;

/** The first retry delay after a failed append (FD-PROV-041). */
export const RETRY_FLOOR_MS = 5_000;
/** The longest retry delay (FD-PROV-041). */
export const RETRY_CAP_MS = 600_000;

/** The delay before the next attempt after `failures` failed appends: 5 s, doubling, at most 10 min. */
export const retryDelayMs = (failures: number): number =>
  Math.min(RETRY_CAP_MS, RETRY_FLOOR_MS * 2 ** Math.max(0, failures - 1));

/** The status the check summary shows for a statement whose append has not succeeded (FD-PROV-041). */
export const LOG_PENDING = "log-pending";

/**
 * The log for a repository's GitHub visibility: Rekor for `public` (FD-PROV-035), the private log for any other value
 * and for a visibility that could not be read, `undefined` (FD-PROV-036).
 */
export const logForVisibility = (visibility: string | undefined): LogKind =>
  visibility === "public" ? "rekor" : "private";

/** One entry a log answered for an append. `integratedTime` is the log's clock, in milliseconds since the epoch. */
export interface LogEntry {
  readonly log: LogKind;
  readonly logIndex: number;
  /** The entry's id in its log: Rekor's entry UUID, or the private log's leaf hash. */
  readonly entryId: string;
  readonly integratedTime: number;
}

export class LogAppendFailed extends Schema.TaggedError<LogAppendFailed>()("LogAppendFailed", {
  log: LogKind,
  message: Schema.String,
}) {}

export class VisibilityUnreadable extends Schema.TaggedError<VisibilityUnreadable>()(
  "VisibilityUnreadable",
  { repository: Schema.String, message: Schema.String },
) {}

export class LogAppendStoreFailed extends Schema.TaggedError<LogAppendStoreFailed>()(
  "LogAppendStoreFailed",
  { message: Schema.String },
) {}

export class SubjectRetentionFailed extends Schema.TaggedError<SubjectRetentionFailed>()(
  "SubjectRetentionFailed",
  { message: Schema.String },
) {}

/**
 * Keeps the artifacts a logged statement names as subjects until the statement retention after its integrated time
 * (FD-PROV-075). The artifact store implements it (artifacts.ts `artifactSubjectRetention`).
 */
export class SubjectRetention extends Context.Service<
  SubjectRetention,
  {
    readonly retain: (statement: {
      readonly executionId: string;
      /** The statement's `sha256:<hex>` subject digests. */
      readonly subjects: readonly string[];
      readonly integratedTime: number;
    }) => Effect.Effect<void, SubjectRetentionFailed>;
  }
>()("@fractalboxdev/flare-dispatch-cache/SubjectRetention") {}

/** The repository's GitHub visibility (`public`, `private` or `internal`), as GitHub reports it. */
export class RepositoryVisibility extends Context.Service<
  RepositoryVisibility,
  { readonly of: (repository: string) => Effect.Effect<string, VisibilityUnreadable> }
>()("@fractalboxdev/flare-dispatch-cache/RepositoryVisibility") {}

/** The two logs. Each takes the envelope's canonical JSON; an append of bytes already in the log answers that entry. */
export class TransparencyLogs extends Context.Service<
  TransparencyLogs,
  {
    readonly rekor: (
      envelopeJson: string,
      verifiers: readonly JsonWebKey[],
    ) => Effect.Effect<LogEntry, LogAppendFailed>;
    readonly private: (envelopeJson: string) => Effect.Effect<LogEntry, LogAppendFailed>;
  }
>()("@fractalboxdev/flare-dispatch-cache/TransparencyLogs") {}

/** Where an intent's append stands. */
export type LogAppendStatus = Data.TaggedEnum<{
  /** No append has succeeded; the next attempt is due at `nextAttemptAt`. */
  Pending: {
    readonly attempts: number;
    readonly nextAttemptAt: number;
    readonly lastError: string | null;
  };
  /** The log answered `entry`. */
  Logged: { readonly attempts: number; readonly entry: LogEntry };
}>;
export const LogAppendStatus = Data.taggedEnum<LogAppendStatus>();

/** One log-append intent: a countersigned envelope, the log it goes to, and where its append stands. */
export interface LogAppendIntent {
  /** `sha256:<hex>` of the envelope's canonical JSON: the intent's key. */
  readonly envelopeDigest: string;
  readonly executionId: string;
  readonly repository: string;
  readonly log: LogKind;
  /** The countersigned envelope's canonical JSON: the bytes the log appends. */
  readonly envelope: string;
  /** The public keys of the envelope's signers, which Rekor verifies each signature against. */
  readonly verifiers: readonly JsonWebKey[];
  readonly status: LogAppendStatus;
}

/** The log-append intents, keyed by envelope digest. */
export class LogAppendStore extends Context.Service<
  LogAppendStore,
  {
    /** Inserts the intent unless one with its digest exists; answers whether it inserted. */
    readonly insert: (
      intent: LogAppendIntent,
      now: number,
    ) => Effect.Effect<boolean, LogAppendStoreFailed>;
    readonly get: (digest: string) => Effect.Effect<LogAppendIntent | null, LogAppendStoreFailed>;
    /** The digests of the pending intents due at `now`, oldest due first. */
    readonly due: (now: number) => Effect.Effect<readonly string[], LogAppendStoreFailed>;
    /** When the earliest pending intent is due, or `null` when none is pending. */
    readonly nextDue: () => Effect.Effect<number | null, LogAppendStoreFailed>;
    /** The intents of an execution's statements. */
    readonly forExecution: (
      executionId: string,
    ) => Effect.Effect<readonly LogAppendIntent[], LogAppendStoreFailed>;
    /** The intents of the statements that name `digest`, `<algorithm>:<value>`, as a subject. */
    readonly forSubject: (
      digest: string,
    ) => Effect.Effect<readonly LogAppendIntent[], LogAppendStoreFailed>;
    /** Records the entry of a pending intent; a logged intent keeps its first entry. */
    readonly logged: (
      digest: string,
      attempts: number,
      entry: LogEntry,
    ) => Effect.Effect<void, LogAppendStoreFailed>;
    /** Records a failed attempt of a pending intent and when the next one is due. */
    readonly failed: (
      digest: string,
      attempts: number,
      nextAttemptAt: number,
      error: string,
    ) => Effect.Effect<void, LogAppendStoreFailed>;
  }
>()("@fractalboxdev/flare-dispatch-cache/LogAppendStore") {}

/** The canonical JSON of an envelope and its digest, the intent key. */
export const envelopeEntry = async (envelope: DsseEnvelope) => {
  const json = canonicalJson(envelope);
  return { json, digest: `sha256:${await sha256Hex(utf8(json))}` };
};

/** The public half of a provenance key: what a verifier checks the countersignature against. */
export const publicJwkOf = ({
  kty,
  crv,
  x,
  y,
  kid,
}: ProvenanceKey): JsonWebKey & { kid: string } => ({
  kty,
  crv,
  x,
  y,
  kid,
});

/** A statement the control plane countersigned, with what its log append needs. */
export interface CountersignedStatement {
  readonly envelope: DsseEnvelope;
  readonly executionId: string;
  readonly repository: string;
  /** The public keys of the envelope's signers: the device key and the provenance key. */
  readonly verifiers: readonly JsonWebKey[];
}

/**
 * Records the log-append intent of a countersigned envelope, keyed by its digest (FD-PROV-034), with the log the
 * repository's visibility names (FD-PROV-035, FD-PROV-036). A visibility read that fails sends the statement to the
 * private log. An intent already recorded for the digest stays as it is, and answers the log it names without a
 * visibility read.
 */
export const enqueueLogAppend = (statement: CountersignedStatement, now: number) =>
  Effect.gen(function* () {
    const { json, digest } = yield* Effect.promise(() => envelopeEntry(statement.envelope));
    const store = yield* LogAppendStore;
    const existing = yield* store.get(digest);
    if (existing !== null) return { digest, log: existing.log, inserted: false };
    const visibility = yield* RepositoryVisibility;
    const read = yield* visibility.of(statement.repository).pipe(
      Effect.map((v): string | undefined => v),
      Effect.catchTag("VisibilityUnreadable", (e) =>
        Effect.as(
          Effect.logWarning(
            "repository visibility unreadable; the statement goes to the private log",
            {
              repository: e.repository,
              message: e.message,
            },
          ),
          undefined,
        ),
      ),
    );
    const intent: LogAppendIntent = {
      envelopeDigest: digest,
      executionId: statement.executionId,
      repository: statement.repository,
      log: logForVisibility(read),
      envelope: json,
      verifiers: statement.verifiers,
      status: LogAppendStatus.Pending({ attempts: 0, nextAttemptAt: now, lastError: null }),
    };
    const inserted = yield* store.insert(intent, now);
    if (inserted) return { digest, log: intent.log, inserted };
    // A concurrent insert recorded the intent first; its log stands.
    const stored = yield* store.get(digest);
    return { digest, log: stored?.log ?? intent.log, inserted };
  });

/**
 * The control plane's step after it accepts a statement: countersign it (FD-PROV-032) and record its log-append
 * intent (FD-PROV-034). A statement left advisory (FD-PROV-025) is not countersigned and records no intent.
 */
export const countersignAndAppend = (
  envelope: DsseEnvelope,
  binding: StatementBinding,
  key: ProvenanceKey,
  statement: {
    readonly executionId: string;
    readonly repository: string;
    readonly deviceKey: JsonWebKey;
  },
  now: number,
) =>
  Effect.gen(function* () {
    const outcome = yield* countersignAccepted(envelope, binding, key);
    if (!CountersignOutcome.$is("Countersigned")(outcome)) return { outcome, intent: undefined };
    const intent = yield* enqueueLogAppend(
      {
        envelope: outcome.envelope,
        executionId: statement.executionId,
        repository: statement.repository,
        verifiers: [statement.deviceKey, publicJwkOf(key)],
      },
      now,
    );
    return { outcome, intent };
  });

/**
 * Attempts the append of one intent when it is pending and due at `now`. Success extends the retention of the
 * artifacts the statement names to its integrated time plus the statement retention (FD-PROV-075), then records the
 * log's entry; a failed append or retention records the attempt and sets the next one `retryDelayMs` later
 * (FD-PROV-041), and the retried append answers the entry the log already holds. Answers the intent as it now stands,
 * or `null` when no intent has the digest.
 */
export const applyLogAppend = (digest: string, now: number) =>
  Effect.gen(function* () {
    const store = yield* LogAppendStore;
    const intent = yield* store.get(digest);
    if (intent === null) return null;
    const pending = LogAppendStatus.$match(intent.status, {
      Pending: (p) => (p.nextAttemptAt <= now ? p : undefined),
      Logged: () => undefined,
    });
    if (pending === undefined) return intent;
    const logs = yield* TransparencyLogs;
    const append =
      intent.log === "rekor"
        ? logs.rekor(intent.envelope, intent.verifiers)
        : logs.private(intent.envelope);
    const retention = yield* SubjectRetention;
    const subjects = sha256Subjects(statementSubjects(intent.envelope));
    const attempts = pending.attempts + 1;
    const retry = (warning: string, message: string) => {
      const nextAttemptAt = now + retryDelayMs(attempts);
      return store.failed(digest, attempts, nextAttemptAt, message).pipe(
        Effect.andThen(
          Effect.logWarning(warning, {
            digest,
            log: intent.log,
            attempts,
            nextAttemptAt,
            message,
          }),
        ),
        Effect.as(LogAppendStatus.Pending({ attempts, nextAttemptAt, lastError: message })),
      );
    };
    const status = yield* append.pipe(
      Effect.tap((entry) =>
        retention.retain({
          executionId: intent.executionId,
          subjects,
          integratedTime: entry.integratedTime,
        }),
      ),
      Effect.flatMap((entry) =>
        Effect.as(
          store.logged(digest, attempts, entry),
          LogAppendStatus.Logged({ attempts, entry }),
        ),
      ),
      Effect.catchTags({
        LogAppendFailed: (e) => retry("log append failed; retrying", e.message),
        SubjectRetentionFailed: (e) =>
          retry(
            "subject retention failed; retrying the logged append",
            `subject retention: ${e.message}`,
          ),
      }),
    );
    return { ...intent, status } satisfies LogAppendIntent;
  });

/**
 * Attempts every pending intent due at `now`, and answers how many it attempted and when the earliest still pending is
 * due, the time the caller next drains at.
 */
export const drainLogAppends = (now: number) =>
  Effect.gen(function* () {
    const store = yield* LogAppendStore;
    const due = yield* store.due(now);
    for (const digest of due) yield* applyLogAppend(digest, now);
    return { attempted: due.length, nextDueAt: yield* store.nextDue() };
  });

/** A logged statement's time: its log entry's integrated time (FD-PROV-040); none while its append is pending. */
export const statementTime = (intent: LogAppendIntent): Option.Option<number> =>
  LogAppendStatus.$match(intent.status, {
    Pending: () => Option.none(),
    Logged: ({ entry }) => Option.some(entry.integratedTime),
  });

const LOG_NAMES: Readonly<Record<LogKind, string>> = { rekor: "Rekor", private: "the private log" };

/**
 * The line the check summary shows for a statement: `log-pending` until its append succeeds (FD-PROV-041), then the
 * log, the entry's index and its integrated time.
 */
export const statementSummaryLine = (intent: LogAppendIntent): string =>
  LogAppendStatus.$match(intent.status, {
    Pending: () => `Provenance statement \`${intent.envelopeDigest}\`: ${LOG_PENDING}`,
    Logged: ({ entry }) =>
      `Provenance statement \`${intent.envelopeDigest}\`: logged in ${LOG_NAMES[entry.log]} at index ${entry.logIndex}, ${new Date(entry.integratedTime).toISOString()}`,
  });

// ---------------------------------------------------------------------------
// The D1 store

/** The `provenance_log_appends` table: one row per log-append intent, keyed by envelope digest. */
export const LOG_APPEND_SCHEMA = [
  `create table if not exists provenance_log_appends (
     envelope_digest text primary key,
     execution_id text not null,
     repository text not null,
     log text not null,
     envelope text not null,
     verifiers text not null,
     attempts integer not null,
     next_attempt_at integer,
     last_error text,
     log_index integer,
     entry_id text,
     integrated_time integer,
     inserted_at integer not null)`,
  `create index if not exists provenance_log_appends_due on provenance_log_appends (next_attempt_at)
     where integrated_time is null`,
  "create index if not exists provenance_log_appends_execution on provenance_log_appends (execution_id)",
  // Each subject digest of an intent's statement, so a statement is found by the artifact it names (FD-PROV-071).
  `create table if not exists provenance_statement_subjects (
     subject_digest text not null,
     envelope_digest text not null,
     primary key (subject_digest, envelope_digest))`,
];

interface Row {
  readonly envelope_digest: string;
  readonly execution_id: string;
  readonly repository: string;
  readonly log: LogKind;
  readonly envelope: string;
  readonly verifiers: string;
  readonly attempts: number;
  readonly next_attempt_at: number | null;
  readonly last_error: string | null;
  readonly log_index: number | null;
  readonly entry_id: string | null;
  readonly integrated_time: number | null;
}

const intentOf = (row: Row): LogAppendIntent => ({
  envelopeDigest: row.envelope_digest,
  executionId: row.execution_id,
  repository: row.repository,
  log: row.log,
  envelope: row.envelope,
  verifiers: JSON.parse(row.verifiers) as JsonWebKey[],
  status:
    row.integrated_time === null
      ? LogAppendStatus.Pending({
          attempts: row.attempts,
          nextAttemptAt: row.next_attempt_at ?? 0,
          lastError: row.last_error,
        })
      : LogAppendStatus.Logged({
          attempts: row.attempts,
          entry: {
            log: row.log,
            logIndex: row.log_index ?? 0,
            entryId: row.entry_id ?? "",
            integratedTime: row.integrated_time,
          },
        }),
});

/** The store over the control plane's D1 database; it creates its table on first use. */
export const d1LogAppendStore = (db: D1Database): LogAppendStore["Service"] => {
  let ready: Promise<unknown> | undefined;
  const run = <A>(work: () => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        ready ??= db.batch(LOG_APPEND_SCHEMA.map((s) => db.prepare(s))).catch((e: unknown) => {
          ready = undefined;
          throw e;
        });
        await ready;
        return await work();
      },
      catch: (e) =>
        new LogAppendStoreFailed({ message: e instanceof Error ? e.message : String(e) }),
    });
  const PENDING = "integrated_time is null";
  return {
    insert: (intent, now) =>
      run(async () => {
        const pending = LogAppendStatus.$match(intent.status, {
          Pending: (p) => p,
          Logged: () => undefined,
        });
        const subjects = [
          ...new Set(statementSubjects(intent.envelope).map((subject) => subject.digest)),
        ];
        const [result] = await db.batch([
          db
            .prepare(
              `insert into provenance_log_appends (envelope_digest, execution_id, repository, log, envelope, verifiers,
                 attempts, next_attempt_at, inserted_at) values (?, ?, ?, ?, ?, ?, 0, ?, ?)
               on conflict (envelope_digest) do nothing`,
            )
            .bind(
              intent.envelopeDigest,
              intent.executionId,
              intent.repository,
              intent.log,
              intent.envelope,
              JSON.stringify(intent.verifiers),
              pending?.nextAttemptAt ?? now,
              now,
            ),
          ...subjects.map((subject) =>
            db
              .prepare(
                `insert into provenance_statement_subjects (subject_digest, envelope_digest) values (?, ?)
                 on conflict do nothing`,
              )
              .bind(subject, intent.envelopeDigest),
          ),
        ]);
        return (result?.meta.changes ?? 0) > 0;
      }),
    get: (digest) =>
      run(async () => {
        const row = await db
          .prepare("select * from provenance_log_appends where envelope_digest = ?")
          .bind(digest)
          .first<Row>();
        return row === null ? null : intentOf(row);
      }),
    due: (now) =>
      run(async () => {
        const { results } = await db
          .prepare(
            `select envelope_digest from provenance_log_appends where ${PENDING} and next_attempt_at <= ?
             order by next_attempt_at, envelope_digest`,
          )
          .bind(now)
          .all<{ envelope_digest: string }>();
        return results.map((r) => r.envelope_digest);
      }),
    nextDue: () =>
      run(async () => {
        const row = await db
          .prepare(`select min(next_attempt_at) as at from provenance_log_appends where ${PENDING}`)
          .first<{ at: number | null }>();
        return row?.at ?? null;
      }),
    forExecution: (executionId) =>
      run(async () => {
        const { results } = await db
          .prepare(
            "select * from provenance_log_appends where execution_id = ? order by inserted_at, envelope_digest",
          )
          .bind(executionId)
          .all<Row>();
        return results.map(intentOf);
      }),
    forSubject: (digest) =>
      run(async () => {
        const { results } = await db
          .prepare(
            `select a.* from provenance_statement_subjects s
               join provenance_log_appends a on a.envelope_digest = s.envelope_digest
             where s.subject_digest = ? order by a.inserted_at, a.envelope_digest`,
          )
          .bind(digest)
          .all<Row>();
        return results.map(intentOf);
      }),
    logged: (digest, attempts, entry) =>
      run(() =>
        db
          .prepare(
            `update provenance_log_appends set attempts = ?, next_attempt_at = null, last_error = null,
               log_index = ?, entry_id = ?, integrated_time = ? where envelope_digest = ? and ${PENDING}`,
          )
          .bind(attempts, entry.logIndex, entry.entryId, entry.integratedTime, digest)
          .run(),
      ).pipe(Effect.asVoid),
    failed: (digest, attempts, nextAttemptAt, error) =>
      run(() =>
        db
          .prepare(
            `update provenance_log_appends set attempts = ?, next_attempt_at = ?, last_error = ?
             where envelope_digest = ? and ${PENDING}`,
          )
          .bind(attempts, nextAttemptAt, error, digest)
          .run(),
      ).pipe(Effect.asVoid),
  };
};

// ---------------------------------------------------------------------------
// The private log

/**
 * The private log's append over the one `TransparencyLog` object (FD-PROV-074). The entry's integrated time is the
 * object's clock at its first append; an append of bytes already in the log answers that earlier entry.
 */
export const privateLogAppend =
  (log: { append(entry: Uint8Array): Promise<AppendOutcome> }) =>
  (envelopeJson: string): Effect.Effect<LogEntry, LogAppendFailed> =>
    Effect.tryPromise({
      try: () => log.append(utf8(envelopeJson)),
      catch: (e) =>
        new LogAppendFailed({
          log: "private",
          message: e instanceof Error ? e.message : String(e),
        }),
    }).pipe(
      Effect.flatMap((answer) =>
        AppendOutcome.$match(answer, {
          Appended: (a): Effect.Effect<LogEntry, LogAppendFailed> =>
            Effect.succeed({
              log: "private",
              logIndex: a.index,
              entryId: a.leafHash,
              integratedTime: a.integratedAt,
            }),
          Refused: (r) =>
            Effect.fail(
              new LogAppendFailed({
                log: "private",
                message: `the private log refused the write: ${r.reason} at ${r.path}`,
              }),
            ),
        }),
      ),
    );
