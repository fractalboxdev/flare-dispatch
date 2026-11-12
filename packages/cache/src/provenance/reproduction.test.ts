// A release's reproduction: the request a release rule yields and its caches, the actuators' refusal of a reproduction
// execution's outbox rows, and the comparison of the two logged statements. Statements are real in-toto statements in
// DSSE envelopes signed with generated ES256 keys; the log-append intents live in the in-memory store with the D1
// store's semantics.
import { AlarmPort, actuatorRegistry, type Alarm, type IntentRow } from "@fractalboxdev/mameko-ports";
import { Effect, Layer, Logger } from "effect";
import { describe, expect, it } from "vitest";
import { utf8 } from "../crypto.ts";
import { leaseCacheFields } from "../lease.ts";
import { cacheNamespaces, restoresNothing } from "../namespaces.ts";
import { failureOf } from "../support.test-support.ts";
import {
  envelopeEntry,
  LogAppendStatus,
  LogAppendStore,
  RepositoryVisibility,
  type LogAppendIntent,
} from "./append.ts";
import { memoryLogAppendStore } from "./append.test-support.ts";
import { countersign } from "./countersign.ts";
import {
  DSSE_PAYLOAD_TYPE,
  type AnyDsseEnvelope,
  DsseEnvelope,
  dssePae,
  fromBase64,
  parseProvenanceKey,
  signPae,
  unsignedEnvelope,
  verifyDsseSignature,
  type ProvenanceKey,
} from "./dsse.ts";
import type { ProvenancePublicKey } from "./release.ts";
import {
  REPRODUCTION_APPLIES_NO_INTENT,
  REPRODUCTION_MISMATCH,
  REPRODUCTION_PAYLOAD_TYPE,
  reproductionGuardedActuators,
  reproductionRequestFor,
  ReproductionSubmitter,
  settleReproduction,
  startReproduction,
  type ReleaseExecution,
  type ReproductionRequest,
} from "./reproduction.ts";
import { envelopeDisallowedContent, statementOf, type StatementBody } from "./statement.ts";

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
const RELEASE_ID = "exec-release-1";
const REPRO_ID = "exec-repro-1";
const COMMIT = "e".repeat(40);
const DEADLINE = 1_700_000_900_000;

const release: ReleaseExecution = {
  executionId: RELEASE_ID,
  repository: "acme/widgets",
  ref: "refs/tags/v1.2.3",
  run: "release",
  commit: COMMIT,
  definitionDigest: sha("c"),
  imageDigest: sha("f"),
  inputs: { version: "1.2.3" },
};

const body = (
  executionId: string,
  over: Partial<{ kind: "cloudflare" | "device"; image: string; restored: StatementBody["restored_cache"] }> = {},
): StatementBody => ({
  lease: {
    execution_id: executionId,
    epoch: 1,
    nonce: "n-0123456789abcdef",
    executor_id: over.kind === "device" ? "mac-1" : "cf-7",
    executor_kind: over.kind ?? "cloudflare",
    run: { name: "release", kind: "build", definition_digest: sha("c"), inputs_digest: sha("d") },
    repository: "acme/widgets",
    ref: "refs/tags/v1.2.3",
    commit_sha: COMMIT,
    image_digest: over.image ?? sha("f"),
    class: over.kind === "device" ? "interactive" : "release",
    policy_version: "7",
    confidentiality: "unclassified",
    binding_kind: "execution-lease",
  },
  outcome: "success",
  commands: [{ name: "build", exit_status: 0 }],
  lockfiles: [],
  fetches: [],
  locked_dependencies: [],
  restored_cache: over.restored ?? [],
  egress_log_digest: sha("2"),
  step_log_digest: sha("3"),
  models: [],
});

const subjects = (digests: readonly string[]) =>
  digests.map((d, i) => ({ name: `artifact-${i}`, digest: { sha256: d.slice("sha256:".length) } }));

const signed = async (statementBody: StatementBody, digests: readonly string[], ...keys: readonly ProvenanceKey[]) => {
  const payload = utf8(JSON.stringify(statementOf(statementBody, subjects(digests))));
  const signatures = [];
  for (const key of keys) signatures.push(await signPae(key, dssePae(DSSE_PAYLOAD_TYPE, payload)));
  return { ...unsignedEnvelope(payload), signatures };
};

