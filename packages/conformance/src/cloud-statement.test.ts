// The cloud builder on the composed control plane under Miniflare (specs/provenance.md § Statement flow): a cloud
// executor's result accepted through mameko's accept compare-and-set gets a statement the control plane writes and
// signs with the provenance key, its subject digests read from the artifact bytes in R2, and a log-append intent the
// tick's drain appends to the private log. Each world is written by the paths that write it in production: mameko's
// executor registry and admission and placement stores, intake's record, the control plane's lease nonce, and the
// cache package's artifact upload and commit.
import {
  ArtifactDb,
  beginArtifactUpload,
  CacheBucket,
  CacheClock,
  CacheLeases,
  commitArtifact,
  d1LogAppendStore,
  fromBase64,
  LogAppendStatus,
  memoryLeases,
  R2PresignerLive,
  verifyDsseSignature,
  type Bucket,
  type DsseEnvelope,
  type LogAppendIntent,
} from "@fractalboxdev/flare-dispatch-cache";
import { GithubRead } from "@fractalboxdev/flare-dispatch-github";
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
import { type Context, Effect, Layer } from "effect";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolateServices } from "../../../apps/control-plane/src/composition.ts";
import { migrateCache } from "../../../apps/control-plane/src/cache-retention.ts";
import type { ControlPlaneEnv } from "../../../apps/control-plane/src/config.ts";
import { invalidateLeaseNonce, leaseNonce } from "../../../apps/control-plane/src/lease.ts";
import {
  cloudStatementOnFrame,
  cloudStatementOnResult,
  logAppendStep,
  repositoryVisibilityLayer,
  writeAcceptedCloudStatement,
} from "../../../apps/control-plane/src/provenance.ts";
import { migrateStatementRecords } from "../../../apps/control-plane/src/provenance-records.ts";

const sha = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const COMMIT = "c".repeat(40);
const REPO = "acme/widgets";
/** The gate image digest the deploy pins, which a cloud lease names. */
const GATE_IMAGE = sha(0xa11);
const ARTIFACTS: Readonly<Record<string, string>> = {
  "dist/app.tgz": "the built application",
  "sbom.json": '{"packages":[]}',
};

let mf: Miniflare;
let bucket: Bucket;
let databases = 0;
let provenance: { readonly secret: string; readonly kid: string; readonly public: JsonWebKey };

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    compatibilityDate: "2026-05-01",
    d1Databases: Array.from({ length: 12 }, (_, i) => `DB${i}`),
    r2Buckets: ["CACHE"],
  });
  bucket = (await mf.getR2Bucket("CACHE")) as unknown as Bucket;
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  provenance = {
    secret: JSON.stringify({ ...priv, kid: "prov-2026-11" }),
    kid: "prov-2026-11",
    public: (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey,
  };
}, 60_000);
afterAll(() => mf?.dispose());

const hexOf = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

