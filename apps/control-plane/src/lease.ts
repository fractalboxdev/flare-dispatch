// The application's lease fields: which image an execution of a run runs in, by digest, what names the execution, and
// the nonce bound to the execution and epoch (specs/provenance.md § Nonce and epoch).
import type { CatalogEntry } from "@fractalboxdev/flare-dispatch-catalog";
import RUN_DIGESTS from "@fractalboxdev/flare-dispatch-catalog/run-digests" with { type: "json" };
import { requestContextOf, type IntakeRecord } from "@fractalboxdev/flare-dispatch-intake";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Schema } from "effect";

/** The image a host execution names: it runs in no image, and a lease must carry the field. */
export const NO_IMAGE = "none: host execution";

/** The `run_digest` of a lease whose run the catalogue lacks: no run definition has it. */
export const NO_RUN_DIGEST = "sha256:none";

/** A lease for a run that executes in the gate image, on a deploy that names no digest for it. */
export class GateImageUnpinned extends Schema.TaggedError<GateImageUnpinned>()(
  "GateImageUnpinned",
  {
    run: Schema.String,
    executorKind: Schema.String,
  },
) {}

/**
 * The image a lease names (MAMEKO-EXEC-041): none for a host execution on a device, else the gate image by digest
 * (`infra/v2/Dockerfile.gate`), which the deploy holds as `GATE_IMAGE_DIGEST`. Without it such a lease fails.
 */
export const imageDigestOf = (
  entry: CatalogEntry | null,
  executorKind: string,
  gateDigest: string | undefined,
): Effect.Effect<string, GateImageUnpinned> =>
  executorKind === "device" && (entry === null || entry.hostExecution)
    ? Effect.succeed(NO_IMAGE)
    : gateDigest !== undefined && /^sha256:[0-9a-f]{64}$/.test(gateDigest)
      ? Effect.succeed(gateDigest)
      : Effect.fail(new GateImageUnpinned({ run: entry?.spec.name ?? "", executorKind }));

/**
 * A gate run's lease input: the recorded input with the execution's `deadline_at` as `GateContext.deadlineAt`, so every
 * command of the run stops there and records `deadline` (FD-GATE-007). An agentic run's input is the recorded one.
 */
export const gateInputs = (entry: CatalogEntry | null, inputs: unknown, deadlineAt: number) =>
  entry !== null && entry.agentic === undefined && isRecord(inputs)
    ? { ...inputs, deadlineAt }
    : inputs;

/**
 * The application's lease fields that name the execution (FD-PROF-063): the repository admission wrote on the
 * execution row as the scope id, the recorded inputs with the commit SHA they verify, the run registry's run version
 * and workflow version, and the request context intake recorded before admission.
 */