const logged = async (envelope: DsseEnvelope, executionId: string): Promise<LogAppendIntent> => {
  const { json, digest } = await envelopeEntry(envelope);
  return {
    envelopeDigest: digest,
    executionId,
    repository: "acme/widgets",
    log: "private",
    envelope: json,
    verifiers: [],
    status: LogAppendStatus.Logged({
      attempts: 1,
      entry: { log: "private", logIndex: 4, entryId: "leaf", integratedTime: 1_700_000_000_000 },
    }),
  };
};

const ARCHIVE = sha("a");
const SBOM = sha("b");

const fixture = async () => {
  const provenance = await keyPair("prov-2026-11");
  const device = await keyPair("device-1");
  const cloud = await logged(await signed(body(RELEASE_ID), [ARCHIVE, SBOM], provenance.private), RELEASE_ID);
  /** The reproduction's device statement, countersigned by the provenance key. */
  const reproduction = async (digests: readonly string[], over: Parameters<typeof body>[1] = {}) =>
    logged(
      await Effect.runPromise(
        countersign(await signed(body(REPRO_ID, { kind: "device", ...over }), digests, device.private), provenance.private),
      ),
      REPRO_ID,
    );
  return { provenance, device, cloud, reproduction };
};

const settle = async (
  intents: readonly LogAppendIntent[],
  keys: { readonly public: ProvenancePublicKey; readonly private: ProvenanceKey },
  now = DEADLINE - 1,
) => {
  const store = memoryLogAppendStore(new Map(intents.map((i) => [i.envelopeDigest, i])));
  const alarms: Alarm[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(LogAppendStore, store),
    Layer.succeed(RepositoryVisibility, { of: () => Effect.succeed("private") }),
    Layer.succeed(AlarmPort, { deliver: (a: Alarm) => Effect.sync(() => void alarms.push(a)) }),
    Logger.layer([]),
  );
  const run = () =>
    Effect.runPromiseExit(
      settleReproduction(
        { release, reproductionExecutionId: REPRO_ID, deadlineAt: DEADLINE },
        [keys.public],
        keys.private,
        now,
      ).pipe(Effect.provide(layer)),
    );
  return { store, alarms, run };
};

const row = (executionId: string | null, kind = "check.conclude"): IntentRow => ({
  executionId,
  scopeId: "acme/widgets",
  intentKey: `${kind}:0`,
  kind,
  payload: {},
  payloadDigest: "d",
  effectClass: "adoptable",
  attempts: 0,
});

