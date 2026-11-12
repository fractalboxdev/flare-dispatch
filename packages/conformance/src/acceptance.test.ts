// The result-acceptance check the control plane's composition binds as the `result-acceptance-check` port, over its
// D1 statement records under Miniflare (specs/provenance.md § Acceptance). Each world is written by the paths that
// write it in production: mameko's executor registry and admission and placement stores, the control plane's lease
// nonce, and the agentic package's registration store. The gateway metering records check 12 reads are not kept, so a
// statement that passes checks 1 to 11 is rejected `provenance: metering unavailable`: that is the verdict each
// negative test departs from by one change.
import {
  LocalStore,
  localStoreD1,
  type RegistrationRecord,
} from "@fractalboxdev/flare-dispatch-agentic";
import {
  DSSE_PAYLOAD_TYPE,
  dssePae,
  METERING_UNAVAILABLE,
  parseProvenanceKey,
  signPae,
  StatementRecords,
  statementOf,
  unsignedEnvelope,
  type DsseEnvelope,
  type ProvenanceKey,
  type StatementBody,
} from "@fractalboxdev/flare-dispatch-cache";
import { migrateIntake } from "@fractalboxdev/flare-dispatch-intake";
import {
  admitExecution,
  d1LeaseStore,
  d1PlacementStore,
  runD1Migrations,
  type D1Like,
} from "@fractalboxdev/mameko-host-cloudflare/d1";
import { LeaseStore, PlacementStore, ResultAcceptanceCheck } from "@fractalboxdev/mameko-ports";
import { type Context, Effect, Layer } from "effect";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolateServices } from "../../../apps/control-plane/src/composition.ts";
import type { ControlPlaneEnv } from "../../../apps/control-plane/src/config.ts";
import { invalidateLeaseNonce, leaseNonce } from "../../../apps/control-plane/src/lease.ts";
import {
  d1StatementRecords,
  jwkThumbprint,
  migrateStatementRecords,
} from "../../../apps/control-plane/src/provenance-records.ts";

const DAY = 24 * 3_600_000;
const sha = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const hex = (n: number) => n.toString(16).padStart(64, "0");
const CODE_HASH = sha(4);
const ARTIFACT = { name: "dist/app.tgz", digest: sha(10) };
const LEASED = "01JDZ8Q6V3M2K9T4WXYZ5LEASE";
const REGISTERED = "01JDZ8Q6V3M2K9T4WXYZ5REGIS";

let mf: Miniflare;
let databases = 0;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    compatibilityDate: "2026-05-01",
    d1Databases: Array.from({ length: 40 }, (_, i) => `DB${i}`),
  });
}, 60_000);
afterAll(() => mf?.dispose());

/** A P-256 device key: the private JWK keyed by its RFC 7638 thumbprint, and the SPKI the registry records. */
const deviceKey = async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const keyid = await jwkThumbprint(pub);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return {
    keyid,
    signing: parseProvenanceKey(JSON.stringify({ ...priv, kid: keyid }))!,
    publicKey: btoa(String.fromCharCode(...spki)),
  };
};
type DeviceKey = Awaited<ReturnType<typeof deviceKey>>;

const body = (lease: Partial<StatementBody["lease"]>): StatementBody => ({
  lease: {
    execution_id: LEASED,
    epoch: 1,
    nonce: "",
    executor_id: "mac-1",
    executor_kind: "device",
    binding_kind: "execution-lease",
    run: { name: "build-image", kind: "build", definition_digest: sha(1), inputs_digest: sha(2) },
    repository: "o/r",
    ref: "refs/heads/main",
    commit_sha: "a".repeat(40),
    image_digest: sha(3),
    class: "required",
    policy_version: "p-7",
    confidentiality: "unclassified",
    ...lease,
  },
  outcome: "success",
  commands: [{ name: "unit", exit_status: 0 }],
  lockfiles: [],
  fetches: [],
  locked_dependencies: [],
  restored_cache: [],
  egress_log_digest: sha(6),
  step_log_digest: sha(7),
  models: [],
});

/** The statement envelope the device executor submits, signed by `key` over DSSE's pre-authentication encoding. */
const signed = async (
  key: ProvenanceKey,
  statementBody: StatementBody,
  codeHash = CODE_HASH,
): Promise<DsseEnvelope> => {
  const statement = statementOf(
    statementBody,
    [{ name: ARTIFACT.name, digest: { sha256: hex(10) } }],
    { code_hash: codeHash },
  );
  const payload = new TextEncoder().encode(JSON.stringify(statement));
  return {
    ...unsignedEnvelope(payload),
    signatures: [await signPae(key, dssePae(DSSE_PAYLOAD_TYPE, payload))],
  };
};

