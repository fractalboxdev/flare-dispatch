// The transparency-log append of a countersigned statement: the log-append intent keyed by the envelope digest, the
// visibility routing between Rekor and the private log, and the statement's time from its log entry. The private log
// is the `TransparencyLog` Durable Object under Miniflare, the intents live in its D1 database, and Rekor is a recorded
// fake of its `/api/v1/log/entries` API that, as Rekor's `dsse` type does, verifies every envelope signature against
// the proposed PEM verifiers with a DER ECDSA verifier and answers 400 when one does not verify.
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { Effect, Layer, Option } from "effect";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, utf8 } from "../crypto.ts";
import type { Bucket } from "../manifest.ts";
import { startMiniflare } from "../support.test-support.ts";
import {
  applyLogAppend,
  countersignAndAppend,
  d1LogAppendStore,
  drainLogAppends,
  enqueueLogAppend,
  LogAppendStatus,
  LogAppendStore,
  privateLogAppend,
  RepositoryVisibility,
  statementSummaryLine,
  statementTime,
  TransparencyLogs,
  VisibilityUnreadable,
  type LogAppendIntent,
} from "./append.ts";
import { CountersignOutcome, StatementBinding } from "./countersign.ts";
import {
  DSSE_PAYLOAD_TYPE,
  dssePae,
  parseProvenanceKey,
  signPae,
  unsignedEnvelope,
  type DsseEnvelope,
  type ProvenanceKey,
} from "./dsse.ts";
import type { AppendOutcome } from "./log.ts";
import { leafPath } from "./merkle.ts";
import { publicKeyPem, rekorAppend } from "./rekor.ts";

const keyPair = async (kid: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { private: parseProvenanceKey(JSON.stringify({ ...priv, kid }))!, public: pub };
};

/** A device-signed envelope whose payload claims the executor's own finish time. */
const deviceEnvelope = async (
  device: ProvenanceKey,
  executionId: string,
): Promise<DsseEnvelope> => {
  const payload = utf8(
    JSON.stringify({
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "commit", digest: { gitCommit: "a".repeat(40) } }],
      predicate: {
        buildDefinition: { internalParameters: { lease: { execution_id: executionId } } },
        runDetails: { metadata: { finishedOn: "2031-01-01T00:00:00Z" } },
      },
    }),
  );
  return {
    ...unsignedEnvelope(payload),
    signatures: [await signPae(device, dssePae(DSSE_PAYLOAD_TYPE, payload))],
  };
};

const REKOR_URL = "https://rekor.test";

/**
 * Whether every signature of a proposed envelope verifies, as an ASN.1 DER ECDSA signature over the envelope's
 * pre-authentication encoding, against one of the proposed base64 PEM verifiers: Rekor's `dsse` check (sigstore's
 * ECDSAVerifier, `ecdsa.VerifyASN1`).
 */
const rekorVerifies = (envelopeJson: string, verifiers: readonly string[]): boolean => {
  let envelope: DsseEnvelope;
  try {
    envelope = JSON.parse(envelopeJson) as DsseEnvelope;
  } catch {
    return false;
  }
  if (!Array.isArray(envelope.signatures) || typeof envelope.payload !== "string") return false;
  const pae = dssePae(envelope.payloadType, Buffer.from(envelope.payload, "base64"));
  const keys = verifiers.map((v) => createPublicKey(Buffer.from(v, "base64").toString("utf8")));
  return (
    envelope.signatures.length > 0 &&
    envelope.signatures.every((sig) =>
      keys.some((key) =>
        verifySignature("sha256", pae, { key, dsaEncoding: "der" }, Buffer.from(sig.sig, "base64")),
      ),
    )
  );
};

interface RekorCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

/**
 * A fake Rekor: `POST /api/v1/log/entries` answers 201 with a new entry, or 409 with its location for an envelope it
 * already holds; `GET` on that location answers the entry. `failNext` makes the next POSTs answer 503.
 */
