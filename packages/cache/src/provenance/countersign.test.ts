import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactPath } from "../artifacts.ts";
import { sha256Hex, utf8 } from "../crypto.ts";
import { CacheBucket } from "../manifest.ts";
import { emptyBucket, failureOf, startMiniflare } from "../support.test-support.ts";
import { writeCloudStatement } from "./cloud-statement.ts";
import {
  countersign,
  countersignAccepted,
  CountersignOutcome,
  StatementBinding,
} from "./countersign.ts";
import {
  derToP1363,
  DSSE_PAYLOAD_TYPE,
  dssePae,
  fromBase64,
  p1363ToDer,
  parseProvenanceKey,
  signPae,
  unsignedEnvelope,
  verifyDsseSignature,
  type DsseEnvelope,
  type ProvenanceKey,
} from "./dsse.ts";
import { disallowedContent, envelopeDisallowedContent } from "./statement.ts";

const keyPair = async (kid: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { private: parseProvenanceKey(JSON.stringify({ ...priv, kid }))!, public: pub };
};

const sha = (c: string) => `sha256:${c.repeat(64)}`;

/** A device-signed envelope, as the device executor submits it with its result. */
const deviceEnvelope = async (device: ProvenanceKey): Promise<DsseEnvelope> => {
  const payload = utf8(JSON.stringify({ _type: "https://in-toto.io/Statement/v1", subject: [] }));
  const unsigned = unsignedEnvelope(payload);
  return { ...unsigned, signatures: [await signPae(device, dssePae(DSSE_PAYLOAD_TYPE, payload))] };
};

const payloadOf = (envelope: DsseEnvelope) =>
  JSON.parse(new TextDecoder().decode(fromBase64(envelope.payload))) as Record<string, any>;

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