const admission = (executionId: string, at: number) =>
  ({
    executionId,
    scopeId: "o/r",
    run: "build-image",
    className: "required",
    enqueuedAtMs: at,
    dedup: {
      sha256: `k-${executionId}`,
      canonical: executionId,
      requestDigest: null,
      onMismatch: "duplicate",
    },
    bounds: { global: 100, perScope: 100 },
    terminalOutcome: "failure",
  }) as const;

const registration = (over: Partial<RegistrationRecord>): RegistrationRecord => ({
  executionId: REGISTERED,
  scopeId: "o/r",
  executorId: "mac-1",
  leaseId: "L1",
  epoch: 3,
  run: "check",
  reuseKey: "rk",
  repository: "o/r",
  treeHash: "t".repeat(40),
  baseCommit: "a".repeat(40),
  runDigest: sha(1),
  imageDigest: sha(3),
  platform: "darwin-arm64",
  inputsDigest: sha(2),
  environmentNames: [],
  wantsReuse: true,
  wantsWriteback: false,
  nonce: "",
  registeredAt: Date.now(),
  startedAt: null,
  outcome: null,
  statementId: null,
  statementAccepted: false,
  ...over,
});

interface WorldOptions {
  /** The overlay's `attestation_max_age` in days; unset leaves the 10-day default. */
  readonly attestationMaxAgeDays?: number;
  /** How long ago mac-1 last attested. */
  readonly attestedAgo?: number;
}

/**
 * A fresh control-plane database: devices mac-1 and mac-2 registered, `LEASED` admitted and leased to mac-1 at epoch
 * 1 with its nonce, and `REGISTERED` admitted and registered by mac-1 under capacity-lease epoch 3 with its nonce; and
 * the result-acceptance check the composition binds over it.
 */
const world = async (options: WorldOptions = {}) => {
  const db = (await mf.getD1Database(`DB${databases++}`)) as unknown as D1Like;
  await runD1Migrations(db);
  await Effect.runPromise(migrateIntake(db));
  await migrateStatementRecords(db);
  const now = Date.now();
  const mac1 = await deviceKey();
  const mac2 = await deviceKey();
  const register = (executorId: string, key: DeviceKey, attestedAt: number) =>
    LeaseStore.use((s) =>
      s.register({
        executorId,
        kind: "device",
        postureTier: "managed-workstation",
        labels: [],
        slots: { total: 2 },
        keyStore: "secure-enclave",
        protocolVersion: "1",
        devicePublicKey: key.publicKey,
        attestedAt,
        codeHash: CODE_HASH,
      }),
    );
  const nonces = await Effect.runPromise(
    Effect.gen(function* () {
      yield* register("mac-1", mac1, now - (options.attestedAgo ?? 3_600_000));
      yield* register("mac-2", mac2, now - 3_600_000);
      yield* admitExecution(db, admission(LEASED, now));
      const placed = yield* PlacementStore.use((p) =>
        p.claim(LEASED, { expectedEpoch: 1, executorId: "mac-1", floor: 0 }),
      );
      expect(placed?.epoch).toBe(1);
      const leased = yield* leaseNonce(db, LEASED, 1, now);
      yield* admitExecution(db, admission(REGISTERED, now + 1));
      const registered = "0123456789abcdef0123456789abcdef";
      yield* LocalStore.use((s) => s.insert(registration({ nonce: registered }))).pipe(
        Effect.provide(localStoreD1(db)),
      );
      return { leased, registered };
    }).pipe(Effect.orDie, Effect.provide(Layer.merge(d1LeaseStore(db), d1PlacementStore(db)))),
  );
  const env = {
    PLANE_ID: "flare-dispatch",
    DEPLOYMENT: "production",
    DB: db,
    ...(options.attestationMaxAgeDays === undefined
      ? {}
      : { ATTESTATION_MAX_AGE_DAYS: options.attestationMaxAgeDays }),
  } as unknown as ControlPlaneEnv;
  const services = (await isolateServices(env)) as Context.Context<ResultAcceptanceCheck>;
  const check = (result: unknown, statement: unknown) =>
    Effect.runPromise(
      ResultAcceptanceCheck.use((port) => port.check(result, statement)).pipe(
        Effect.provide(services),
      ),
    );
  const sql = (query: string, ...values: unknown[]) =>
    (db as unknown as D1Database)
      .prepare(query)
      .bind(...values)
      .run();
  const quarantined = async (executorId: string) =>
    (
      await (db as unknown as D1Database)
        .prepare("select quarantine from executors where executor_id = ?")
        .bind(executorId)
        .first<{ quarantine: number }>()
    )?.quarantine === 1;
  /** mac-1's statement for its lease of `LEASED` at epoch 1, as submitted with its result. */
  const leaseStatement = (lease: Partial<StatementBody["lease"]> = {}) =>
    signed(mac1.signing, body({ nonce: nonces.leased, ...lease }));
  /** mac-1's statement for its registration of `REGISTERED` at capacity-lease epoch 3. */
  const registrationStatement = (lease: Partial<StatementBody["lease"]> = {}) =>
    signed(
      mac1.signing,
      body({
        execution_id: REGISTERED,
        epoch: 3,
        nonce: nonces.registered,
        binding_kind: "registration",
        ...lease,
      }),
    );
  return {
    db,
    now,
    mac1,
    mac2,
    nonces,
    check,
    sql,
    quarantined,
    leaseStatement,
    registrationStatement,
  };
};