export const requestLeaseFields = (
  entry: CatalogEntry | null,
  record: IntakeRecord,
  execution: { readonly scope_id: string; readonly deadline_at: number },
) => ({
  // The run-definition digest the runner checks the lease's run against; a run the catalogue lacks names a digest no
  // run has, so a runner refuses it (MAMEKO-EXEC-157).
  run_digest:
    entry === null
      ? NO_RUN_DIGEST
      : ((RUN_DIGESTS as Readonly<Record<string, string>>)[entry.spec.name] ?? NO_RUN_DIGEST),
  run_version: entry?.spec.version ?? "",
  workflow_version: entry?.workflowVersion ?? 1,
  request_context: requestContextOf(record),
  scope_id: execution.scope_id,
  inputs: gateInputs(entry, record.inputs, execution.deadline_at),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A lease nonce's length: 128 random bits (FD-PROV-010). */
export const LEASE_NONCE_BYTES = 16;

/** 128 random bits from the Web Crypto CSPRNG, as 32 lowercase hex characters. */
export const freshLeaseNonce = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(LEASE_NONCE_BYTES)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/**
 * The nonce each execution lease carries, one row per (`execution_id`, epoch) (FD-PROV-010). `invalidated_at` is set
 * when the epoch's lease is reclaimed or a later epoch's lease is granted (FD-PROV-011); an invalidated nonce binds no
 * statement. `consumed_nonces` holds each nonce, a lease's or a registration's, that an accepted statement consumed,
 * one row per nonce (FD-PROV-021).
 */
export const LEASE_NONCE_SCHEMA = [
  `create table if not exists lease_nonces (
    execution_id text not null,
    epoch integer not null,
    nonce text not null unique,
    issued_at integer not null,
    invalidated_at integer,
    primary key (execution_id, epoch))`,
  `create table if not exists consumed_nonces (
    nonce text primary key,
    execution_id text not null,
    epoch integer not null,
    consumed_at integer not null)`,
];

const migrated = new WeakMap<D1Like, Promise<unknown>>();

/** Creates the lease-nonce table once per database handle. */
export const migrateLeaseNonces = (db: D1Like): Promise<unknown> => {
  const existing = migrated.get(db);
  if (existing !== undefined) return existing;
  const run = (async () => {
    for (const sql of LEASE_NONCE_SCHEMA) await db.prepare(sql).run();
  })().catch((e: unknown) => {
    migrated.delete(db);
    throw e;
  });
  migrated.set(db, run);
  return run;
};

/** A lease grant at an epoch whose nonce a reclaim already invalidated. */
export class LeaseNonceInvalidated extends Schema.TaggedError<LeaseNonceInvalidated>()(
  "LeaseNonceInvalidated",
  {
    executionId: Schema.String,
    epoch: Schema.Number,
  },
) {}

/**
 * The nonce a lease grant carries (FD-PROV-010, FD-PROV-011): 128 random bits, stored against the execution and the
 * epoch. A grant at a new epoch invalidates every earlier epoch's nonce of the execution in the same batch; a repeated
 * grant at the same epoch (a launch-bound socket's lease) answers the nonce already issued for it. A grant at an epoch
 * whose nonce is invalidated fails.
 */
export const leaseNonce = (
  db: D1Like,
  executionId: string,
  epoch: number,
  now: number,
): Effect.Effect<string, LeaseNonceInvalidated> =>
  Effect.gen(function* () {
    yield* Effect.promise(() => migrateLeaseNonces(db));
    const results = yield* Effect.promise(() =>
      db.batch([
        db
          .prepare(
            `update lease_nonces set invalidated_at = ?
             where execution_id = ? and epoch < ? and invalidated_at is null`,
          )
          .bind(now, executionId, epoch),
        db
          .prepare(
            `insert into lease_nonces (execution_id, epoch, nonce, issued_at) values (?, ?, ?, ?)
             on conflict (execution_id, epoch) do nothing`,
          )
          .bind(executionId, epoch, freshLeaseNonce(), now),
        db
          .prepare(
            "select nonce, invalidated_at from lease_nonces where execution_id = ? and epoch = ?",
          )
          .bind(executionId, epoch),
      ]),
    );
    const row = results[2]?.results?.[0] as
      | { readonly nonce: string; readonly invalidated_at: number | null }
      | undefined;
    if (row === undefined || row.invalidated_at !== null)
      return yield* new LeaseNonceInvalidated({ executionId, epoch });
    return row.nonce;
  });

/**
 * Invalidates the nonce of the execution's lease at `epoch` and of every earlier epoch, as the lease is reclaimed
 * (FD-PROV-011). The channel and the liveness monitor call it while they revoke the epoch's credentials, before the
 * reclaim frees the placement.
 */
export const invalidateLeaseNonce = (
  db: D1Like,
  executionId: string,
  epoch: number,
  now: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.promise(() => migrateLeaseNonces(db));
    yield* Effect.promise(() =>
      db
        .prepare(
          `update lease_nonces set invalidated_at = ?
           where execution_id = ? and epoch <= ? and invalidated_at is null`,
        )
        .bind(now, executionId, epoch)
        .run(),
    );
  });

/**
 * The nonce issued for the execution's lease at `epoch` while it is still valid, else null: the nonce a statement for
 * that execution and epoch must carry (FD-PROV-020).
 */
export const issuedLeaseNonce = (
  db: D1Like,
  executionId: string,
  epoch: number,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    yield* Effect.promise(() => migrateLeaseNonces(db));
    const { results } = yield* Effect.promise(() =>
      db
        .prepare(
          `select nonce from lease_nonces
           where execution_id = ? and epoch = ? and invalidated_at is null`,
        )
        .bind(executionId, epoch)
        .all(),
    );
    return (results[0] as { readonly nonce: string } | undefined)?.nonce ?? null;
  });

/** Whether an accepted statement consumed the nonce (FD-PROV-021). */
export const nonceConsumed = (db: D1Like, nonce: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    yield* Effect.promise(() => migrateLeaseNonces(db));
    const { results } = yield* Effect.promise(() =>
      db.prepare("select 1 as consumed from consumed_nonces where nonce = ?").bind(nonce).all(),
    );
    return results.length > 0;
  });

/**
 * Records the nonce consumed by the statement accepted for the execution at `epoch` (FD-PROV-021). The insert is the
 * consumption's compare-and-set: it answers false when another accepted statement consumed the nonce first.
 */
export const consumeNonce = (
  db: D1Like,
  nonce: string,
  executionId: string,
  epoch: number,
  now: number,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    yield* Effect.promise(() => migrateLeaseNonces(db));
    const { results } = yield* Effect.promise(() =>
      db
        .prepare(
          `insert into consumed_nonces (nonce, execution_id, epoch, consumed_at) values (?, ?, ?, ?)
           on conflict (nonce) do nothing returning nonce`,
        )
        .bind(nonce, executionId, epoch, now)
        .all(),
    );
    return results.length === 1;
  });
