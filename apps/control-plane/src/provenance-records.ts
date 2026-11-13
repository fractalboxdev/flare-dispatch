// The records the result-acceptance check compares a device statement against (specs/provenance.md § Acceptance),
// over the control plane's D1 database: mameko's executor registry for the device key, the placement row and lease
// records for the lease, `fd_local_registrations` for a registration, `lease_nonces` for a lease's nonce and
// `consumed_nonces` for each nonce an accepted statement consumed. The composition binds the check over them as the
// `result-acceptance-check` port (MAMEKO-LEASE-093).
import { LOCAL_STORE_MIGRATIONS } from "@fractalboxdev/flare-dispatch-agentic";
import {
  type DeviceKeyRecord,
  MeteringUnavailable,
  resultAcceptanceCheckLayer,
  StatementRecords,
} from "@fractalboxdev/flare-dispatch-cache";
import { d1LeaseStore, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import type { AlarmPort, ResultAcceptanceCheck } from "@fractalboxdev/mameko-ports";
import { Clock, Effect, Layer } from "effect";
import { acceptanceSettingsOf, type ControlPlaneEnv } from "./config.ts";
import { consumeNonce, issuedLeaseNonce, migrateLeaseNonces, nonceConsumed } from "./lease.ts";

const toBase64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The RFC 7638 thumbprint of a public P-256 JWK: base64url SHA-256 of its required members in lexical order. */
export const jwkThumbprint = async (jwk: JsonWebKey): Promise<string> =>
  toBase64url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`,
        ),
      ),
    ),
  );

/** The public JWK of a registered `device_public_key`, the standard-base64 SPKI DER; undefined when it is not one. */
const jwkOf = async (publicKey: string): Promise<JsonWebKey | undefined> => {
  try {
    const der = Uint8Array.from(atob(publicKey), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "spki",
      der,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    return (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  } catch {
    return undefined;
  }
};

/** Each registered key's JWK and thumbprint, by its `device_public_key`; a key's thumbprint never changes. */
const keys = new Map<
  string,
  Promise<{ readonly jwk: JsonWebKey; readonly keyid: string } | undefined>
>();
const keyOf = (publicKey: string) => {
  let key = keys.get(publicKey);
  if (key === undefined) {
    key = jwkOf(publicKey).then(async (jwk) =>
      jwk === undefined ? undefined : { jwk, keyid: await jwkThumbprint(jwk) },
    );
    keys.set(publicKey, key);
  }
  return key;
};

const migrated = new WeakMap<D1Like, Promise<unknown>>();

/**
 * The tables the records read beside mameko's: the lease-nonce and consumed-nonce tables and the local-work tables,
 * created once per database handle where they do not exist yet.
 */
export const migrateStatementRecords = (db: D1Like): Promise<unknown> => {
  const existing = migrated.get(db);
  if (existing !== undefined) return existing;
  const run = (async () => {
    await migrateLeaseNonces(db);
    for (const m of LOCAL_STORE_MIGRATIONS) for (const sql of m.sql) await db.prepare(sql).run();
  })().catch((e: unknown) => {
    migrated.delete(db);
    throw e;
  });
  migrated.set(db, run);
  return run;
};

interface ExecutorRow {
  readonly executor_id: string;
  readonly device_public_key: string;
  readonly code_hash: string | null;
  readonly attested_at: number | null;
  readonly revoked_at: number | null;
}

/**
 * `StatementRecords` over D1. A device key is the registry row of a device executor whose `device_public_key` has the
 * RFC 7638 thumbprint a signature's `keyid` names, revoked or not, with the code hash and attestation time recorded
 * at registration (MAMEKO-LEASE-092). An execution's lease at an epoch is its placement row while leased or accepted
 * at that epoch, or the lease record mameko keeps once the lease ended; a registration is the `fd_local_registrations`
 * row at its capacity-lease epoch. The current epoch is the placement's epoch once the execution was leased, which a
 * reclaim advances, else the registration's. The metering records check 12 compares against are not kept yet, so
 * `meteredModels` fails and the check rejects every statement that reaches it.
 */
export const d1StatementRecords = (db: D1Like): Layer.Layer<StatementRecords> => {
  const ready = Effect.promise(() => migrateStatementRecords(db));
  const rows = <Row>(query: string, ...values: unknown[]) =>
    Effect.andThen(ready, () =>
      Effect.promise(() =>
        db
          .prepare(query)
          .bind(...values)
          .all(),
      ).pipe(Effect.map((r) => r.results as Row[])),
    );
  return Layer.succeed(StatementRecords, {
    deviceKey: (keyid) =>
      Effect.gen(function* () {
        const devices = yield* rows<ExecutorRow>(
          `select executor_id, device_public_key, code_hash, attested_at, revoked_at from executors
           where kind = 'device' and device_public_key is not null`,
        );
        for (const row of devices) {
          const key = yield* Effect.promise(() => keyOf(row.device_public_key));
          if (key?.keyid === keyid)
            return {
              executorId: row.executor_id,
              publicKey: key.jwk,
              codeHash: row.code_hash,
              attestedAt: row.attested_at,
              revokedAt: row.revoked_at,
            } satisfies DeviceKeyRecord;
        }
        return null;
      }),
    issued: (executionId, epoch) =>
      Effect.map(
        rows<{ readonly executor_id: string }>(
          `select executor_id from placements
             where execution_id = ?1 and epoch = ?2 and state in ('leased', 'accepted') and executor_id is not null
           union all
           select executor_id from lease_records where execution_id = ?1 and epoch = ?2
           union all
           select executor_id from fd_local_registrations where execution_id = ?1 and epoch = ?2
           limit 1`,
          executionId,
          epoch,
        ),
        ([row]) => (row === undefined ? null : { executorId: row.executor_id }),
      ),
    currentEpoch: (executionId) =>
      Effect.map(
        rows<{ readonly source: string; readonly epoch: number; readonly leases: number }>(
          `select 'placement' as source, epoch, leases from placements where execution_id = ?1
           union all
           select 'registration' as source, epoch, 0 as leases from fd_local_registrations where execution_id = ?1`,
          executionId,
        ),
        (found) => {
          const placement = found.find((r) => r.source === "placement");
          const registration = found.find((r) => r.source === "registration");
          if (
            placement !== undefined &&
            (Number(placement.leases) > 0 || registration === undefined)
          )
            return Number(placement.epoch);
          return registration === undefined ? 0 : Number(registration.epoch);
        },
      ),
    issuedNonce: (executionId, epoch) =>
      Effect.gen(function* () {
        const lease = yield* issuedLeaseNonce(db, executionId, epoch);
        if (lease !== null) return lease;
        const [registration] = yield* rows<{ readonly nonce: string }>(
          "select nonce from fd_local_registrations where execution_id = ? and epoch = ?",
          executionId,
          epoch,
        );
        return registration?.nonce ?? null;
      }),
    nonceConsumed: (nonce) => nonceConsumed(db, nonce),
    consumeNonce: (nonce, executionId, epoch) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        consumeNonce(db, nonce, executionId, epoch, now),
      ),
    meteredModels: (executionId, epoch) =>
      Effect.fail(
        new MeteringUnavailable({
          executionId,
          epoch,
          detail: "the model gateway keeps no metering record of model ids per execution and epoch",
        }),
      ),
  });
};

/**
 * The `result-acceptance-check` port: FlareDispatch's check over the D1 statement records and mameko's executor
 * registry, which a quarantining rejection flags, with `attestation_max_age` from the overlay (FD-PROV-016).
 */
export const resultAcceptanceLayer = (
  env: Pick<ControlPlaneEnv, "DB" | "ATTESTATION_MAX_AGE_DAYS">,
): Layer.Layer<ResultAcceptanceCheck, never, AlarmPort> =>
  resultAcceptanceCheckLayer(acceptanceSettingsOf(env)).pipe(
    Layer.provide(Layer.merge(d1StatementRecords(env.DB), d1LeaseStore(env.DB))),
  );