const fakeRekor = (integratedTime = 1_700_000_000) => {
  const calls: RekorCall[] = [];
  const entries = new Map<string, { uuid: string; logIndex: number }>();
  const state = { failNext: 0 };
  const entryBody = (uuid: string, logIndex: number) => ({
    [uuid]: { body: "e30=", integratedTime, logID: "c0ffee", logIndex },
  });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url, body });
    if (method === "POST") {
      if (state.failNext > 0) {
        state.failNext--;
        return new Response("unavailable", { status: 503 });
      }
      const { envelope, verifiers } = (
        body as { spec: { proposedContent: { envelope: string; verifiers: string[] } } }
      ).spec.proposedContent;
      if (!rekorVerifies(envelope, verifiers))
        return Response.json(
          { code: 400, message: "verifying signatures: invalid signature when validating ASN.1 encoded signature" },
          { status: 400 },
        );
      const existing = entries.get(envelope);
      if (existing !== undefined)
        return new Response("{}", {
          status: 409,
          headers: { location: `/api/v1/log/entries/${existing.uuid}` },
        });
      const created = { uuid: `uuid-${entries.size}`, logIndex: 1000 + entries.size };
      entries.set(envelope, created);
      return Response.json(entryBody(created.uuid, created.logIndex), { status: 201 });
    }
    const uuid = url.split("/").pop()!;
    const found = [...entries.values()].find((e) => e.uuid === uuid);
    return found === undefined
      ? new Response("missing", { status: 404 })
      : Response.json(entryBody(found.uuid, found.logIndex));
  }) as typeof globalThis.fetch;
  return { fetch, calls, state };
};

interface LogStub {
  append(entry: Uint8Array): Promise<AppendOutcome>;
  size(): Promise<number>;
  usePrefix(prefix: string): Promise<void>;
}

