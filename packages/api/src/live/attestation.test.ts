import { X509Certificate } from "node:crypto";
import { buildProfile, type Deployment, type Phase } from "@fractalboxdev/flare-dispatch-profile";
import { runD1Migrations, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Exit } from "effect";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeviceRegistry } from "../ports.ts";
import {
  APPLE_ENTERPRISE_ATTESTATION_ROOT_CA,
  appleAttestationVerifier,
  attestationVerifier,
  codeSigningHashOf,
  codeSigningHashOfRequirement,
} from "./attestation.ts";
import {
  attestedEvidence,
  base64,
  keyHelperRequirement,
  newDeviceKey,
  newRoot,
  newSubCa,
  pem,
  type Authority,
} from "./attestation.test-support.ts";
import { d1DeviceRegistry } from "./registry.ts";

let root: Authority;
let subCa: Authority;

beforeAll(async () => {
  root = await newRoot();
  subCa = await newSubCa(root);
});

const verdict = (verify: ReturnType<typeof attestationVerifier>, key: string, evidence: unknown) =>
  Effect.runPromise(verify(key, evidence));

describe("the attestation verifier", () => {
  it("reads the X.509 certificates Node's own parser verifies", async () => {
    const device = await newDeviceKey();
    const evidence = await attestedEvidence(root, subCa, device.keys.publicKey);
    const [leaf, sub] = evidence.attestation.map(
      (b64) => new X509Certificate(Buffer.from(b64, "base64")),
    );
    const rootCert = new X509Certificate(Buffer.from(root.certificate));
    expect(leaf!.verify(sub!.publicKey)).toBe(true);
    expect(sub!.verify(rootCert.publicKey)).toBe(true);
    expect(sub!.ca).toBe(true);
    expect(
      await verdict(
        attestationVerifier({ roots: [pem(root.certificate)] }),
        device.publicKey,
        evidence,
      ),
    ).toBe(true);
  });

  it("parses the embedded Apple Enterprise Attestation Root CA and trusts it alone", async () => {
    const apple = new X509Certificate(APPLE_ENTERPRISE_ATTESTATION_ROOT_CA);
    expect(apple.subject).toContain("CN=Apple Enterprise Attestation Root CA");
    expect(apple.fingerprint256).toBe(
      "CC:F5:9E:F8:FC:B3:01:7D:97:F8:B5:FA:6F:A9:0E:7A:3F:92:83:F7:6B:55:AC:6C:F6:ED:A8:B8:B9:49:F0:5B",
    );
    const device = await newDeviceKey();
    const evidence = await attestedEvidence(root, subCa, device.keys.publicKey);
    expect(await verdict(appleAttestationVerifier, device.publicKey, evidence)).toBe(false);
  });

  it("accepts a chain that carries its root, and refuses one whose leaf is outside its validity period", async () => {
    const verify = attestationVerifier({ roots: [base64(root.certificate)] });
    const device = await newDeviceKey();
    expect(
      await verdict(
        verify,
        device.publicKey,
        await attestedEvidence(root, subCa, device.keys.publicKey, { withRoot: true }),
      ),
    ).toBe(true);
    const expired = await attestedEvidence(root, subCa, device.keys.publicKey, {
      notBefore: Date.now() - 20 * 86_400_000,
      notAfter: Date.now() - 86_400_000,
    });
    expect(await verdict(verify, device.publicKey, expired)).toBe(false);
  });

  it("refuses a chain whose intermediate is not a CA", async () => {
    const verify = attestationVerifier({ roots: [pem(root.certificate)] });
    const notCa = await newSubCa(root, "Not a CA", false);
    const device = await newDeviceKey();
    expect(
      await verdict(
        verify,
        device.publicKey,
        await attestedEvidence(root, notCa, device.keys.publicKey),
      ),
    ).toBe(false);
  });

  it("refuses evidence whose freshness code binds another code-signing requirement", async () => {
    const verify = attestationVerifier({ roots: [pem(root.certificate)] });
    const device = await newDeviceKey();
    const evidence = await attestedEvidence(root, subCa, device.keys.publicKey, {
      requirement: keyHelperRequirement("cd".repeat(20)),
      boundRequirement: keyHelperRequirement("ab".repeat(20)),
    });
    expect(await verdict(verify, device.publicKey, evidence)).toBe(false);
    const changedFreshness = {
      ...(await attestedEvidence(root, subCa, device.keys.publicKey)),
      freshness: "another",
    };
    expect(await verdict(verify, device.publicKey, changedFreshness)).toBe(false);
  });

  it("refuses malformed evidence and a requirement that names no single cdhash", async () => {
    const verify = attestationVerifier({ roots: [pem(root.certificate)] });
    const device = await newDeviceKey();
    const evidence = await attestedEvidence(root, subCa, device.keys.publicKey);
    for (const bad of [
      null,
      { attestation: "evidence" },
      { ...evidence, attestation: [] },
      { ...evidence, attestation: ["bm90IGEgY2VydA=="] },
      { ...evidence, format: "tpm" },
    ])
      expect(await verdict(verify, device.publicKey, bad), JSON.stringify(bad)).toBe(false);
    const unnamed = await attestedEvidence(root, subCa, device.keys.publicKey, {
      requirement: 'identifier "dev.flaredispatch.key-helper" and anchor apple generic',
    });
    expect(await verdict(verify, device.publicKey, unnamed)).toBe(false);
  });
});

