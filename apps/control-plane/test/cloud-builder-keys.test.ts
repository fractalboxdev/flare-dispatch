// The cloud builder's provenance key against the control plane's key history (specs/provenance.md § Verification
// policy): every signature records the key's use, so the history holds each key from the instant it first signed, a
// rotated secret retires the earlier key at the new key's first signature, and a key whose window has closed signs
// nothing. Each world is written by the paths that write it in production: mameko's executor registry and admission
// and placement stores, intake's record and the control plane's lease nonce.
import {
  d1LogAppendStore,
  type Bucket,
  RepositoryVisibility,
} from "@fractalboxdev/flare-dispatch-cache";
import { d1KeyHistoryStore } from "@fractalboxdev/flare-dispatch-cache/provenance-policy";
import {
  d1IntakeStore,
  IntakeStore,
  migrateIntake,
  type IntakeRecord,
} from "@fractalboxdev/flare-dispatch-intake";
import {
  admitExecution,
  d1LeaseStore,
  d1PlacementStore,
  runD1Migrations,
  type D1Like,
} from "@fractalboxdev/mameko-host-cloudflare/d1";
import { LeaseStore, PlacementStore } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateCache } from "../src/cache-retention.ts";
import type { ControlPlaneEnv } from "../src/config.ts";
import { leaseNonce } from "../src/lease.ts";
import { writeAcceptedCloudStatement } from "../src/provenance.ts";

const sha = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const REPO = "acme/widgets";
const COMMIT = "c".repeat(40);

let mf: Miniflare;
let databases = 0;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    compatibilityDate: "2026-05-01",
    d1Databases: Array.from({ length: 4 }, (_, i) => `DB${i}`),
  });
}, 60_000);
afterAll(() => mf?.dispose());

/** An ES256 provenance key: the `PROVENANCE_KEY` secret and the public JWK the key history records. */
const provenanceKey = async (kid: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    secret: JSON.stringify({ ...priv, kid }),
    jwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y },
  };
};

const intakeRecord = (executionId: string): IntakeRecord => ({
  executionId,
  trigger: "dispatch",
  run: "check",
  label: null,
  repo: REPO,
  sha: COMMIT,
  ref: "refs/heads/main",
  inputs: { repo: `https://github.com/${REPO}.git`, sha: COMMIT, ref: "refs/heads/main", steps: [] },
  className: "required",
  labels: [],
  attempt: 1,
  familyRoot: executionId,
  installation: null,
  caller: null,
  notBefore: null,
  spendLine: null,
  placementConstraint: null,
  cacheTrigger: { _tag: "Other" },
  eligibleKinds: ["cloudflare"],
  repositoryPublic: null,
  inputAssociations: [],
  createdAt: 0,
});

/** The attestation the cloud executor attaches to its `exec.result`: the lease it was granted and the run's evidence. */
const attestation = (executionId: string, nonce: string) => ({
  lease: {
    execution_id: executionId,
    epoch: 1,
    nonce,
    executor_id: "cf-1",
    executor_kind: "cloudflare",
    run: { name: "check", kind: "gate", definition_digest: sha(1), inputs_digest: sha(2) },
    repository: REPO,
    ref: "refs/heads/main",
    commit_sha: COMMIT,
    image_digest: sha(3),
    class: "required",
    policy_version: "p-7",
    confidentiality: "unclassified",
  },
  outcome: "success",
  commands: [{ name: "check", exit_status: 0 }],
  lockfiles: [],
  fetches: [],
  locked_dependencies: [],
  restored_cache: [],
  egress_log_digest: sha(6),
  step_log_digest: sha(7),
  models: [],
});

/**
 * A fresh control-plane database with cloud executor cf-1 registered, and the cloud builder's write of an accepted
 * result of `executionId` from cf-1 at epoch 1, signed with the provenance key `secret` at `now`.
 */