describe("the transparency-log append of a countersigned statement", () => {
  let mf: Miniflare;
  let bucket: Bucket;
  let db: D1Database;
  let device: Awaited<ReturnType<typeof keyPair>>;
  let provenance: Awaited<ReturnType<typeof keyPair>>;
  let logs = 0;

  beforeAll(async () => {
    device = await keyPair("device-1");
    provenance = await keyPair("prov-2026-11");
    const logKey = await keyPair("log-key-1");
    ({ mf, bucket, db } = await startMiniflare({ LOG_KEY: JSON.stringify(logKey.private) }));
  });
  afterAll(async () => {
    await mf?.dispose();
  });

  /** A private log of its own under a fresh prefix, a fake Rekor, and the visibility each repository reports. */
  const plane = async (visibility: Record<string, string>) => {
    const n = ++logs;
    const visibilityReads: string[] = [];
    const ns = (await mf.getDurableObjectNamespace(
      "TRANSPARENCY_LOG",
    )) as unknown as DurableObjectNamespace;
    const log = ns.get(ns.idFromName(`append-${n}`)) as unknown as LogStub;
    const prefix = `append${n}/`;
    await log.usePrefix(prefix);
    const rekor = fakeRekor();
    const store = d1LogAppendStore(db);
    const layer = Layer.mergeAll(
      Layer.succeed(LogAppendStore, store),
      Layer.succeed(RepositoryVisibility, {
        of: (repository: string) =>
          (visibilityReads.push(repository), repository in visibility)
            ? Effect.succeed(visibility[repository]!)
            : Effect.fail(new VisibilityUnreadable({ repository, message: "404 Not Found" })),
      }),
      Layer.succeed(TransparencyLogs, {
        rekor: rekorAppend({ url: REKOR_URL, fetch: rekor.fetch }),
        private: privateLogAppend(log),
      }),
    );
    const run = <A, E>(
      effect: Effect.Effect<A, E, LogAppendStore | RepositoryVisibility | TransparencyLogs>,
    ) => Effect.runPromise(Effect.provide(effect, layer));
    const leaf = async (index: number) => {
      const got = await bucket.get(`${prefix}${leafPath(index)}`);
      return got === null ? null : await got.text();
    };
    return { log, rekor, store, run, leaf, visibility, visibilityReads };
  };

  let executions = 0;
  /** Countersigns a fresh device statement of `repository` and records its intent. */
  const countersigned = async (
    p: Awaited<ReturnType<typeof plane>>,
    repository: string,
    now = 1_000,
  ) => {
    const executionId = `exec-append-${++executions}`;
    const submitted = await deviceEnvelope(device.private, executionId);
    const { outcome, intent } = await p.run(
      countersignAndAppend(
        submitted,
        StatementBinding.ExecutionLease({ executionId, epoch: 1 }),
        provenance.private,
        { executionId, repository, deviceKey: device.public },
        now,
      ),
    );
    if (!CountersignOutcome.$is("Countersigned")(outcome) || intent === undefined)
      throw new Error("the statement was not countersigned");
    return { executionId, envelope: outcome.envelope, intent };
  };

  const get = async (
    p: Awaited<ReturnType<typeof plane>>,
    digest: string,
  ): Promise<LogAppendIntent> => {
    const intent = await p.run(Effect.flatMap(LogAppendStore, (s) => s.get(digest)));
    if (intent === null) throw new Error(`no intent ${digest}`);
    return intent;
  };

  it("[FD-PROV-034] countersigning a statement records one log-append intent keyed by the countersigned envelope's digest, and a repeat of the step with that envelope records no second one", async () => {
    const p = await plane({ "acme/widgets": "private" });
    const { executionId, envelope, intent } = await countersigned(p, "acme/widgets");
    const json = canonicalJson(envelope);
    expect(intent).toEqual({
      digest: `sha256:${await sha256Hex(utf8(json))}`,
      log: "private",
      inserted: true,
    });
    // The envelope the intent holds is the countersigned one: the device signature and the provenance key's.
    const recorded = await get(p, intent.digest);
    expect(recorded.envelope).toBe(json);
    expect(JSON.parse(recorded.envelope).signatures.map((s: { keyid: string }) => s.keyid)).toEqual(
      ["device-1", "prov-2026-11"],
    );
    expect(recorded.status).toEqual(
      LogAppendStatus.Pending({ attempts: 0, nextAttemptAt: 1_000, lastError: null }),
    );

    // The step again with the same countersigned envelope, as a replay whose journal holds it: no second intent, and
    // the log the intent names, without a second visibility read, even after the repository turned public.
    expect(p.visibilityReads).toEqual(["acme/widgets"]);
    p.visibility["acme/widgets"] = "public";
    const again = await p.run(
      enqueueLogAppend(
        { envelope, executionId, repository: "acme/widgets", verifiers: [device.public] },
        2_000,
      ),
    );
    expect(again).toEqual({ digest: intent.digest, log: "private", inserted: false });
    expect(p.visibilityReads).toEqual(["acme/widgets"]);
    const intents = await p.run(Effect.flatMap(LogAppendStore, (s) => s.forExecution(executionId)));
    expect(intents.map((i) => i.envelopeDigest)).toEqual([intent.digest]);

    // Applying the intent twice appends the envelope once.
    await p.run(applyLogAppend(intent.digest, 1_000));
    await p.run(applyLogAppend(intent.digest, 5_000));
    expect(await p.log.size()).toBe(1);
    expect(await p.leaf(0)).toBe(json);
  });

  it("[FD-PROV-034] a statement left advisory is not countersigned and records no log-append intent", async () => {
    const p = await plane({ "acme/widgets": "public" });
    const executionId = `exec-append-${++executions}`;
    const submitted = await deviceEnvelope(device.private, executionId);
    const { outcome, intent } = await p.run(
      countersignAndAppend(
        submitted,
        StatementBinding.UnregisteredCapacityLease({ leaseId: "cap-1", epoch: 1 }),
        provenance.private,
        { executionId, repository: "acme/widgets", deviceKey: device.public },
        1_000,
      ),
    );
    expect(CountersignOutcome.$is("Advisory")(outcome)).toBe(true);
    expect(intent).toBeUndefined();
    expect(await p.run(Effect.flatMap(LogAppendStore, (s) => s.forExecution(executionId)))).toEqual(
      [],
    );
    await p.run(drainLogAppends(10_000_000));
    expect(p.rekor.calls).toEqual([]);
  });

  it("[FD-PROV-035] a public repository's statement is appended to Rekor as a dsse entry with the countersigned envelope and its signers' keys, and never to the private log", async () => {
    const p = await plane({ "acme/open": "public" });
    const { envelope, intent } = await countersigned(p, "acme/open");
    expect(intent.log).toBe("rekor");
    await p.run(drainLogAppends(1_000));

    expect(p.rekor.calls).toHaveLength(1);
    const [call] = p.rekor.calls;
    expect(call).toMatchObject({ method: "POST", url: `${REKOR_URL}/api/v1/log/entries` });
    const proposed = call!.body as {
      apiVersion: string;
      kind: string;
      spec: { proposedContent: { envelope: string; verifiers: string[] } };
    };
    expect(proposed.kind).toBe("dsse");
    expect(proposed.apiVersion).toBe("0.0.1");
    expect(proposed.spec.proposedContent.envelope).toBe(canonicalJson(envelope));
    expect(proposed.spec.proposedContent.verifiers.map((v) => atob(v))).toEqual([
      await publicKeyPem(device.public),
      await publicKeyPem(provenance.public),
    ]);
    // Each signature of the envelope as sent verifies as ASN.1 DER against its signer's PEM verifier, as Rekor checks
    // it; the same signature read as IEEE P1363 does not.
    const [deviceVerifier, provenanceVerifier] = proposed.spec.proposedContent.verifiers.map((v) =>
      createPublicKey(atob(v)),
    );
    const sent = JSON.parse(proposed.spec.proposedContent.envelope) as DsseEnvelope;
    const pae = dssePae(sent.payloadType, Buffer.from(sent.payload, "base64"));
    const sigs = sent.signatures.map((s) => Buffer.from(s.sig, "base64"));
    expect(sent.signatures.map((s) => s.keyid)).toEqual(["device-1", "prov-2026-11"]);
    for (const [key, sig] of [
      [deviceVerifier!, sigs[0]!],
      [provenanceVerifier!, sigs[1]!],
    ] as const) {
      expect(verifySignature("sha256", pae, { key, dsaEncoding: "der" }, sig)).toBe(true);
      expect(verifySignature("sha256", pae, { key, dsaEncoding: "ieee-p1363" }, sig)).toBe(false);
    }
    expect(await p.log.size()).toBe(0);

    const logged = await get(p, intent.digest);
    expect(logged.status).toEqual(
      LogAppendStatus.Logged({
        attempts: 1,
        entry: {
          log: "rekor",
          logIndex: 1000,
          entryId: "uuid-0",
          integratedTime: 1_700_000_000_000,
        },
      }),
    );
  });

  it("[FD-PROV-035] an append Rekor already holds answers the existing entry it reads back from the 409's location", async () => {
    const rekor = fakeRekor();
    const append = rekorAppend({ url: REKOR_URL, fetch: rekor.fetch });
    const json = canonicalJson(await deviceEnvelope(device.private, "exec-append-409"));
    const first = await Effect.runPromise(append(json, [device.public]));
    const second = await Effect.runPromise(append(json, [device.public]));
    expect(second).toEqual(first);
    expect(rekor.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${REKOR_URL}/api/v1/log/entries`,
      `POST ${REKOR_URL}/api/v1/log/entries`,
      `GET ${REKOR_URL}/api/v1/log/entries/uuid-0`,
    ]);
  });

  it("[FD-PROV-036] a private or internal repository's statement, and one whose visibility cannot be read, is appended to the private log in R2 and never to Rekor", async () => {
    const p = await plane({ "acme/closed": "private", "acme/inner": "internal" });
    const appended: string[] = [];
    for (const repository of ["acme/closed", "acme/inner", "acme/unreadable"]) {
      const { envelope, intent } = await countersigned(p, repository);
      expect(intent.log).toBe("private");
      appended.push(canonicalJson(envelope));
    }
    await p.run(drainLogAppends(1_000));
    expect(p.rekor.calls).toEqual([]);
    expect(await p.log.size()).toBe(3);
    // Each envelope is a leaf of the private log, in the R2 bucket.
    const leaves = await Promise.all([0, 1, 2].map((i) => p.leaf(i)));
    expect(new Set(leaves)).toEqual(new Set(appended));
  });

  it("[FD-PROV-040] a statement's time is its log entry's integrated time, not the executor's claimed time nor the time of the append attempt", async () => {
    // Rekor's integrated time, in seconds.
    const p = await plane({ "acme/open": "public", "acme/closed": "private" });
    const publicStatement = await countersigned(p, "acme/open", 1_000);
    expect(statementTime(await get(p, publicStatement.intent.digest))).toEqual(Option.none());
    expect(statementSummaryLine(await get(p, publicStatement.intent.digest))).toContain(
      "log-pending",
    );
    await p.run(applyLogAppend(publicStatement.intent.digest, 1_800_000_000_000));
    const logged = await get(p, publicStatement.intent.digest);
    expect(statementTime(logged)).toEqual(Option.some(1_700_000_000_000));
    expect(statementSummaryLine(logged)).toContain(new Date(1_700_000_000_000).toISOString());
    expect(statementSummaryLine(logged)).not.toContain("2031-01-01");

    // The private log's integrated time is the log object's clock at the leaf's first append.
    const before = Date.now();
    const privateStatement = await countersigned(p, "acme/closed", 1_000);
    await p.run(applyLogAppend(privateStatement.intent.digest, 5_000_000_000_000));
    const after = Date.now();
    const time = Option.getOrThrow(statementTime(await get(p, privateStatement.intent.digest)));
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(after);
    // A later append of the same envelope answers the leaf's first integrated time.
    const repeat = await p.log.append(utf8(canonicalJson(privateStatement.envelope)));
    expect(repeat).toMatchObject({ _tag: "Appended", duplicate: true, integratedAt: time });
  });
});