const admission = (executionId: string, at: number) =>
  ({
    executionId,
    scopeId: REPO,
    run: "check",
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

const intakeRecord = (executionId: string): IntakeRecord => ({
  executionId,
  trigger: "dispatch",
  run: "check",
  label: null,
  repo: REPO,
  sha: COMMIT,
  ref: "refs/heads/main",
  inputs: {
    repo: `https://github.com/${REPO}.git`,
    sha: COMMIT,
    ref: "refs/heads/main",
    steps: [],
  },
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
  eligibleKinds: ["cloudflare", "device"],
  repositoryPublic: null,
  inputAssociations: [],
  createdAt: 0,
});

/** The attestation a cloud executor attaches to its `exec.result`: the lease it was granted and the run's evidence. */
const attestation = (lease: {
  readonly execution_id: string;
  readonly epoch: number;
  readonly nonce: string;
  readonly executor_id: string;
  readonly executor_kind?: string;
}) => ({
  lease: {
    executor_kind: "cloudflare",
    // `check` is a gate recipe: the control plane writes its run kind and the image digest, never these.
    run: { name: "check", kind: "build", definition_digest: sha(1), inputs_digest: sha(2) },
    // The control plane writes the repository, ref and commit from its own records, never these.
    repository: "mallory/elsewhere",
    ref: "refs/heads/forged",
    commit_sha: "f".repeat(40),
    image_digest: sha(3),
    class: "required",
    policy_version: "p-7",
    confidentiality: "unclassified",
    ...lease,
  },
  outcome: "success",
  commands: [{ name: "build", exit_status: 0 }],
  lockfiles: [],
  fetches: [],
  locked_dependencies: [],
  restored_cache: [],
  egress_log_digest: sha(6),
  step_log_digest: sha(7),
  models: [],
});

/**
 * A fresh control-plane database: cloud executors cf-1 and cf-2 and device mac-1 registered, and the composed
 * control plane's services over it with the provenance key and the `CACHE` bucket bound.
 */
const world = async () => {
  const db = (await mf.getD1Database(`DB${databases++}`)) as unknown as D1Like;
  await runD1Migrations(db);
  await Effect.runPromise(migrateIntake(db));
  await migrateStatementRecords(db);
  await migrateCache(db);
  const stores = Layer.merge(d1LeaseStore(db), d1PlacementStore(db));
  const run = <A>(effect: Effect.Effect<A, unknown, LeaseStore | PlacementStore>) =>
    Effect.runPromise(effect.pipe(Effect.orDie, Effect.provide(stores)));
  const register = (executorId: string, kind: string) =>
    LeaseStore.use((s) =>
      s.register({
        executorId,
        kind,
        postureTier: kind === "device" ? "managed-workstation" : "attested-dedicated",
        labels: [],
        slots: { total: 2 },
        keyStore: null,
        protocolVersion: "1",
        devicePublicKey: null,
        attestedAt: null,
        codeHash: null,
      }),
    );
  await run(
    Effect.all([
      register("cf-1", "cloudflare"),
      register("cf-2", "cloudflare"),
      register("mac-1", "device"),
    ]),
  );
  const env = {
    PLANE_ID: "flare-dispatch",
    DEPLOYMENT: "production",
    DB: db,
    CACHE: bucket,
    PROVENANCE_KEY: provenance.secret,
    GATE_IMAGE_DIGEST: GATE_IMAGE,
  } as unknown as ControlPlaneEnv;
  const services = (await isolateServices(env)) as Context.Context<GithubRead>;
  const visibility = repositoryVisibilityLayer.pipe(Layer.provide(Layer.succeedContext(services)));
  const logAppends = d1LogAppendStore(db as unknown as D1Database);

  /** Admits `executionId`, records intake's inputs and leases it to `executorId` at epoch 1 with its nonce. */
  const leased = async (executionId: string, executorId: string) => {
    const now = Date.now();
    await run(
      Effect.gen(function* () {
        yield* admitExecution(db, admission(executionId, now));
        yield* IntakeStore.use((s) => s.put(intakeRecord(executionId))).pipe(
          Effect.provide(d1IntakeStore(db)),
        );
        const placed = yield* PlacementStore.use((p) =>
          p.claim(executionId, { expectedEpoch: 1, executorId, floor: 0 }),
        );
        expect(placed?.epoch).toBe(1);
      }),
    );
    return Effect.runPromise(leaseNonce(db, executionId, 1, now));
  };

  /**
   * Uploads and commits each artifact through the cache package's artifact path at the execution's epoch. The digest
   * each upload declares is the executor's claim; the commit stores the bytes in R2 at `artifacts/<id>/<epoch>/<name>`.
   */
  const commitArtifacts = async (executionId: string, epoch: number, executorId: string) => {
    const lease = {
      executionId,
      repo: REPO,
      epoch,
      status: "active" as const,
      namespaces: { read: [], write: null },
      executorId,
      executorKind: "cloudflare" as const,
      class: "required",
      deadlineAt: Date.now() + 3_600_000,
    };
    const layers = Layer.mergeAll(
      Layer.succeed(CacheLeases, memoryLeases(new Map([[executionId, lease]]))),
      Layer.succeed(ArtifactDb, db as unknown as D1Database),
      Layer.succeed(CacheBucket, bucket),
      R2PresignerLive({
        accountId: "0123abcd",
        bucket: "cache",
        accessKeyId: "AK",
        secretAccessKey: "SK",
      }),
    ).pipe(Layer.provideMerge(Layer.succeed(CacheClock, { now: () => Date.now() })));
    for (const [name, text] of Object.entries(ARTIFACTS)) {
      const declared = "0".repeat(64);
      const bytes = new TextEncoder().encode(text);
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* beginArtifactUpload({
            execution_id: executionId,
            epoch,
            name,
            size: bytes.byteLength,
            sha256: declared,
            content_type: "application/octet-stream",
          });
          yield* Effect.promise(() =>
            bucket.put(`artifacts/${executionId}/${epoch}/${name}`, bytes),
          );
          const ack = yield* commitArtifact(
            { execution_id: executionId, epoch, name },
            { repo: REPO, private: true },
          );
          expect(ack.status).toBe("accepted");
        }).pipe(Effect.provide(layers)),
      );
    }
  };

  /** mameko's accept compare-and-set for a result at `epoch` from `executorId`, as the executor channel runs it. */
  const accept = (executionId: string, epoch: number, executorId: string) =>
    run(PlacementStore.use((p) => p.accept(executionId, { epoch, executorId })));

  /** The `exec.result` frame the executor sends, with its attestation as `statement`. */
  const frame = (executionId: string, epoch: number, statement: unknown) =>
    JSON.stringify({
      type: "exec.result",
      id: "r1",
      execution_id: executionId,
      epoch,
      result_id: "rid",
      outcome: { status: "success", reason: null },
      usage: {},
      artifacts: [],
      statement,
    });

  /** The channel's step after an `exec.result` from `executorId`. */
  const onResult = (text: string, executorId: string, now = Date.now()) =>
    Effect.runPromise(
      cloudStatementOnResult(env, text, executorId, now).pipe(Effect.provide(visibility)),
    );

  /** The cloud-builder write itself, with its refusal or failure. */
  const write = (
    accepted: { executionId: string; epoch: number; executorId: string; attestation: unknown },
    now = Date.now(),
  ) =>
    Effect.runPromise(
      writeAcceptedCloudStatement(env, accepted, now).pipe(Effect.provide(visibility), Effect.flip),
    );

  const intents = (executionId: string) =>
    Effect.runPromise(logAppends.forExecution(executionId).pipe(Effect.orDie));

  return {
    db,
    env,
    leased,
    commitArtifacts,
    accept,
    frame,
    onResult,
    write,
    intents,
    logAppends,
    run,
    visibility,
    register: (executorId: string, kind: string) => run(register(executorId, kind)),
  };
};

