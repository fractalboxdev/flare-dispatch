// The control plane's step after the placement accepts a device executor's result (specs/provenance.md FD-PROV-032,
// FD-PROV-034): the device's own statement is countersigned with the active provenance key and its log-append intent
// recorded, once per execution and epoch, with the device key and the provenance key as the verifiers.
import {
  d1LogAppendStore,
  DSSE_PAYLOAD_TYPE,
  dssePae,
  LogAppendStore,
  parseProvenanceKey,
  RepositoryVisibility,
  signPae,
  unsignedEnvelope,
  type DsseEnvelope,
  type ProvenanceKey,
} from "@fractalboxdev/flare-dispatch-cache";
import { migrateIntake } from "@fractalboxdev/flare-dispatch-intake";
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
import { jwkThumbprint, migrateStatementRecords } from "../src/provenance-records.ts";
import { writeAcceptedDeviceStatement } from "../src/provenance.ts";

const EXECUTION = "01JDZ8Q6V3M2K9T4WXYZ5DEVCS";
const REPO = "acme/widgets";

let mf: Miniflare;
let databases = 0;
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    compatibilityDate: "2026-05-01",
    d1Databases: Array.from({ length: 8 }, (_, i) => `DB${i}`),
  });
}, 60_000);
afterAll(() => mf?.dispose());

/** A P-256 key: the private JWK keyed by its RFC 7638 thumbprint, its public JWK, and the SPKI the registry records. */
const p256 = async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const keyid = await jwkThumbprint(pub);
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  const json = JSON.stringify({ ...priv, kid: keyid });
  return {
    keyid,
    json,
    signing: parseProvenanceKey(json)!,
    spki: btoa(String.fromCharCode(...Array.from(spki))),
  };
};

const signed = async (key: ProvenanceKey): Promise<DsseEnvelope> => {
  const payload = new TextEncoder().encode(JSON.stringify({ _type: "statement", subject: [] }));
  return {
    ...unsignedEnvelope(payload),
    signatures: [await signPae(key, dssePae(DSSE_PAYLOAD_TYPE, payload))],
  };
};

/** A database with device mac-1 registered under `device`, and EXECUTION leased to it at epoch 1 and accepted. */
const world = async () => {
  const db = (await mf.getD1Database(`DB${databases++}`)) as unknown as D1Like;
  await runD1Migrations(db);
  await Effect.runPromise(migrateIntake(db));
  await migrateCache(db);
  await migrateStatementRecords(db);
  const device = await p256();
  const provenance = await p256();
  const now = Date.now();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* LeaseStore.use((s) =>
        s.register({
          executorId: "mac-1",
          kind: "device",
          postureTier: "managed-workstation",
          labels: [],
          slots: { total: 2 },
          keyStore: "secure-enclave",
          protocolVersion: "1",
          devicePublicKey: device.spki,
          attestedAt: now - 3_600_000,
          codeHash: null,
        }),
      );
      yield* admitExecution(db, {
        executionId: EXECUTION,
        scopeId: REPO,
        run: "build-image",
        className: "required",
        enqueuedAtMs: now,
        dedup: { sha256: "k", canonical: EXECUTION, requestDigest: null, onMismatch: "duplicate" },
        bounds: { global: 100, perScope: 100 },
        terminalOutcome: "failure",
      });
      yield* PlacementStore.use((p) =>
        p.claim(EXECUTION, { expectedEpoch: 1, executorId: "mac-1", floor: 0 }),
      );
      yield* PlacementStore.use((p) => p.accept(EXECUTION, { epoch: 1, executorId: "mac-1" }));
    }).pipe(Effect.orDie, Effect.provide(Layer.merge(d1LeaseStore(db), d1PlacementStore(db)))),
  );
  const env = {
    PLANE_ID: "flare-dispatch",
    DEPLOYMENT: "production",
    DB: db,
    PROVENANCE_KEY: provenance.json,
  } as unknown as ControlPlaneEnv;
  const write = (attestation: unknown, executorId = "mac-1") =>
    Effect.runPromise(
      writeAcceptedDeviceStatement(
        env,
        { executionId: EXECUTION, epoch: 1, executorId, attestation },
        now,
      ).pipe(
        Effect.provide(
          Layer.succeed(RepositoryVisibility, { of: () => Effect.succeed("private") }),
        ),
      ),
    );
  const intents = () =>
    Effect.runPromise(
      LogAppendStore.use((s) => s.forExecution(EXECUTION)).pipe(
        Effect.provideService(LogAppendStore, d1LogAppendStore(db as unknown as D1Database)),
      ),
    );
  return { device, provenance, write, intents };
};

describe("an accepted device statement", () => {
  it("[FD-PROV-032] [FD-PROV-034] is countersigned with the provenance key and queued for the log once, the device key and the provenance key its verifiers", async () => {
    const w = await world();
    const envelope = await signed(w.device.signing);
    const first = await w.write(envelope);
    expect(first).toMatchObject({ inserted: true });
    const [intent, ...others] = await w.intents();
    expect(others).toEqual([]);
    expect(intent!.repository).toBe(REPO);
    const logged = JSON.parse(intent!.envelope) as DsseEnvelope;
    // The device's signature stays first and the provenance key's countersignature follows it.
    expect(logged.signatures.map((s) => s.keyid)).toEqual([w.device.keyid, w.provenance.keyid]);
    expect(intent!.verifiers).toHaveLength(2);
    expect(intent!.envelopeDigest).toBe((first as { envelopeDigest: string }).envelopeDigest);
    // A second result of the same execution and epoch countersigns nothing more.
    expect(await w.write(envelope)).toEqual({
      envelopeDigest: intent!.envelopeDigest,
      inserted: false,
    });
    expect(await w.intents()).toHaveLength(1);
  });

  it("[FD-PROV-032] is not countersigned when no signature names the accepting device's registered key, or another executor sent it", async () => {
    const w = await world();
    const stranger = await p256();
    expect(await w.write(await signed(stranger.signing))).toEqual({
      skipped: "no signature names the device's registered key",
    });
    expect(await w.write(await signed(w.device.signing), "mac-2")).toEqual({
      skipped: "the placement did not accept this device's result at this epoch",
    });
    expect(await w.write(undefined)).toEqual({ skipped: "the result carries no statement" });
    expect(await w.intents()).toEqual([]);
  });
});
