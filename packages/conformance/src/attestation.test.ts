// FlareDispatch's attestation verifier inside device enrollment: the API's registry over mameko's `registerDevice` and
// host-cloudflare's runtime Layer on D1 under workerd, with the `production` profile from phase 1, whose registration
// admits only `secure-enclave` keys the verifier accepts. The verifier's root is injected: a test attestation root
// stands in for the Apple Enterprise Attestation Root CA, which the deployed control plane binds.
import {
  appleAttestationVerifier,
  attestationVerifier,
} from "@fractalboxdev/flare-dispatch-api/attestation";
import {
  attestedEvidence,
  derBoolean,
  newDeviceKey,
  newRoot,
  newSubCa,
  pem,
  type Authority,
  type DeviceAttestation,
} from "@fractalboxdev/flare-dispatch-api/attestation-test-support";
import { DeviceRegistry } from "@fractalboxdev/flare-dispatch-api/ports";
import { d1DeviceRegistry } from "@fractalboxdev/flare-dispatch-api/registry";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { runD1Migrations, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Exit } from "effect";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mf: Miniflare;
let databases = 0;
let root: Authority;
let subCa: Authority;
/** A root and sub CA under the same names as the trusted ones, with keys of their own. */
let foreignRoot: Authority;
let foreignSubCa: Authority;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    compatibilityDate: "2026-05-01",
    d1Databases: Array.from({ length: 24 }, (_, i) => `DB${i}`),
  });
  root = await newRoot();
  subCa = await newSubCa(root);
  foreignRoot = await newRoot();
  foreignSubCa = await newSubCa(foreignRoot);
}, 60_000);
afterAll(() => mf?.dispose());

type Verify = (publicKey: string, evidence: unknown) => Effect.Effect<boolean>;

/**
 * Registers one `secure-enclave` key with `evidence` through the registry of a `production` deployment at phase 1
 * bound to `verify`, on a fresh D1 database; answers `registered` or the refusal reason, and the row it wrote.
 */
const enroll = async (verify: Verify, publicKey: string, evidence: unknown) => {
  const db = (await mf.getD1Database(`DB${databases++}`)) as unknown as D1Like;
  await runD1Migrations(db);
  let at = 0;
  const registry = d1DeviceRegistry({
    db,
    anchor: { read: async () => at, advance: async (e: number) => (at = Math.max(at, e)) },
    profile: buildProfile("production", 1),
    posture: () => Effect.succeed("unmanaged"),
    verify,
  });
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* (yield* DeviceRegistry).register({
        executor_id: "attested-device",
        identity: {
          public_key: publicKey,
          key_store: "secure-enclave",
          certificate_chain: [],
          evidence,
        },
        labels: [],
        protocol_version: "1",
        code_hash: null,
      });
    }).pipe(Effect.provide(registry)),
  );
  const row = await (db as unknown as D1Database)
    .prepare("select key_store, attested_at from executors where executor_id = ?")
    .bind("attested-device")
    .first<{ key_store: string; attested_at: number | null }>();
  const answer = Exit.isSuccess(exit)
    ? "registered"
    : (JSON.stringify(exit.cause).match(/registration refused: ([a-z-]+)/)?.[1] ?? "failed");
  return { answer, row };
};

const trusting = () => attestationVerifier({ roots: [pem(root.certificate)] });

describe("the attestation verifier in device enrollment", () => {
  it("[FD-PROV-028] admits a key whose Managed Device Attestation chains to the trusted root", async () => {
    const device = await newDeviceKey();
    const evidence = await attestedEvidence(root, subCa, device.keys.publicKey);
    const enrolled = await enroll(trusting(), device.publicKey, evidence);
    expect(enrolled.answer).toBe("registered");
    expect(enrolled.row).toEqual({ key_store: "secure-enclave", attested_at: expect.any(Number) });
  }, 60_000);

  it("[FD-PROV-028] refuses evidence that does not chain to the trusted root, with attestation and no row", async () => {
    const device = await newDeviceKey();
    const other = await newDeviceKey();
    const selfSigned = await newRoot("device attestation");
    const cases: readonly {
      readonly name: string;
      readonly publicKey: string;
      readonly evidence: unknown;
    }[] = [
      {
        name: "a chain to another root under the same names",
        publicKey: device.publicKey,
        evidence: await attestedEvidence(foreignRoot, foreignSubCa, device.keys.publicKey),
      },
      {
        name: "a chain to another root that also carries that root",
        publicKey: device.publicKey,
        evidence: await attestedEvidence(foreignRoot, foreignSubCa, device.keys.publicKey, {
          withRoot: true,
        }),
      },
      {
        name: "a trusted chain whose leaf attests another key",
        publicKey: device.publicKey,
        evidence: await attestedEvidence(root, subCa, other.keys.publicKey),
      },
      {
        name: "a leaf with no issuer chain",
        publicKey: device.publicKey,
        evidence: {
          ...(await attestedEvidence(root, subCa, device.keys.publicKey)),
          attestation: [Buffer.from(selfSigned.certificate).toString("base64")],
        },
      },
      {
        name: "evidence that is not a Managed Device Attestation",
        publicKey: device.publicKey,
        evidence: { attestation: "evidence" },
      },
      { name: "no evidence", publicKey: device.publicKey, evidence: null },
    ];
    for (const c of cases)
      expect(await enroll(trusting(), c.publicKey, c.evidence), c.name).toEqual({
        answer: "attestation",
        row: null,
      });
  }, 60_000);

  it("[FD-PROV-028] trusts only the Apple Enterprise Attestation Root CA in the verifier a deployed control plane binds", async () => {
    const device = await newDeviceKey();
    const evidence = await attestedEvidence(root, subCa, device.keys.publicKey, { withRoot: true });
    expect(await enroll(trusting(), device.publicKey, evidence)).toMatchObject({
      answer: "registered",
    });
    expect(await enroll(appleAttestationVerifier, device.publicKey, evidence)).toEqual({
      answer: "attestation",
      row: null,
    });
  }, 60_000);

  it("[FD-PROV-029] answers false for SIP disabled or a Secure Boot level other than full, so registerDevice refuses with attestation", async () => {
    const device = await newDeviceKey();
    const cases: readonly { readonly name: string; readonly attestation: DeviceAttestation }[] = [
      { name: "SIP disabled", attestation: { sip: derBoolean(false) } },
      { name: "SIP not reported", attestation: { sip: null } },
      { name: "reduced Secure Boot", attestation: { secureBoot: "reduced" } },
      { name: "permissive Secure Boot", attestation: { secureBoot: "permissive" } },
      { name: "Secure Boot not reported", attestation: { secureBoot: null } },
      {
        name: "SIP disabled under reduced Secure Boot",
        attestation: { sip: derBoolean(false), secureBoot: "reduced" },
      },
    ];
    const verify = trusting();
    for (const c of cases) {
      const evidence = await attestedEvidence(root, subCa, device.keys.publicKey, c.attestation);
      expect(await Effect.runPromise(verify(device.publicKey, evidence)), c.name).toBe(false);
      expect(await enroll(verify, device.publicKey, evidence), c.name).toEqual({
        answer: "attestation",
        row: null,
      });
    }
    const healthy = await attestedEvidence(root, subCa, device.keys.publicKey, {
      sip: derBoolean(true),
      secureBoot: "full",
    });
    expect(await enroll(verify, device.publicKey, healthy)).toMatchObject({ answer: "registered" });
  }, 60_000);
});