const envelopeOf = (intent: LogAppendIntent) => JSON.parse(intent.envelope) as DsseEnvelope;
const payloadOf = (envelope: DsseEnvelope) =>
  JSON.parse(new TextDecoder().decode(fromBase64(envelope.payload))) as {
    subject: { name: string; digest: Record<string, string> }[];
    predicateType: string;
    predicate: {
      result: string;
      configuration: {
        name: string;
        uri?: string;
        digest?: Record<string, string>;
        annotations?: Record<string, unknown>;
      }[];
    };
  };
const configurationOf = (envelope: DsseEnvelope, name: string) =>
  payloadOf(envelope).predicate.configuration.find((d) => d.name === name);

describe("the cloud builder's statement of an accepted cloud execution", () => {
  it("[FD-PROV-008] writes the statement with subject digests from the artifact bytes in R2, signs it with the provenance key as the cloud builder and logs it", async () => {
    const w = await world();
    const nonce = await w.leased("EXEC-CLOUD", "cf-1");
    await w.commitArtifacts("EXEC-CLOUD", 1, "cf-1");
    expect(await w.accept("EXEC-CLOUD", 1, "cf-1")).not.toBeNull();
    const submitted = attestation({
      execution_id: "EXEC-CLOUD",
      epoch: 1,
      nonce,
      executor_id: "cf-1",
    });

    await w.onResult(w.frame("EXEC-CLOUD", 1, submitted), "cf-1");

    const [intent, ...more] = await w.intents("EXEC-CLOUD");
    expect(more).toEqual([]);
    // No App: the repository's visibility cannot be read, so the statement goes to the private log.
    expect(intent!.log).toBe("private");
    expect(intent!.verifiers).toEqual([expect.objectContaining({ kid: provenance.kid })]);
    const envelope = envelopeOf(intent!);
    // Signed once, by the provenance key: no device signature, so a verifier reads it as a cloud builder.
    expect(envelope.signatures.map((s) => s.keyid)).toEqual([provenance.kid]);
    expect(await verifyDsseSignature(provenance.public, envelope, envelope.signatures[0]!)).toBe(
      true,
    );
    const statement = payloadOf(envelope);
    // Each subject digest is the SHA-256 of the bytes R2 holds, not the digest the upload declared.
    expect(statement.subject).toEqual([
      { name: "dist/app.tgz", digest: { sha256: await hexOf(ARTIFACTS["dist/app.tgz"]!) } },
      { name: "sbom.json", digest: { sha256: await hexOf(ARTIFACTS["sbom.json"]!) } },
    ]);
    // `check` is a gate recipe, so its statement is a test result whatever run kind the attestation names.
    expect(statement.predicateType).toBe("https://in-toto.io/attestation/test-result/v0.1");
    expect(statement.predicate.result).toBe("PASSED");
    expect(configurationOf(envelope, "lease")?.annotations).toEqual({
      execution_id: "EXEC-CLOUD",
      epoch: 1,
      nonce,
      executor_id: "cf-1",
      binding_kind: "execution-lease",
    });
    // The repository, ref and commit are the ones intake recorded, not the attestation's.
    expect(configurationOf(envelope, "commit")).toEqual({
      name: "commit",
      uri: `git+https://github.com/${REPO}@refs/heads/main`,
      digest: { gitCommit: COMMIT },
    });
    // The image is the gate image the lease named for a cloud executor, not the digest the attestation forged.
    expect(configurationOf(envelope, "image")?.digest).toEqual({ sha256: GATE_IMAGE.slice(7) });

    // A repeated result for the same epoch signs nothing more.
    await w.onResult(w.frame("EXEC-CLOUD", 1, submitted), "cf-1");
    expect((await w.intents("EXEC-CLOUD")).map((i) => i.envelopeDigest)).toEqual([
      intent!.envelopeDigest,
    ]);

    // The tick's drain: with no TRANSPARENCY_LOG object the append fails and the intent stays pending for a retry.
    const now = Date.now();
    await Effect.runPromise(logAppendStep(w.env, now).effect.pipe(Effect.orDie));
    const pending = await Effect.runPromise(
      w.logAppends.get(intent!.envelopeDigest).pipe(Effect.orDie),
    );
    expect(LogAppendStatus.$is("Pending")(pending!.status)).toBe(true);
    // Bound, the private log takes the envelope's bytes on the next due drain, and the intent records its entry.
    const appended: string[] = [];
    const logged = {
      ...w.env,
      TRANSPARENCY_LOG: {
        idFromName: (name: string) => name,
        get: () => ({
          append: async (entry: Uint8Array) => {
            appended.push(new TextDecoder().decode(entry));
            return {
              _tag: "Appended" as const,
              index: 0,
              leafHash: "leaf-0",
              integratedAt: now + 5_000,
              duplicate: false,
            };
          },
          inclusionProof: async () => null,
        }),
      },
    } as unknown as ControlPlaneEnv;
    await Effect.runPromise(logAppendStep(logged, now + 5_000).effect.pipe(Effect.orDie));
    expect(appended).toEqual([intent!.envelope]);
    const done = await Effect.runPromise(
      w.logAppends.get(intent!.envelopeDigest).pipe(Effect.orDie),
    );
    expect(LogAppendStatus.$is("Logged")(done!.status)).toBe(true);
  });

  it("[FD-PROV-008] signs once when the same result arrives twice concurrently", async () => {
    const w = await world();
    const nonce = await w.leased("EXEC-TWICE", "cf-1");
    await w.commitArtifacts("EXEC-TWICE", 1, "cf-1");
    expect(await w.accept("EXEC-TWICE", 1, "cf-1")).not.toBeNull();
    const submitted = attestation({
      execution_id: "EXEC-TWICE",
      epoch: 1,
      nonce,
      executor_id: "cf-1",
    });
    const accepted = {
      executionId: "EXEC-TWICE",
      epoch: 1,
      executorId: "cf-1",
      attestation: submitted,
    };
    const both = await Promise.all(
      [0, 1].map(() =>
        Effect.runPromise(
          writeAcceptedCloudStatement(w.env, accepted, Date.now()).pipe(
            Effect.provide(w.visibility),
          ),
        ),
      ),
    );
    expect(both.map((b) => b.inserted).sort()).toEqual([false, true]);
    const intents = await w.intents("EXEC-TWICE");
    expect(intents.map((i) => i.envelopeDigest)).toEqual([
      both.find((b) => b.inserted)!.envelopeDigest,
    ]);
  });

  it("[FD-PROV-008] releases the claim when the write fails, so a later result signs", async () => {
    const w = await world();
    const nonce = await w.leased("EXEC-RETRY", "cf-1");
    await w.commitArtifacts("EXEC-RETRY", 1, "cf-1");
    expect(await w.accept("EXEC-RETRY", 1, "cf-1")).not.toBeNull();
    const submitted = attestation({
      execution_id: "EXEC-RETRY",
      epoch: 1,
      nonce,
      executor_id: "cf-1",
    });
    // R2 loses an artifact the control plane stored: the statement cannot be written, and nothing is logged.
    const moved = await bucket.get("artifacts/EXEC-RETRY/1/sbom.json");
    const bytes = new Uint8Array(await moved!.arrayBuffer());
    await bucket.delete("artifacts/EXEC-RETRY/1/sbom.json");
    expect(
      await w.write({
        executionId: "EXEC-RETRY",
        epoch: 1,
        executorId: "cf-1",
        attestation: submitted,
      }),
    ).toMatchObject({ _tag: "CloudStatementFailed", reason: "artifact-missing" });
    expect(await w.intents("EXEC-RETRY")).toEqual([]);
    await bucket.put("artifacts/EXEC-RETRY/1/sbom.json", bytes);
    await w.onResult(w.frame("EXEC-RETRY", 1, submitted), "cf-1");
    expect(await w.intents("EXEC-RETRY")).toHaveLength(1);
  });

  it("[FD-PROV-008] the executor channel's frame step reads the executor from the socket and logs one statement", async () => {
    const w = await world();
    const nonce = await w.leased("EXEC-FRAME", "cf-1");
    await w.commitArtifacts("EXEC-FRAME", 1, "cf-1");
    expect(await w.accept("EXEC-FRAME", 1, "cf-1")).not.toBeNull();
    const socket = (executorId: string) => ({ deserializeAttachment: () => ({ executorId }) });
    const submitted = attestation({
      execution_id: "EXEC-FRAME",
      epoch: 1,
      nonce,
      executor_id: "cf-1",
    });
    // A frame of another type writes nothing, and so does the result arriving on another executor's socket.
    await cloudStatementOnFrame(w.env, socket("cf-1"), '{"type":"exec.progress"}', Date.now());
    await cloudStatementOnFrame(
      w.env,
      socket("cf-2"),
      w.frame("EXEC-FRAME", 1, submitted),
      Date.now(),
    );
    expect(await w.intents("EXEC-FRAME")).toEqual([]);
    await cloudStatementOnFrame(
      w.env,
      socket("cf-1"),
      new TextEncoder().encode(w.frame("EXEC-FRAME", 1, submitted)).buffer as ArrayBuffer,
      Date.now(),
    );
    expect(await w.intents("EXEC-FRAME")).toHaveLength(1);
  });

  it("[FD-PROV-008] signs nothing when the deploy holds no provenance key", async () => {
    const w = await world();
    const nonce = await w.leased("EXEC-NOKEY", "cf-1");
    expect(await w.accept("EXEC-NOKEY", 1, "cf-1")).not.toBeNull();
    const env = { ...w.env, PROVENANCE_KEY: undefined } as unknown as ControlPlaneEnv;
    const services = (await isolateServices(env)) as Context.Context<GithubRead>;
    const refused = await Effect.runPromise(
      writeAcceptedCloudStatement(
        env,
        {
          executionId: "EXEC-NOKEY",
          epoch: 1,
          executorId: "cf-1",
          attestation: attestation({
            execution_id: "EXEC-NOKEY",
            epoch: 1,
            nonce,
            executor_id: "cf-1",
          }),
        },
        Date.now(),
      ).pipe(
        Effect.provide(
          repositoryVisibilityLayer.pipe(Layer.provide(Layer.succeedContext(services))),
        ),
        Effect.flip,
      ),
    );
    expect(refused).toMatchObject({ _tag: "CloudBuilderUnconfigured", missing: "PROVENANCE_KEY" });
    expect(await w.intents("EXEC-NOKEY")).toEqual([]);
  });
});

