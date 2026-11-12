// The release publish gate over the control plane's log-append intents: statements are real in-toto statements in DSSE
// envelopes signed with generated ES256 keys, and the intents live in the in-memory store with the D1 store's semantics.
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { utf8 } from "../crypto.ts";
import { failureOf } from "../support.test-support.ts";
import { envelopeEntry, LogAppendStatus, LogAppendStore, type LogAppendIntent } from "./append.ts";
import { memoryLogAppendStore } from "./append.test-support.ts";
import { countersign } from "./countersign.ts";
import {
  DSSE_PAYLOAD_TYPE,
  dssePae,
  parseProvenanceKey,
  signPae,
  unsignedEnvelope,
  type DsseEnvelope,
  type ProvenanceKey,
} from "./dsse.ts";
import {
  gateReleasePublish,
  RELEASE_BUILT_WARM,
  RELEASE_STATEMENT_MISSING,
  type ProvenancePublicKey,
  type ReleaseArtifact,
} from "./release.ts";
import { statementOf, type StatementBody } from "./statement.ts";

const keyPair = async (kid: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    private: parseProvenanceKey(JSON.stringify({ ...priv, kid }))!,
    public: { ...pub, kid } as ProvenancePublicKey,
  };
};

const sha = (c: string) => `sha256:${c.repeat(64)}`;
const EXECUTION = "exec-release-1";
const ARCHIVE = { name: "app-1.2.3.tar.gz", digest: sha("a"), executionId: EXECUTION };
const SBOM = { name: "app-1.2.3.cdx.json", digest: sha("b"), executionId: EXECUTION };

const body = (over: Partial<{
  executionId: string;
  kind: "build" | "gate";
  bindingKind: "execution-lease" | "registration";
  restored: StatementBody["restored_cache"];
}> = {}): StatementBody => ({
  lease: {
    execution_id: over.executionId ?? EXECUTION,
    epoch: 1,
    nonce: "n-0123456789abcdef",
    executor_id: "cf-7",
    executor_kind: "cloudflare",
    run: { name: "release", kind: over.kind ?? "build", definition_digest: sha("c"), inputs_digest: sha("d") },
    repository: "acme/widgets",
    ref: "refs/tags/v1.2.3",
    commit_sha: "e".repeat(40),
    image_digest: sha("f"),
    class: "release",
    policy_version: "7",
    confidentiality: "unclassified",
    binding_kind: over.bindingKind ?? "execution-lease",
  },
  outcome: "success",
  commands: [{ name: "build", exit_status: 0 }],
  lockfiles: [{ path: "Cargo.lock", digest: sha("1") }],
  fetches: [],
  locked_dependencies: [],
  restored_cache: over.restored ?? [],
  egress_log_digest: sha("2"),
  step_log_digest: sha("3"),
  models: [],
});

const subjects = (artifacts: readonly ReleaseArtifact[]) =>
  artifacts.map((a) => ({ name: a.name, digest: { sha256: a.digest.slice("sha256:".length) } }));

/** An envelope over the statement, signed by each key in order. */
const signed = async (
  statementBody: StatementBody,
  artifacts: readonly ReleaseArtifact[],
  ...keys: readonly ProvenanceKey[]
): Promise<DsseEnvelope> => {
  const payload = utf8(JSON.stringify(statementOf(statementBody, subjects(artifacts))));
  const signatures = [];
  for (const key of keys) signatures.push(await signPae(key, dssePae(DSSE_PAYLOAD_TYPE, payload)));
  return { ...unsignedEnvelope(payload), signatures };
};

/** The log-append intent of an envelope, logged in the private log unless `pending`. */
const intentOf = async (
  envelope: DsseEnvelope,
  executionId = EXECUTION,
  pending = false,
): Promise<LogAppendIntent> => {
  const { json, digest } = await envelopeEntry(envelope);
  return {
    envelopeDigest: digest,
    executionId,
    repository: "acme/widgets",
    log: "private",
    envelope: json,
    verifiers: [],
    status: pending
      ? LogAppendStatus.Pending({ attempts: 1, nextAttemptAt: 0, lastError: "unavailable" })
      : LogAppendStatus.Logged({
          attempts: 1,
          entry: { log: "private", logIndex: 4, entryId: "leaf", integratedTime: 1_700_000_000_000 },
        }),
  };
};

const gate = async (
  intents: readonly LogAppendIntent[],
  artifacts: readonly ReleaseArtifact[],
  keys: readonly ProvenancePublicKey[],
) => {
  const store = memoryLogAppendStore(new Map(intents.map((i) => [i.envelopeDigest, i])));
  return Effect.runPromiseExit(
    gateReleasePublish(artifacts, keys).pipe(Effect.provide(Layer.succeed(LogAppendStore, store))),
  );
};

const refusal = (exit: Awaited<ReturnType<typeof gate>>) =>
  failureOf(exit) as { _tag: string; conclusion: string; reason: string; artifact: string } | undefined;