const world = async () => {
  const db = (await mf.getD1Database(`DB${databases++}`)) as unknown as D1Like;
  await runD1Migrations(db);
  await Effect.runPromise(migrateIntake(db));
  await migrateCache(db);
  const stores = Layer.merge(d1LeaseStore(db), d1PlacementStore(db));
  const run = <A>(effect: Effect.Effect<A, unknown, LeaseStore | PlacementStore>) =>
    Effect.runPromise(effect.pipe(Effect.orDie, Effect.provide(stores)));
  await run(
    LeaseStore.use((s) =>
      s.register({
        executorId: "cf-1",
        kind: "cloudflare",
        postureTier: "attested-dedicated",
        labels: [],
        slots: { total: 4 },
        keyStore: null,
        protocolVersion: "1",
        devicePublicKey: null,
        attestedAt: null,
        codeHash: null,
      }),
    ),
  );
  const visibility = Layer.succeed(RepositoryVisibility, { of: () => Effect.succeed("private") });

  /** Admits, records and leases `executionId` to cf-1 at epoch 1, and accepts its result as mameko's channel does. */
  const accepted = async (executionId: string) => {
    const now = Date.now();
    await run(
      Effect.gen(function* () {
        yield* admitExecution(db, {
          executionId,
          scopeId: REPO,
          run: "check",
          className: "required",
          enqueuedAtMs: now,
          dedup: {
            sha256: `k-${executionId}`,
            canonical: executionId,
            requestDigest: null,
            onMismatch: "duplicate",
          },
          bounds: { global: 100, perScope: 100 },
          terminalOutcome: "failure",
        });
        yield* IntakeStore.use((s) => s.put(intakeRecord(executionId))).pipe(
          Effect.provide(d1IntakeStore(db)),
        );
        yield* PlacementStore.use((p) =>
          p.claim(executionId, { expectedEpoch: 1, executorId: "cf-1", floor: 0 }),
        );
      }),
    );
    const nonce = await Effect.runPromise(leaseNonce(db, executionId, 1, now));
    await run(PlacementStore.use((p) => p.accept(executionId, { epoch: 1, executorId: "cf-1" })));
    return nonce;
  };

  /** The cloud builder's write for `executionId`, with the deploy's `PROVENANCE_KEY` set to `secret`, at `now`. */
  const sign = async (executionId: string, secret: string, now: number) => {
    const nonce = await accepted(executionId);
    const env = {
      PLANE_ID: "flare-dispatch",
      DEPLOYMENT: "production",
      DB: db,
      // The run stores no artifact, so the statement's one subject is the commit and the bucket is never read.
      CACHE: {} as Bucket,
      PROVENANCE_KEY: secret,
      GATE_IMAGE_DIGEST: sha(0xa11),
    } as unknown as ControlPlaneEnv;
    return Effect.runPromise(
      writeAcceptedCloudStatement(
        env,
        { executionId, epoch: 1, executorId: "cf-1", attestation: attestation(executionId, nonce) },
        now,
      ).pipe(Effect.provide(visibility), Effect.result),
    );
  };

  const history = () =>
    Effect.runPromise(
      d1KeyHistoryStore(db as unknown as D1Database)
        .entries("provenance")
        .pipe(Effect.orDie),
    );
  const intents = (executionId: string) =>
    Effect.runPromise(
      d1LogAppendStore(db as unknown as D1Database)
        .forExecution(executionId)
        .pipe(Effect.orDie),
    );
  return { sign, history, intents };
};

describe("the cloud builder's provenance key in the key history", () => {
  it("[FD-PROV-047] records the provenance key from the instant of its first signature, before any policy publish, and keeps the entry", async () => {
    const w = await world();
    const k1 = await provenanceKey("prov-1");
    const t1 = Date.now();
    expect(await w.history()).toEqual([]);

    const first = await w.sign("EXEC-1", k1.secret, t1);
    expect(first).toMatchObject({ _tag: "Success", success: { inserted: true } });
    // The statement is logged at or after t1, so a verifier finds its key valid at the statement's log time.
    expect(await w.history()).toEqual([{ kid: "prov-1", jwk: k1.jwk, not_before: t1 }]);
    expect(await w.intents("EXEC-1")).toHaveLength(1);

    // A later signature with the same key changes nothing in its entry.
    expect(await w.sign("EXEC-2", k1.secret, t1 + 60_000)).toMatchObject({ _tag: "Success" });
    expect(await w.history()).toEqual([{ kid: "prov-1", jwk: k1.jwk, not_before: t1 }]);
  }, 60_000);

  it("[FD-PROV-048] a rotated secret retires the earlier key at the new key's first signature, and the retired key signs nothing", async () => {
    const w = await world();
    const k1 = await provenanceKey("prov-1");
    const k2 = await provenanceKey("prov-2");
    const t1 = Date.now();
    expect(await w.sign("EXEC-1", k1.secret, t1)).toMatchObject({ _tag: "Success" });

    // The operator rolls the PROVENANCE_KEY secret: the next statement is the rotation instant.
    const t2 = t1 + 3_600_000;
    expect(await w.sign("EXEC-2", k2.secret, t2)).toMatchObject({ _tag: "Success" });
    expect(await w.history()).toEqual([
      { kid: "prov-1", jwk: k1.jwk, not_before: t1, not_after: t2 },
      { kid: "prov-2", jwk: k2.jwk, not_before: t2 },
    ]);

    // Rolled back to the retired key, the cloud builder refuses to sign and records no log append.
    const back = await w.sign("EXEC-3", k1.secret, t2 + 60_000);
    expect(back).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SigningKeyRetired", role: "provenance", kid: "prov-1", notAfter: t2 },
    });
    expect(await w.intents("EXEC-3")).toEqual([]);
    expect(await w.history()).toEqual([
      { kid: "prov-1", jwk: k1.jwk, not_before: t1, not_after: t2 },
      { kid: "prov-2", jwk: k2.jwk, not_before: t2 },
    ]);
  }, 60_000);
});