describe("the cloud builder signs only for the current cloud placement at its epoch", () => {
  it("[FD-PROV-009] refuses a result whose placement is a device executor", async () => {
    const w = await world();
    const nonce = await w.leased("EXEC-DEVICE", "mac-1");
    expect(await w.accept("EXEC-DEVICE", 1, "mac-1")).not.toBeNull();
    const submitted = attestation({
      execution_id: "EXEC-DEVICE",
      epoch: 1,
      nonce,
      executor_id: "mac-1",
      executor_kind: "device",
    });
    expect(
      await w.write({
        executionId: "EXEC-DEVICE",
        epoch: 1,
        executorId: "mac-1",
        attestation: submitted,
      }),
    ).toMatchObject({ _tag: "CloudBuilderRefused", reason: "device-executor" });
    // Through the channel's step too: the device signs its own statement, and the control plane signs none.
    await w.onResult(w.frame("EXEC-DEVICE", 1, submitted), "mac-1");
    expect(await w.intents("EXEC-DEVICE")).toEqual([]);
  });

  it("[FD-PROV-009] refuses a device-leased result after the executor id re-registers as a cloud executor", async () => {
    const w = await world();
    const nonce = await w.leased("EXEC-REKIND", "mac-1");
    await w.register("mac-1", "cloudflare");
    expect(await w.accept("EXEC-REKIND", 1, "mac-1")).not.toBeNull();
    const submitted = attestation({
      execution_id: "EXEC-REKIND",
      epoch: 1,
      nonce,
      executor_id: "mac-1",
    });
    expect(
      await w.write({
        executionId: "EXEC-REKIND",
        epoch: 1,
        executorId: "mac-1",
        attestation: submitted,
      }),
    ).toMatchObject({ _tag: "CloudBuilderRefused", reason: "device-executor" });
    expect(await w.intents("EXEC-REKIND")).toEqual([]);
  });

  it("[FD-PROV-009] refuses a result from a stale epoch after a reclaim, and signs for the current epoch's executor", async () => {
    const w = await world();
    const first = await w.leased("EXEC-STALE", "cf-1");
    // The lease is reclaimed: its nonce is invalidated, and cf-2 claims the placement at epoch 2.
    const now = Date.now();
    await Effect.runPromise(invalidateLeaseNonce(w.db, "EXEC-STALE", 1, now));
    await w.run(
      PlacementStore.use((p) =>
        p.reclaim("EXEC-STALE", { expectedEpoch: 1, floor: 0, reason: "expiry" }),
      ),
    );
    await w.run(
      PlacementStore.use((p) =>
        p.claim("EXEC-STALE", { expectedEpoch: 2, executorId: "cf-2", floor: 0 }),
      ),
    );
    const second = await Effect.runPromise(leaseNonce(w.db, "EXEC-STALE", 2, now));
    await w.commitArtifacts("EXEC-STALE", 2, "cf-2");
    expect(await w.accept("EXEC-STALE", 2, "cf-2")).not.toBeNull();

    const stale = attestation({
      execution_id: "EXEC-STALE",
      epoch: 1,
      nonce: first,
      executor_id: "cf-1",
    });
    expect(
      await w.write({
        executionId: "EXEC-STALE",
        epoch: 1,
        executorId: "cf-1",
        attestation: stale,
      }),
    ).toMatchObject({ _tag: "CloudBuilderRefused", reason: "stale-epoch" });
    // The previous executor naming the current epoch is not the executor the placement accepted the result from.
    const borrowed = attestation({
      execution_id: "EXEC-STALE",
      epoch: 2,
      nonce: second,
      executor_id: "cf-1",
    });
    expect(
      await w.write({
        executionId: "EXEC-STALE",
        epoch: 2,
        executorId: "cf-1",
        attestation: borrowed,
      }),
    ).toMatchObject({ _tag: "CloudBuilderRefused", reason: "other-executor" });
    // An attestation bound to the reclaimed epoch's nonce does not bind the current lease.
    const replayed = attestation({
      execution_id: "EXEC-STALE",
      epoch: 2,
      nonce: first,
      executor_id: "cf-2",
    });
    expect(
      await w.write({
        executionId: "EXEC-STALE",
        epoch: 2,
        executorId: "cf-2",
        attestation: replayed,
      }),
    ).toMatchObject({ _tag: "CloudBuilderRefused", reason: "binding-mismatch" });
    expect(await w.intents("EXEC-STALE")).toEqual([]);

    const current = attestation({
      execution_id: "EXEC-STALE",
      epoch: 2,
      nonce: second,
      executor_id: "cf-2",
    });
    await w.onResult(w.frame("EXEC-STALE", 2, current), "cf-2");
    const [intent] = await w.intents("EXEC-STALE");
    expect(configurationOf(envelopeOf(intent!), "lease")?.annotations).toMatchObject({
      epoch: 2,
      nonce: second,
      executor_id: "cf-2",
    });
  });

  it("[FD-PROV-009] refuses a result the placement has not accepted", async () => {
    const w = await world();
    const nonce = await w.leased("EXEC-LEASED", "cf-1");
    const submitted = attestation({
      execution_id: "EXEC-LEASED",
      epoch: 1,
      nonce,
      executor_id: "cf-1",
    });
    expect(
      await w.write({
        executionId: "EXEC-LEASED",
        epoch: 1,
        executorId: "cf-1",
        attestation: submitted,
      }),
    ).toMatchObject({ _tag: "CloudBuilderRefused", reason: "not-accepted" });
    expect(await w.intents("EXEC-LEASED")).toEqual([]);
  });
});