const submission = (over: Record<string, unknown> = {}) => ({
  execution_id: LEASED,
  epoch: 1,
  executor_id: "mac-1",
  artifacts: [ARTIFACT],
  ...over,
});

const rejected = (reason: string) => ({ _tag: "rejected", reasonKind: `provenance: ${reason}` });
const passesChecks1To11 = { _tag: "rejected", reasonKind: METERING_UNAVAILABLE };

describe("the result-acceptance check over the control plane's D1 statement records", () => {
  it("a lease's and a registration's statement each pass checks 1 to 11, and check 12 fails closed", async () => {
    const w = await world();
    expect(await w.check(submission(), await w.leaseStatement())).toEqual(passesChecks1To11);
    expect(
      await w.check(
        submission({ execution_id: REGISTERED, epoch: 3 }),
        await w.registrationStatement(),
      ),
    ).toEqual(passesChecks1To11);
    expect(await w.quarantined("mac-1")).toBe(false);
  }, 60_000);

  it("[FD-PROV-013] rejects a statement whose device signature does not verify over its payload with bad-signature", async () => {
    const w = await world();
    const statement = await w.leaseStatement();
    // mac-1's own key, over another payload: the signature names a registered key and does not verify.
    const other = await w.leaseStatement({ epoch: 2 });
    expect(await w.check(submission(), { ...statement, signatures: other.signatures })).toEqual(
      rejected("bad-signature"),
    );
    // A second signature beside the device's.
    expect(
      await w.check(submission(), {
        ...statement,
        signatures: [...statement.signatures, ...other.signatures],
      }),
    ).toEqual(rejected("bad-signature"));
    expect(await w.quarantined("mac-1")).toBe(true);
  }, 60_000);

  it("[FD-PROV-014] rejects a statement whose signing key is not in the device registry with unknown-key", async () => {
    const w = await world();
    const stray = await deviceKey();
    const statement = await signed(stray.signing, body({ nonce: w.nonces.leased }));
    expect(await w.check(submission(), statement)).toEqual(rejected("unknown-key"));
    // A keyid that is not the thumbprint of the registered key names no registry entry, even over mac-1's key.
    const renamed = await w.leaseStatement();
    expect(
      await w.check(submission(), {
        ...renamed,
        signatures: renamed.signatures.map((s) => ({ ...s, keyid: `${s.keyid}x` })),
      }),
    ).toEqual(rejected("unknown-key"));
    expect(await w.quarantined("mac-1")).toBe(false);
  }, 60_000);

  it("[FD-PROV-015] rejects a statement whose signing key is revoked with revoked-key", async () => {
    const w = await world();
    // mameko records `revoked_at` on the executor row and has no revocation writer yet.
    await w.sql("update executors set revoked_at = ? where executor_id = 'mac-1'", w.now - 1);
    expect(await w.check(submission(), await w.leaseStatement())).toEqual(rejected("revoked-key"));
    expect(await w.quarantined("mac-1")).toBe(true);
  }, 60_000);

  it("[FD-PROV-016] rejects a statement from a device whose last attestation is older than the overlay's attestation_max_age with attestation-expired", async () => {
    // Attested 3 days ago: inside the 10-day default, outside an overlay's 2 days.
    const defaults = await world({ attestedAgo: 3 * DAY });
    expect(await defaults.check(submission(), await defaults.leaseStatement())).toEqual(
      passesChecks1To11,
    );
    const overlay = await world({ attestedAgo: 3 * DAY, attestationMaxAgeDays: 2 });
    expect(await overlay.check(submission(), await overlay.leaseStatement())).toEqual(
      rejected("attestation-expired"),
    );
    const stale = await world({ attestedAgo: 10 * DAY + 60_000 });
    expect(await stale.check(submission(), await stale.leaseStatement())).toEqual(
      rejected("attestation-expired"),
    );
  }, 60_000);

  it("[FD-PROV-017] rejects a statement whose execution_id names no lease or registration the control plane issued with unissued-lease", async () => {
    const w = await world();
    const unknown = "01JDZ8Q6V3M2K9T4WXYZ5NONE0";
    expect(
      await w.check(
        submission({ execution_id: unknown }),
        await w.leaseStatement({ execution_id: unknown }),
      ),
    ).toEqual(rejected("unissued-lease"));
    // An epoch at which no lease of `LEASED` was issued.
    expect(await w.check(submission(), await w.leaseStatement({ epoch: 2 }))).toEqual(
      rejected("unissued-lease"),
    );
    // A registration's statement at a capacity-lease epoch other than the one it registered under.
    expect(
      await w.check(
        submission({ execution_id: REGISTERED, epoch: 4 }),
        await w.registrationStatement({ epoch: 4 }),
      ),
    ).toEqual(rejected("unissued-lease"));
  }, 60_000);

  it("[FD-PROV-018] rejects a statement whose lease or registration was issued to an executor other than the signing device's with wrong-executor", async () => {
    const w = await world();
    // mac-2's key signs for the lease and the registration issued to mac-1.
    const lease = await signed(
      w.mac2.signing,
      body({ nonce: w.nonces.leased, executor_id: "mac-2" }),
    );
    expect(await w.check(submission({ executor_id: "mac-2" }), lease)).toEqual(
      rejected("wrong-executor"),
    );
    const registered = await signed(
      w.mac2.signing,
      body({
        execution_id: REGISTERED,
        epoch: 3,
        nonce: w.nonces.registered,
        binding_kind: "registration",
        executor_id: "mac-2",
      }),
    );
    expect(
      await w.check(
        submission({ execution_id: REGISTERED, epoch: 3, executor_id: "mac-2" }),
        registered,
      ),
    ).toEqual(rejected("wrong-executor"));
    expect(await w.quarantined("mac-2")).toBe(true);
    expect(await w.quarantined("mac-1")).toBe(false);
  }, 60_000);

  it("[FD-PROV-020] rejects a statement whose nonce differs from the nonce issued for its execution and epoch with nonce-mismatch", async () => {
    const w = await world();
    expect(await w.check(submission(), await w.leaseStatement({ nonce: "f".repeat(32) }))).toEqual(
      rejected("nonce-mismatch"),
    );
    // The registration's nonce on the lease's statement, and the lease's on the registration's.
    expect(
      await w.check(submission(), await w.leaseStatement({ nonce: w.nonces.registered })),
    ).toEqual(rejected("nonce-mismatch"));
    expect(
      await w.check(
        submission({ execution_id: REGISTERED, epoch: 3 }),
        await w.registrationStatement({ nonce: w.nonces.leased }),
      ),
    ).toEqual(rejected("nonce-mismatch"));
    // A nonce the control plane invalidated binds no statement.
    await Effect.runPromise(invalidateLeaseNonce(w.db, LEASED, 1, w.now));
    expect(await w.check(submission(), await w.leaseStatement())).toEqual(
      rejected("nonce-mismatch"),
    );
  }, 60_000);

  it("[FD-PROV-021] rejects a statement whose nonce an accepted statement consumed with nonce-reused", async () => {
    const w = await world();
    const statement = await w.leaseStatement();
    expect(await w.check(submission(), statement)).toEqual(passesChecks1To11);
    // The consumption the accept path records, through the same records the bound check reads.
    const consumed = await Effect.runPromise(
      StatementRecords.use((r) => r.consumeNonce(w.nonces.leased, LEASED, 1)).pipe(
        Effect.provide(d1StatementRecords(w.db)),
      ),
    );
    expect(consumed).toBe(true);
    expect(await w.check(submission(), statement)).toEqual(rejected("nonce-reused"));
    // A nonce is consumed once: a second consumption loses.
    const again = await Effect.runPromise(
      StatementRecords.use((r) => r.consumeNonce(w.nonces.leased, LEASED, 1)).pipe(
        Effect.provide(d1StatementRecords(w.db)),
      ),
    );
    expect(again).toBe(false);
  }, 60_000);

  it("[FD-PROV-022] rejects a statement whose subject digests differ from the result submission's artifact digests with digest-mismatch", async () => {
    const w = await world();
    const statement = await w.leaseStatement();
    expect(
      await w.check(
        submission({ artifacts: [{ name: ARTIFACT.name, digest: sha(11) }] }),
        statement,
      ),
    ).toEqual(rejected("digest-mismatch"));
    expect(
      await w.check(
        submission({ artifacts: [ARTIFACT, { name: "extra", digest: sha(12) }] }),
        statement,
      ),
    ).toEqual(rejected("digest-mismatch"));
    expect(await w.quarantined("mac-1")).toBe(false);
  }, 60_000);

  it("[FD-PROV-023] rejects a statement whose key helper code hash differs from the code hash recorded at the device's registration with code-hash-mismatch", async () => {
    const w = await world();
    const statement = await signed(w.mac1.signing, body({ nonce: w.nonces.leased }), sha(99));
    expect(await w.check(submission(), statement)).toEqual(rejected("code-hash-mismatch"));
    expect(await w.quarantined("mac-1")).toBe(true);
  }, 60_000);
});