describe("countersignature", () => {
  it("[FD-PROV-032] a countersignature's sig is the ASN.1 DER ECDSA-Sig-Value Rekor verifies, and a P1363 sig does not verify", async () => {
    const device = await keyPair("device-1");
    const provenance = await keyPair("prov-2026-11");
    const signed = await Effect.runPromise(
      countersign(await deviceEnvelope(device.private), provenance.private),
    );
    const der = fromBase64(signed.signatures[1]!.sig)!;
    expect(der[0]).toBe(0x30);
    const p1363 = derToP1363(der)!;
    expect(p1363.byteLength).toBe(64);
    expect(p1363ToDer(p1363)).toEqual(der);
    const asP1363 = { ...signed.signatures[1]!, sig: toBase64(p1363) };
    expect(await verifyDsseSignature(provenance.public, signed, asP1363)).toBe(false);

    // Scalars with the top bit set gain a 0x00; scalars with leading zeros lose them; both round-trip.
    const high = Uint8Array.from({ length: 64 }, (_, i) => (i === 0 || i === 32 ? 0x80 : i));
    const highDer = p1363ToDer(high);
    expect([...highDer.subarray(0, 5)]).toEqual([0x30, 70, 0x02, 33, 0x00]);
    expect(derToP1363(highDer)).toEqual(high);
    const low = new Uint8Array(64);
    low[31] = 1;
    low[63] = 2;
    expect([...p1363ToDer(low)]).toEqual([0x30, 6, 0x02, 1, 1, 0x02, 1, 2]);
    expect(derToP1363(p1363ToDer(low))).toEqual(low);
    // A non-minimal integer, a negative one, trailing bytes and a short sequence are not DER.
    expect(derToP1363(Uint8Array.of(0x30, 7, 0x02, 2, 0, 1, 0x02, 1, 2))).toBeUndefined();
    expect(derToP1363(Uint8Array.of(0x30, 6, 0x02, 1, 0x81, 0x02, 1, 2))).toBeUndefined();
    expect(derToP1363(Uint8Array.of(0x30, 6, 0x02, 1, 1, 0x02, 1, 2, 0))).toBeUndefined();
    expect(derToP1363(Uint8Array.of(0x30, 3, 0x02, 1, 1))).toBeUndefined();
  });

  it("[FD-PROV-032] an accepted statement gains a countersignature by the active provenance key beside the device signature", async () => {
    const device = await keyPair("device-1");
    const provenance = await keyPair("prov-2026-11");
    const submitted = await deviceEnvelope(device.private);
    const signed = await Effect.runPromise(countersign(submitted, provenance.private));
    expect(signed.payload).toBe(submitted.payload);
    expect(signed.payloadType).toBe(DSSE_PAYLOAD_TYPE);
    expect(signed.signatures.map((s) => s.keyid)).toEqual(["device-1", "prov-2026-11"]);
    expect(await verifyDsseSignature(device.public, signed, signed.signatures[0]!)).toBe(true);
    expect(await verifyDsseSignature(provenance.public, signed, signed.signatures[1]!)).toBe(true);
    // The countersignature covers the payload: it does not verify over another payload.
    const other = { ...signed, payload: unsignedEnvelope(utf8("{}")).payload };
    expect(await verifyDsseSignature(provenance.public, other, signed.signatures[1]!)).toBe(false);

    // A signature the device placed under the provenance key's kid is replaced by the control plane's own.
    const forged: DsseEnvelope = {
      ...submitted,
      signatures: [
        ...submitted.signatures,
        { keyid: "prov-2026-11", sig: submitted.signatures[0]!.sig },
      ],
    };
    const resigned = await Effect.runPromise(countersign(forged, provenance.private));
    expect(resigned.signatures.map((s) => s.keyid)).toEqual(["device-1", "prov-2026-11"]);
    expect(await verifyDsseSignature(provenance.public, resigned, resigned.signatures[1]!)).toBe(
      true,
    );

    // The active key signs: after a rotation, the new kid is the one added.
    const next = await keyPair("prov-2027-01");
    const rotated = await Effect.runPromise(
      countersignAccepted(
        submitted,
        StatementBinding.ExecutionLease({ executionId: "exec-1", epoch: 1 }),
        next.private,
      ),
    );
    CountersignOutcome.$match(rotated, {
      Countersigned: ({ envelope, keyid }) => {
        expect(keyid).toBe("prov-2027-01");
        expect(envelope.signatures.map((s) => s.keyid)).toEqual(["device-1", "prov-2027-01"]);
      },
      Advisory: () => expect.fail("an execution-lease statement is countersigned"),
    });
  });

  it("[FD-PROV-025] a statement from capacity-lease work with no registration is never countersigned and its result stays advisory", async () => {
    const device = await keyPair("device-1");
    const provenance = await keyPair("prov-2026-11");
    const submitted = await deviceEnvelope(device.private);
    const decide = (binding: StatementBinding) =>
      Effect.runPromise(countersignAccepted(submitted, binding, provenance.private));

    const unregistered = await decide(
      StatementBinding.UnregisteredCapacityLease({ leaseId: "cap-7", epoch: 3 }),
    );
    CountersignOutcome.$match(unregistered, {
      Countersigned: () => expect.fail("unregistered capacity-lease work is countersigned"),
      Advisory: ({ envelope }) => {
        expect(envelope).toEqual(submitted);
        expect(envelope.signatures.some((s) => s.keyid === "prov-2026-11")).toBe(false);
      },
    });

    // The same capacity-lease work, once `local.register` bound it, is countersigned.
    const registered = await decide(
      StatementBinding.Registration({ executionId: "exec-9", leaseId: "cap-7", epoch: 3 }),
    );
    expect(CountersignOutcome.$is("Countersigned")(registered)).toBe(true);
  });
});