describe("the code-signing hash", () => {
  it("[FD-PROV-031] is the one cdhash the evidence's code-signing requirement names", async () => {
    expect(codeSigningHashOfRequirement(keyHelperRequirement("AB".repeat(20)))).toBe(
      "ab".repeat(20),
    );
    expect(codeSigningHashOfRequirement(keyHelperRequirement("12".repeat(32)))).toBe(
      "12".repeat(32),
    );
    expect(codeSigningHashOfRequirement(keyHelperRequirement("12".repeat(5)))).toBeNull();
    expect(
      codeSigningHashOfRequirement(
        `${keyHelperRequirement("ab".repeat(20))} or cdhash H"${"cd".repeat(20)}"`,
      ),
    ).toBeNull();
    const device = await newDeviceKey();
    const evidence = await attestedEvidence(root, subCa, device.keys.publicKey, {
      requirement: keyHelperRequirement("ef".repeat(20)),
    });
    expect(codeSigningHashOf(evidence)).toBe("ef".repeat(20));
    expect(codeSigningHashOf(null)).toBeNull();
  });
});

describe("the enrollment route's code hash", () => {
  let mf: Miniflare;
  let databases = 0;
  beforeAll(() => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response(''); } }",
      compatibilityDate: "2026-05-01",
      d1Databases: Array.from({ length: 4 }, (_, i) => `DB${i}`),
    });
  }, 60_000);
  afterAll(() => mf?.dispose());

  /** Registers `identity` through the registry of `deployment` at `phase`, and answers the row's `code_hash`. */
  const enroll = async (
    deployment: Deployment,
    phase: Phase,
    identity: { public_key: string; key_store: "software" | "secure-enclave"; evidence: unknown },
  ) => {
    const db = (await mf.getD1Database(`DB${databases++}`)) as unknown as D1Like;
    await runD1Migrations(db);
    let at = 0;
    const registry = d1DeviceRegistry({
      db,
      anchor: { read: async () => at, advance: async (e: number) => (at = Math.max(at, e)) },
      profile: buildProfile(deployment, phase),
      posture: () => Effect.succeed("unmanaged"),
      verify: attestationVerifier({ roots: [pem(root.certificate)] }),
    });
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* DeviceRegistry).register({
          executor_id: "code-hash-device",
          identity: { ...identity, certificate_chain: [] },
          labels: [],
          protocol_version: "1",
          code_hash: "reported-by-the-device",
        });
      }).pipe(Effect.provide(registry)),
    );
    expect(Exit.isSuccess(exit), JSON.stringify(exit)).toBe(true);
    const row = await (db as unknown as D1Database)
      .prepare("select code_hash from executors where executor_id = ?")
      .bind("code-hash-device")
      .first<{ code_hash: string | null }>();
    return row?.code_hash;
  };

  it("[FD-PROV-031] records the code-signing hash from the attestation evidence, never the code_hash the device reports", async () => {
    const device = await newDeviceKey();
    const evidence = await attestedEvidence(root, subCa, device.keys.publicKey, {
      requirement: keyHelperRequirement("9f".repeat(20)),
    });
    expect(
      await enroll("production", 1, {
        public_key: device.publicKey,
        key_store: "secure-enclave",
        evidence,
      }),
    ).toBe("9f".repeat(20));
  }, 60_000);

  it("[FD-PROV-031] records no code hash where the registration verifies no evidence", async () => {
    const device = await newDeviceKey();
    const evidence = await attestedEvidence(root, subCa, device.keys.publicKey);
    expect(
      await enroll("production", 0, {
        public_key: device.publicKey,
        key_store: "software",
        evidence: null,
      }),
    ).toBeNull();
    // Evidence a software key carries under `attestation: none` is the device's own claim.
    expect(
      await enroll("development", 1, {
        public_key: device.publicKey,
        key_store: "software",
        evidence,
      }),
    ).toBeNull();
  }, 60_000);
});