describe("release publish gate", () => {
  it("[FD-PROV-062] the publish is refused with `provenance: release statement missing` unless a logged platform statement from a cloud builder names each artifact's digest", async () => {
    const provenance = await keyPair("prov-2026-11");
    const retired = await keyPair("prov-2026-05");
    const device = await keyPair("device-1");
    const artifacts = [ARCHIVE, SBOM];
    const missing = (artifact: string) => ({
      _tag: "ReleasePublishRefused",
      conclusion: "failure",
      reason: RELEASE_STATEMENT_MISSING,
      artifact,
    });
    const keys = [provenance.public, retired.public];

    // Admitted: the cloud builder's statement names both digests and is logged.
    const cloud = await intentOf(await signed(body(), artifacts, provenance.private));
    const admitted = await gate([cloud], artifacts, keys);
    expect(admitted._tag).toBe("Success");
    expect(admitted._tag === "Success" && admitted.value).toEqual([
      { artifact: ARCHIVE.name, envelopeDigest: cloud.envelopeDigest, entry: expect.objectContaining({ logIndex: 4 }) },
      { artifact: SBOM.name, envelopeDigest: cloud.envelopeDigest, entry: expect.objectContaining({ logIndex: 4 }) },
    ]);
    // A statement signed by a retired provenance key still counts: the key history decides, not the active key alone.
    expect((await gate([await intentOf(await signed(body(), artifacts, retired.private))], artifacts, keys))._tag)
      .toBe("Success");

    // No statement at all.
    expect(refusal(await gate([], artifacts, keys))).toMatchObject(missing(ARCHIVE.name));
    // The statement names the archive but not the SBOM.
    expect(refusal(await gate([await intentOf(await signed(body(), [ARCHIVE], provenance.private))], artifacts, keys)))
      .toMatchObject(missing(SBOM.name));
    // The statement's append is still pending: it is not logged.
    expect(refusal(await gate([await intentOf(await signed(body(), artifacts, provenance.private), EXECUTION, true)],
      artifacts, keys))).toMatchObject(missing(ARCHIVE.name));
    // A device statement the control plane countersigned is a platform statement, but not from a cloud builder.
    const deviceStatement = await Effect.runPromise(
      countersign(await signed(body(), artifacts, device.private), provenance.private),
    );
    expect(refusal(await gate([await intentOf(deviceStatement)], artifacts, keys)))
      .toMatchObject(missing(ARCHIVE.name));
    // Signed by a key outside the provenance key history.
    expect(refusal(await gate([await intentOf(await signed(body(), artifacts, device.private))], artifacts, keys)))
      .toMatchObject(missing(ARCHIVE.name));
    // A signature that does not verify: the payload was altered after signing.
    const good = await signed(body(), artifacts, provenance.private);
    const altered = { ...good, payload: (await signed(body({ executionId: EXECUTION }), [ARCHIVE])).payload };
    expect(refusal(await gate([await intentOf(altered)], [ARCHIVE], keys))).toMatchObject(missing(ARCHIVE.name));
    // A `registration` binding is `device-signed` at most, never `platform`.
    expect(refusal(await gate([await intentOf(await signed(body({ bindingKind: "registration" }), artifacts,
      provenance.private))], artifacts, keys))).toMatchObject(missing(ARCHIVE.name));
    // The statement binds another execution's lease, though its intent is filed under the release execution.
    expect(refusal(await gate([await intentOf(await signed(body({ executionId: "exec-other" }), artifacts,
      provenance.private))], artifacts, keys))).toMatchObject(missing(ARCHIVE.name));
    // A statement of another execution naming the same digests does not admit this release's artifacts.
    expect(refusal(await gate([await intentOf(await signed(body({ executionId: "exec-other" }), artifacts,
      provenance.private), "exec-other")], artifacts, keys))).toMatchObject(missing(ARCHIVE.name));
  });

  it("[FD-PROV-063] the publish is refused with `provenance: release built warm` when the release statement lists a restored cache entry", async () => {
    const provenance = await keyPair("prov-2026-11");
    const keys = [provenance.public];
    const restored = [{ namespace: "cargo", key: "release-x86_64", digest: sha("9") }];

    for (const kind of ["build", "gate"] as const) {
      const warm = await intentOf(await signed(body({ kind, restored }), [ARCHIVE, SBOM], provenance.private));
      expect(failureOf(await gate([warm], [ARCHIVE, SBOM], keys))).toMatchObject({
        _tag: "ReleasePublishRefused",
        conclusion: "failure",
        reason: RELEASE_BUILT_WARM,
        artifact: ARCHIVE.name,
        envelopeDigest: warm.envelopeDigest,
      });
      // The same build, cold, publishes.
      const cold = await intentOf(await signed(body({ kind }), [ARCHIVE, SBOM], provenance.private));
      expect((await gate([cold], [ARCHIVE, SBOM], keys))._tag).toBe("Success");
      // A cold statement beside a warm one naming the same digest does not clear the warm build.
      expect(refusal(await gate([cold, warm], [ARCHIVE, SBOM], keys))?.reason).toBe(RELEASE_BUILT_WARM);
    }
  });
});