describe("cloud-builder statement", () => {
  let mf: Awaited<ReturnType<typeof startMiniflare>>;
  beforeAll(async () => {
    mf = await startMiniflare();
  });
  afterAll(async () => {
    await mf?.mf.dispose();
  });

  const input = (
    over: { kind?: "build" | "gate"; artifacts?: { name: string }[]; fetches?: unknown[] } = {},
  ) => ({
    lease: {
      execution_id: "exec-42",
      epoch: 2,
      nonce: "n-0123456789abcdef",
      executor_id: "cf-7",
      executor_kind: "cloudflare",
      run: {
        name: "release",
        kind: over.kind ?? "build",
        definition_digest: sha("a"),
        inputs_digest: sha("b"),
      },
      repository: "acme/widgets",
      ref: "refs/tags/v1.2.3",
      commit_sha: "c".repeat(40),
      image_digest: sha("d"),
      class: "release",
      policy_version: "7",
      confidentiality: "unclassified",
    },
    outcome: "success",
    commands: [{ name: "build", exit_status: 0 }],
    artifacts: over.artifacts ?? [{ name: "dist/app.tar.gz" }, { name: "sbom.json" }],
    lockfiles: [{ path: "pnpm-lock.yaml", digest: sha("e") }],
    fetches: over.fetches ?? [],
    locked_dependencies: [
      { uri: "https://registry.npmjs.org/effect/-/effect-4.0.6.tgz", digest: sha("2") },
      { uri: "https://registry.npmjs.org/vitest/-/vitest-3.2.0.tgz", digest: sha("3") },
    ],
    restored_cache: [],
    egress_log_digest: sha("f"),
    step_log_digest: sha("1"),
    models: [],
  });

  it("[FD-PROV-008] an accepted cloud result's statement takes each subject digest from the artifact bytes in R2 and is signed by the provenance key as the cloud builder", async () => {
    await emptyBucket(mf.bucket);
    const provenance = await keyPair("prov-2026-11");
    const bytes = { "dist/app.tar.gz": utf8("tarball bytes"), "sbom.json": utf8('{"sbom":true}') };
    for (const [name, body] of Object.entries(bytes))
      await mf.bucket.put(artifactPath("exec-42", 2, name), body);
    // Bytes stored under another epoch are not this result's artifacts.
    await mf.bucket.put(artifactPath("exec-42", 1, "sbom.json"), utf8("stale epoch"));

    const write = (raw: unknown) =>
      writeCloudStatement(raw, provenance.private).pipe(
        Effect.provide(Layer.succeed(CacheBucket, mf.bucket)),
      );
    const run = (raw: unknown) => Effect.runPromiseExit(write(raw));
    const { envelope, statement } = await Effect.runPromise(write(input()));

    expect(envelope.payloadType).toBe(DSSE_PAYLOAD_TYPE);
    expect(payloadOf(envelope)).toEqual(statement);
    expect(statement.subject).toEqual([
      { name: "dist/app.tar.gz", digest: { sha256: await sha256Hex(bytes["dist/app.tar.gz"]) } },
      { name: "sbom.json", digest: { sha256: await sha256Hex(bytes["sbom.json"]) } },
    ]);
    // Signed once, by the provenance key: no device signature, so the verifier reads it as a cloud builder.
    expect(envelope.signatures.map((s) => s.keyid)).toEqual(["prov-2026-11"]);
    expect(await verifyDsseSignature(provenance.public, envelope, envelope.signatures[0]!)).toBe(
      true,
    );
    const predicate = payloadOf(envelope).predicate;
    expect(payloadOf(envelope).predicateType).toBe("https://slsa.dev/provenance/v1");
    expect(predicate.runDetails.builder.id).toBe("cloudflare:cf-7");
    expect(predicate.buildDefinition.internalParameters.lease).toEqual({
      execution_id: "exec-42",
      epoch: 2,
      nonce: "n-0123456789abcdef",
      executor_id: "cf-7",
      binding_kind: "execution-lease",
    });

    // R2's bytes decide the digest: overwrite them and the subject digest follows.
    await mf.bucket.put(artifactPath("exec-42", 2, "sbom.json"), utf8("replaced"));
    const again = await Effect.runPromise(write(input()));
    expect((again.statement.subject as { digest: { sha256: string } }[])[1]!.digest.sha256).toBe(
      await sha256Hex(utf8("replaced")),
    );

    // An artifact the submission names but R2 does not hold fails the write; nothing is signed.
    expect(
      failureOf(
        await run(input({ artifacts: [{ name: "dist/app.tar.gz" }, { name: "missing.bin" }] })),
      ),
    ).toMatchObject({ reason: "artifact-missing", detail: "missing.bin" });

    // A gate with no artifact names the commit as its one subject, under the test-result predicate.
    const gate = await Effect.runPromise(write(input({ kind: "gate", artifacts: [] })));
    expect(gate.statement.subject).toEqual([
      { name: "commit", digest: { gitCommit: "c".repeat(40) } },
    ]);
    expect(gate.statement.predicateType).toBe("https://in-toto.io/attestation/test-result/v0.1");
    expect(
      await verifyDsseSignature(provenance.public, gate.envelope, gate.envelope.signatures[0]!),
    ).toBe(true);
  });

  it("[FD-PROV-006] a cloud-builder statement lists each dependency the job fetched with the source of its digest", async () => {
    await emptyBucket(mf.bucket);
    const provenance = await keyPair("prov-2026-11");
    const fetches = [
      {
        host: "registry.npmjs.org",
        method: "GET",
        path: "/effect/-/effect-4.0.6.tgz",
        response_digest: sha("4"),
      },
      {
        host: "registry.npmjs.org",
        method: "GET",
        path: "/vitest/-/vitest-3.2.0.tgz",
        response_digest: null,
      },
    ];
    const write = (kind: "build" | "gate") =>
      Effect.runPromise(
        writeCloudStatement(input({ kind, artifacts: [], fetches }), provenance.private).pipe(
          Effect.provide(Layer.succeed(CacheBucket, mf.bucket)),
        ),
      );
    const fetched = [
      {
        uri: "https://registry.npmjs.org/effect/-/effect-4.0.6.tgz",
        digest: { sha256: "4".repeat(64) },
        annotations: { digest_source: "proxy" },
      },
      {
        uri: "https://registry.npmjs.org/vitest/-/vitest-3.2.0.tgz",
        digest: { sha256: "3".repeat(64) },
        annotations: { digest_source: "lockfile" },
      },
    ];

    const build = await write("build");
    const resolved = payloadOf(build.envelope).predicate.buildDefinition
      .resolvedDependencies as unknown[];
    expect(resolved).toEqual(expect.arrayContaining(fetched));
    const gate = await write("gate");
    expect(payloadOf(gate.envelope).predicate.configuration).toEqual(
      expect.arrayContaining(fetched),
    );
  });

  it("[FD-PROV-043] the cloud builder's statement holds only digests, ids, names, timestamps and verdicts, and a result carrying source, a diff, a log, a prompt or a completion is written into no statement", async () => {
    await emptyBucket(mf.bucket);
    const provenance = await keyPair("prov-2026-11");
    await mf.bucket.put(
      artifactPath("exec-42", 2, "dist/app.tar.gz"),
      utf8("export const a = 1;\n"),
    );
    const write = (raw: unknown) =>
      Effect.runPromiseExit(
        writeCloudStatement(raw, provenance.private).pipe(
          Effect.provide(Layer.succeed(CacheBucket, mf.bucket)),
        ),
      );
    const full = (kind: "build" | "gate") => ({
      ...input({
        kind,
        artifacts: [{ name: "dist/app.tar.gz" }],
        fetches: [
          {
            host: "registry.npmjs.org",
            method: "GET",
            path: "/effect/-/effect-4.0.6.tgz",
            response_digest: sha("4"),
          },
        ],
      }),
      commands: [
        { name: "build", exit_status: 0 },
        { name: "test", exit_status: 1 },
      ],
      restored_cache: [{ namespace: "pnpm", key: "lock-abc", digest: sha("5") }],
      models: [{ id: "model-a", tokens: 1200 }],
    });

    // Every value of the statement and of its signed envelope is a digest, id, name, timestamp, verdict or count: the
    // artifact's bytes are digested, never copied in.
    for (const kind of ["build", "gate"] as const) {
      const exit = await write(full(kind));
      expect(exit._tag).toBe("Success");
      if (exit._tag !== "Success") continue;
      expect(disallowedContent(exit.value.statement)).toBeNull();
      expect(envelopeDisallowedContent(exit.value.envelope)).toBeNull();
      expect(JSON.stringify(exit.value.statement)).not.toContain("export const a");
    }

    // A result that would carry content into a field is written into no statement.
    const log = "npm ERR! code ELIFECYCLE\nnpm ERR! errno 1";
    const diff = "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;";
    const prompt = "Review this pull request and list every bug";
    const completion = "The change is correct. I found no bugs.";
    const carrying = [
      { ...full("build"), artifacts: [{ name: diff }] },
      { ...full("gate"), commands: [{ name: log, exit_status: 1 }] },
      { ...full("build"), models: [{ id: prompt, tokens: 1 }] },
      { ...full("build"), outcome: completion },
      {
        ...full("build"),
        lockfiles: [{ path: "pnpm-lock.yaml", digest: "lockfileVersion: '9.0'" }],
      },
    ];
    for (const raw of carrying)
      expect(failureOf(await write(raw))).toMatchObject({ _tag: "CloudStatementFailed" });
  });
});