describe("reproduction", () => {
  it("[FD-PROV-064] a reproduce: true rule yields an interactive reproduction request naming the release's recipe, commit and digests, and the reproduction constraint turns caches off", async () => {
    expect(reproductionRequestFor({ reproduce: true }, release)).toEqual({
      reproduces: RELEASE_ID,
      repository: "acme/widgets",
      ref: "refs/tags/v1.2.3",
      run: "release",
      commit: COMMIT,
      definitionDigest: sha("c"),
      imageDigest: sha("f"),
      inputs: { version: "1.2.3" },
      class: "interactive",
      placementConstraint: "reproduction",
      caches: "off",
    });
    expect(reproductionRequestFor({}, release)).toBeNull();
    expect(reproductionRequestFor({ reproduce: false }, release)).toBeNull();

    // Caches off: the execution the reproduction constraint names reads and writes no namespace on any executor, gets
    // no compile-cache token and restores nothing, where the same execution without it reads the protected tiers.
    const execution = {
      repo: "acme/widgets",
      executionId: REPRO_ID,
      class: "interactive",
      constraints: ["reproduction"],
      trigger: { _tag: "Push", ref: "refs/heads/main", protected: true } as const,
    };
    for (const kind of ["device", "cloudflare", "gha"] as const)
      expect(cacheNamespaces(execution, kind)).toEqual({ read: [], write: null });
    expect(restoresNothing(execution)).toBe(true);
    expect(cacheNamespaces({ ...execution, constraints: [] }, "device").read.length).toBeGreaterThan(0);
    const fields = await leaseCacheFields(
      execution,
      { epoch: 1, executorKind: "device", deadlineAt: DEADLINE },
      { publicOrigin: "https://ci.example.com", tokenSecret: "s" },
    );
    expect(fields.cache_namespaces).toEqual({ read: [], write: null });
    expect(fields.upload_grant.cache_prefix).toBeNull();
    expect(fields.upload_grant.compile_cache).toBeNull();
  });

  it("[FD-PROV-064] startReproduction submits one reproduction request for a reproduce: true rule and none otherwise", async () => {
    const submitted: ReproductionRequest[] = [];
    const submitter = Layer.succeed(ReproductionSubmitter, {
      submit: (request) =>
        Effect.sync(() => {
          submitted.push(request);
          return { _tag: "admitted" as const, executionId: REPRO_ID };
        }),
    });
    const start = (rule: Parameters<typeof startReproduction>[0]) =>
      Effect.runPromise(startReproduction(rule, release).pipe(Effect.provide(submitter)));

    expect(await start({ reproduce: true })).toEqual({ _tag: "admitted", executionId: REPRO_ID });
    expect(submitted).toEqual([reproductionRequestFor({ reproduce: true }, release)]);
    expect(await start({})).toBeNull();
    expect(await start({ reproduce: false })).toBeNull();
    expect(submitted).toHaveLength(1);
  });

  it("[FD-PROV-065] every outbox row of a reproduction execution is refused, and other executions' rows apply", async () => {
    const applied: string[] = [];
    const base = actuatorRegistry({
      checkRun: {
        apply: (r) => Effect.sync(() => (applied.push(`${r.executionId} ${r.kind}`), { _tag: "applied" as const, externalRef: "1" })),
        lookup: () => Effect.succeed({ _tag: "found" as const, externalRef: "1" }),
      },
      release: {
        apply: (r) => Effect.sync(() => (applied.push(`${r.executionId} ${r.kind}`), { _tag: "applied" as const, externalRef: "2" })),
        reconcile: () => Effect.succeed({ _tag: "found" as const, externalRef: "2" }),
      },
    });
    const guarded = reproductionGuardedActuators(base, (id) =>
      id === "unreadable" ? Effect.fail({ message: "D1 unavailable" }) : Effect.succeed(id === REPRO_ID),
    );
    expect(guarded.names()).toEqual(["checkRun", "release"]);
    const check = guarded.get("checkRun")!;
    const publish = guarded.get("release")!;

    expect(await Effect.runPromise(check.apply(row(REPRO_ID)))).toEqual({
      _tag: "refused",
      reason: REPRODUCTION_APPLIES_NO_INTENT,
    });
    expect(await Effect.runPromise(publish.apply(row(REPRO_ID, "release.publish")))).toMatchObject({ _tag: "refused" });
    // An adoptable or reconcile-only row of it finds nothing to adopt.
    expect(await Effect.runPromise(check.lookup!(row(REPRO_ID)))).toEqual({ _tag: "absent" });
    expect(await Effect.runPromise(publish.reconcile!(row(REPRO_ID, "release.publish")))).toEqual({ _tag: "absent" });
    expect(applied).toEqual([]);

    // The release's own rows, and rows of no execution, apply.
    expect(await Effect.runPromise(check.apply(row(RELEASE_ID)))).toMatchObject({ _tag: "applied" });
    expect(await Effect.runPromise(check.apply(row(null)))).toMatchObject({ _tag: "applied" });
    expect(await Effect.runPromise(check.lookup!(row(RELEASE_ID)))).toMatchObject({ _tag: "found" });
    expect(applied).toEqual([`${RELEASE_ID} check.conclude`, "null check.conclude"]);

    // An execution whose record cannot be read is retried, never applied.
    expect(await Effect.runPromise(check.apply(row("unreadable")))).toEqual({ _tag: "retryable", reason: "D1 unavailable" });
    expect(await Effect.runPromise(check.lookup!(row("unreadable")))).toMatchObject({ _tag: "undetermined" });
    expect(applied).toHaveLength(2);
  });

  it("[FD-PROV-066] equal subject digests yield a provenance-signed reproduction record naming both envelope digests, appended to the log once", async () => {
    const { provenance, cloud, reproduction } = await fixture();
    const repro = await reproduction([SBOM, ARCHIVE]);
    const s = await settle([cloud, repro], provenance);
    const exit = await s.run();
    expect(exit._tag).toBe("Success");
    const outcome = exit._tag === "Success" ? exit.value : undefined;
    expect(outcome).toMatchObject({
      _tag: "Reproduced",
      releaseEnvelopeDigest: cloud.envelopeDigest,
      reproductionEnvelopeDigest: repro.envelopeDigest,
    });

    // The record's log-append intent, keyed by its envelope digest, filed under the release execution.
    const record = s.store.intents.get(outcome!._tag === "Reproduced" ? outcome!.recordEnvelopeDigest : "")!;
    expect(record).toMatchObject({ executionId: RELEASE_ID, log: "private" });
    expect(LogAppendStatus.$is("Pending")(record.status)).toBe(true);
    const envelope = JSON.parse(record.envelope) as AnyDsseEnvelope;
    expect(envelope.signatures).toHaveLength(1);
    expect(await verifyDsseSignature(provenance.public, envelope, envelope.signatures[0]!)).toBe(true);
    const payload = JSON.parse(new TextDecoder().decode(fromBase64(envelope.payload)!));
    expect(envelope.payloadType).toBe(REPRODUCTION_PAYLOAD_TYPE);
    expect(payload).toEqual({ envelope_digests: [cloud.envelopeDigest, repro.envelopeDigest] });

    // A second comparison answers the same record and records no second intent.
    expect(await s.run()).toEqual(exit);
    expect(s.store.intents.size).toBe(3);

    // No record while the reproduction statement is not one: warm, from another image, signed by the cloud builder, or
    // not countersigned.
    const notReproductions = [
      await reproduction([ARCHIVE, SBOM], { restored: [{ namespace: "cargo", key: "k", digest: sha("9") }] }),
      await reproduction([ARCHIVE, SBOM], { image: sha("8") }),
      await logged(await signed(body(REPRO_ID), [ARCHIVE, SBOM], provenance.private), REPRO_ID),
      await logged(await signed(body(REPRO_ID, { kind: "device" }), [ARCHIVE, SBOM], (await keyPair("device-1")).private), REPRO_ID),
    ];
    for (const other of notReproductions) {
      const t = await settle([cloud, other], provenance);
      expect(await t.run()).toMatchObject({ _tag: "Success", value: { _tag: "Awaiting" } });
      expect(t.store.intents.size).toBe(2);
    }
  });

  it("[FD-PROV-043] the reproduction record names only the two envelope digests, and a record that would carry any other text is neither signed nor logged", async () => {
    const { provenance, cloud, reproduction } = await fixture();
    const repro = await reproduction([SBOM, ARCHIVE]);
    const s = await settle([cloud, repro], provenance);
    const exit = await s.run();
    const digest = exit._tag === "Success" && exit.value._tag === "Reproduced" ? exit.value.recordEnvelopeDigest : "";
    const envelope = JSON.parse(s.store.intents.get(digest)!.envelope) as AnyDsseEnvelope;
    expect(envelopeDisallowedContent(envelope)).toBeNull();

    // A release statement held under a key that is not a digest, such as a line of the release's log, would put that
    // line into the record: the comparison refuses it and records no intent.
    const line = "release v1.2.3: build passed, 2 artifacts uploaded";
    const t = await settle([{ ...cloud, envelopeDigest: line }, repro], provenance);
    expect(failureOf(await t.run())).toMatchObject({
      _tag: "StatementContentRefused",
      path: "$.envelope_digests[0]",
    });
    expect(t.store.intents.size).toBe(2);
  });

  it("[FD-PROV-067] differing subject digests refuse the publish with `provenance: reproduction mismatch` and raise a page alarm", async () => {
    const { provenance, cloud, reproduction } = await fixture();
    for (const digests of [[ARCHIVE, sha("7")], [ARCHIVE], [ARCHIVE, SBOM, sha("7")]]) {
      const repro = await reproduction(digests);
      const s = await settle([cloud, repro], provenance);
      expect(failureOf(await s.run())).toMatchObject({
        _tag: "ReproductionRefused",
        conclusion: "failure",
        reason: REPRODUCTION_MISMATCH,
        releaseExecutionId: RELEASE_ID,
        reproductionExecutionId: REPRO_ID,
        releaseEnvelopeDigest: cloud.envelopeDigest,
        reproductionEnvelopeDigest: repro.envelopeDigest,
      });
      expect(s.alarms).toMatchObject([
        { name: "reproduction-mismatch", severity: "page", state: "raised", dedupeKey: `reproduction:${RELEASE_ID}` },
      ]);
      // No reproduction record is written for a mismatch.
      expect(s.store.intents.size).toBe(2);
    }
  });
});
