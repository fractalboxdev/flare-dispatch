// The verification policy and the control plane's key history: publishing a policy version through the transparency
// log before it is served, serving the current and every earlier version, the key-history checks, the provenance-key
// rotation and the `managed-workstation` SLSA cap. The stores are the D1 stores under Miniflare; the transparency log
// is a recording double whose failures the suite sets.
import { Effect, Exit, Layer } from "effect";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, utf8 } from "../crypto.ts";
import { failureOf, startMiniflare } from "../support.test-support.ts";
import { LogAppendFailed, type LogEntry } from "./append.ts";
import {
  DSSE_PAYLOAD_TYPE,
  dssePae,
  parseProvenanceKey,
  signPae,
  unsignedEnvelope,
  type ProvenanceKey,
} from "./dsse.ts";
import {
  d1KeyHistoryStore,
  d1PolicyStore,
  KeyHistoryStore,
  keyUse,
  POLICY_PAYLOAD_TYPE,
  PolicyStore,
  PolicyTransparencyLog,
  publishPolicy,
  recordedKeys,
  servedPolicy,
  useKey,
  type KeyHistoryEntry,
  type KeysInUse,
  type VerificationPolicy,
} from "./policy.ts";

const keyPair = async (kid: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return parseProvenanceKey(JSON.stringify({ ...priv, kid }))!;
};

const entryOf = (key: ProvenanceKey, notBefore: number, notAfter?: number): KeyHistoryEntry => ({
  kid: key.kid,
  jwk: { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
  not_before: notBefore,
  ...(notAfter === undefined ? {} : { not_after: notAfter }),
});

const T0 = Date.UTC(2026, 10, 1);

const policy = (overrides: Partial<VerificationPolicy> = {}): VerificationPolicy => ({
  policy_version: "2026-11-01",
  issued_at: T0,
  provenance_keys: [],
  logs: [
    {
      kind: "private",
      keys: [],
      witnesses: [{ name: "witness-1", key: "witness-1+abc", url: "https://witness.example" }],
    },
  ],
  devices: [],
  required_tiers: {
    release: "reproduced",
    package: "platform",
    image: "platform",
    "pr-artifact": "platform",
    preview: "platform",
    verdict: "device-signed",
  },
  slsa_build_levels: { cloud: 3, "attested-dedicated": 2, "managed-workstation": 1 },
  ...overrides,
});

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** The operator's envelope: the policy signed by the policy root key, which the control plane never holds. */
const envelopeOf = async (root: ProvenanceKey, p: VerificationPolicy) => {
  const payload = utf8(JSON.stringify(p));
  return {
    payloadType: POLICY_PAYLOAD_TYPE,
    payload: toBase64(payload),
    signatures: [await signPae(root, dssePae(POLICY_PAYLOAD_TYPE, payload))],
  };
};

let mf: Miniflare;
let db: D1Database;
let root: ProvenanceKey;
let provA: ProvenanceKey;
let provB: ProvenanceKey;
let logKey: ProvenanceKey;

/** What the recording log saw, and the failure its next append answers. */
const log = { appended: [] as string[], fail: undefined as string | undefined, now: T0 };
let onAppend: (() => Effect.Effect<void>) | undefined;

const services = () =>
  Layer.mergeAll(
    Layer.succeed(PolicyStore)(d1PolicyStore(db)),
    Layer.succeed(KeyHistoryStore)(d1KeyHistoryStore(db)),
    Layer.succeed(PolicyTransparencyLog)({
      append: (json) =>
        Effect.gen(function* () {
          if (onAppend !== undefined) yield* onAppend();
          if (log.fail !== undefined)
            return yield* Effect.fail(new LogAppendFailed({ log: "private", message: log.fail }));
          log.appended.push(json);
          return {
            log: "private",
            logIndex: log.appended.length - 1,
            entryId: `leaf-${log.appended.length - 1}`,
            integratedTime: log.now,
          } satisfies LogEntry;
        }),
    }),
  );

const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.runPromiseExit(Effect.provide(effect, services()) as Effect.Effect<A, E>);
const ok = async <A, E>(effect: Effect.Effect<A, E, any>) => {
  const exit = await run(effect);
  if (Exit.isFailure(exit))
    throw new Error(`expected success, got ${JSON.stringify(failureOf(exit))}`);
  return exit.value;
};
const fails = async <A, E>(effect: Effect.Effect<A, E, any>) => {
  const exit = await run(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  return failureOf(exit) as Record<string, unknown>;
};

const noKeys: KeysInUse = { provenance: undefined, log: undefined };

beforeAll(async () => {
  ({ mf, db } = await startMiniflare());
  [root, provA, provB, logKey] = (await Promise.all(
    ["policy-root", "prov-a", "prov-b", "log-1"].map(keyPair),
  )) as [ProvenanceKey, ProvenanceKey, ProvenanceKey, ProvenanceKey];
});

afterAll(async () => {
  await mf?.dispose();
});

beforeEach(async () => {
  await ok(Effect.flatMap(PolicyStore, (s) => s.current()));
  for (const table of ["provenance_policies", "provenance_key_history"])
    await db.prepare(`delete from ${table}`).run();
  log.appended.length = 0;
  log.fail = undefined;
  log.now = T0;
  onAppend = undefined;
});

describe("publishing and serving the verification policy", () => {
  it("[FD-PROV-044] serves the latest logged version as current and every earlier version by its policy_version", async () => {
    const first = await envelopeOf(root, policy({ policy_version: "v1" }));
    const second = await envelopeOf(root, policy({ policy_version: "v2", issued_at: T0 + 1 }));
    await ok(publishPolicy(first, noKeys, T0));
    expect(await ok(servedPolicy(undefined))).toEqual(first);
    await ok(publishPolicy(second, noKeys, T0 + 1));
    expect(await ok(servedPolicy(undefined))).toEqual(second);
    expect(await ok(servedPolicy("v1"))).toEqual(first);
    expect(await ok(servedPolicy("v2"))).toEqual(second);
    expect((await fails(servedPolicy("v3")))["_tag"]).toBe("PolicyNotFound");
  });

  it("[FD-PROV-046] appends a published version to the transparency log before it is served", async () => {
    const envelope = await envelopeOf(root, policy({ policy_version: "v1" }));
    const seenDuringAppend: unknown[] = [];
    onAppend = () =>
      Effect.exit(servedPolicy("v1")).pipe(
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            seenDuringAppend.push(failureOf(exit)?._tag ?? "served");
          }),
        ),
        Effect.provideService(PolicyStore, d1PolicyStore(db)),
      );
    const published = await ok(publishPolicy(envelope, noKeys, T0));
    expect(seenDuringAppend).toEqual(["PolicyNotFound"]);
    expect(log.appended).toHaveLength(1);
    expect(JSON.parse(log.appended[0]!)).toEqual(envelope);
    expect(published.entry.logIndex).toBe(0);
    expect(await ok(servedPolicy("v1"))).toEqual(envelope);
  });

  it("[FD-PROV-046] a version whose log append fails is not served, and publishing it again appends it once", async () => {
    const envelope = await envelopeOf(root, policy({ policy_version: "v1" }));
    log.fail = "rekor unreachable";
    expect((await fails(publishPolicy(envelope, noKeys, T0)))["_tag"]).toBe("LogAppendFailed");
    expect((await fails(servedPolicy("v1")))["_tag"]).toBe("PolicyNotFound");
    expect((await fails(servedPolicy(undefined)))["_tag"]).toBe("PolicyNotFound");
    log.fail = undefined;
    await ok(publishPolicy(envelope, noKeys, T0 + 5));
    await ok(publishPolicy(envelope, noKeys, T0 + 6));
    expect(log.appended).toHaveLength(1);
    expect(await ok(servedPolicy(undefined))).toEqual(envelope);
  });

  it("refuses a second envelope under a published policy_version", async () => {
    await ok(publishPolicy(await envelopeOf(root, policy({ policy_version: "v1" })), noKeys, T0));
    const other = await envelopeOf(root, policy({ policy_version: "v1", issued_at: T0 + 9 }));
    expect(await fails(publishPolicy(other, noKeys, T0 + 9))).toMatchObject({
      _tag: "PolicyRefused",
      reason: "version-exists",
    });
  });

  it("refuses an envelope that is not a signed policy", async () => {
    const unsigned = { ...(await envelopeOf(root, policy())), signatures: [] };
    expect(await fails(publishPolicy(unsigned, noKeys, T0))).toMatchObject({ reason: "malformed" });
    const statement = { ...unsignedEnvelope(utf8("{}")), signatures: [{ keyid: "k", sig: "s" }] };
    expect(statement.payloadType).toBe(DSSE_PAYLOAD_TYPE);
    expect(await fails(publishPolicy(statement, noKeys, T0))).toMatchObject({
      reason: "malformed",
    });
  });
});

describe("the managed-workstation SLSA cap", () => {
  it("[FD-PROV-052] refuses to publish a policy that lets a managed-workstation builder claim above L1, and logs nothing", async () => {
    for (const level of [2, 3] as const) {
      const p = policy({
        policy_version: `ws-l${level}`,
        slsa_build_levels: { cloud: 3, "attested-dedicated": 3, "managed-workstation": level },
      });
      expect(await fails(publishPolicy(await envelopeOf(root, p), noKeys, T0))).toMatchObject({
        _tag: "PolicyRefused",
        reason: "slsa-level",
      });
      expect((await fails(servedPolicy(p.policy_version)))["_tag"]).toBe("PolicyNotFound");
    }
    expect(log.appended).toHaveLength(0);
    const capped = policy({
      policy_version: "ws-l1",
      slsa_build_levels: { cloud: 3, "attested-dedicated": 3, "managed-workstation": 1 },
    });
    await ok(publishPolicy(await envelopeOf(root, capped), noKeys, T0));
    expect(log.appended).toHaveLength(1);
  });

  it("[FD-PROV-052] refuses to serve a stored version that lets a managed-workstation builder claim above L1", async () => {
    const p = policy({
      policy_version: "stored-l2",
      slsa_build_levels: { cloud: 3, "attested-dedicated": 2, "managed-workstation": 2 },
    });
    const json = JSON.stringify(await envelopeOf(root, p));
    await ok(
      Effect.gen(function* () {
        const store = yield* PolicyStore;
        yield* store.insert("stored-l2", json, T0);
        yield* store.logged("stored-l2", {
          log: "private",
          logIndex: 0,
          entryId: "leaf-0",
          integratedTime: T0,
        });
      }),
    );
    expect(await fails(servedPolicy("stored-l2"))).toMatchObject({ reason: "slsa-level" });
    expect(await fails(servedPolicy(undefined))).toMatchObject({ reason: "slsa-level" });
  });
});

describe("the key history", () => {
  it("[FD-PROV-047] keeps every provenance and log key the control plane used, and never removes an entry", async () => {
    await ok(useKey("provenance", provA, T0));
    await ok(useKey("log", logKey, T0));
    await ok(useKey("provenance", provB, T0 + 100));
    await ok(useKey("provenance", provB, T0 + 200));
    const history = await ok(
      Effect.gen(function* () {
        const store = yield* KeyHistoryStore;
        return { provenance: yield* store.entries("provenance"), log: yield* store.entries("log") };
      }),
    );
    expect(history.provenance).toEqual([entryOf(provA, T0, T0 + 100), entryOf(provB, T0 + 100)]);
    expect(history.log).toEqual([entryOf(logKey, T0)]);
    const { results } = await db
      .prepare("select count(*) as n from provenance_key_history")
      .all<{ n: number }>();
    expect(results[0]!.n).toBe(3);
  });

  it("[FD-PROV-047] refuses a policy version that drops or changes an entry of the previous version's key history", async () => {
    const first = policy({
      policy_version: "v1",
      provenance_keys: [entryOf(provA, T0)],
      logs: [{ kind: "private", keys: [entryOf(logKey, T0)] }],
    });
    await ok(publishPolicy(await envelopeOf(root, first), noKeys, T0));
    const attempts: VerificationPolicy[] = [
      { ...first, policy_version: "drops-prov", provenance_keys: [entryOf(provB, T0 + 1)] },
      { ...first, policy_version: "drops-log", logs: [{ kind: "private", keys: [] }] },
      { ...first, policy_version: "moves-window", provenance_keys: [entryOf(provA, T0 + 1)] },
      {
        ...first,
        policy_version: "swaps-key",
        provenance_keys: [{ ...entryOf(provB, T0), kid: provA.kid }],
      },
    ];
    for (const next of attempts)
      expect(
        await fails(publishPolicy(await envelopeOf(root, next), noKeys, T0 + 1)),
      ).toMatchObject({
        _tag: "PolicyRefused",
        reason: "key-history",
      });
    const retired = await envelopeOf(root, {
      ...first,
      policy_version: "v2",
      provenance_keys: [entryOf(provA, T0, T0 + 50), entryOf(provB, T0 + 50)],
    });
    await ok(publishPolicy(retired, noKeys, T0 + 60));
    const reopened = await envelopeOf(root, {
      ...first,
      policy_version: "v3",
      provenance_keys: [entryOf(provA, T0), entryOf(provB, T0 + 50)],
    });
    expect(await fails(publishPolicy(reopened, noKeys, T0 + 70))).toMatchObject({
      reason: "key-history",
    });
  });

  it("[FD-PROV-047] refuses a policy whose key history omits or misstates a key the control plane has used, naming the entry it expects", async () => {
    // The operator signs offline, before the publish whose instant opens each held key's window.
    const keys: KeysInUse = { provenance: provA, log: logKey };
    const omits = policy({ policy_version: "omits", provenance_keys: [] });
    const refusal = await fails(publishPolicy(await envelopeOf(root, omits), keys, T0 + 7));
    expect(refusal).toMatchObject({ reason: "key-history" });
    const recorded = await ok(recordedKeys);
    expect(recorded).toEqual({
      provenance: [entryOf(provA, T0 + 7)],
      log: [entryOf(logKey, T0 + 7)],
    });
    for (const expected of [...recorded.provenance, ...recorded.log])
      expect(String(refusal["message"])).toContain(`expected ${canonicalJson(expected)}`);
    const guessed = policy({
      policy_version: "guessed",
      provenance_keys: [entryOf(provA, T0)],
      logs: [{ kind: "private", keys: [entryOf(logKey, T0)] }],
    });
    expect(await fails(publishPolicy(await envelopeOf(root, guessed), keys, T0 + 9))).toMatchObject(
      { reason: "key-history" },
    );
    const complete = policy({
      policy_version: "complete",
      provenance_keys: [...recorded.provenance],
      logs: [{ kind: "private", keys: [...recorded.log] }],
    });
    await ok(publishPolicy(await envelopeOf(root, complete), keys, T0 + 10));
    // A rotation retires the old key at the publish that first holds the new one; that publish is refused, and the
    // next one carries the windows the control plane recorded.
    const rotated = { provenance: provB, log: logKey };
    const stale = policy({
      policy_version: "rotated",
      provenance_keys: [...recorded.provenance],
      logs: [{ kind: "private", keys: [...recorded.log] }],
    });
    expect(
      await fails(publishPolicy(await envelopeOf(root, stale), rotated, T0 + 110)),
    ).toMatchObject({ reason: "key-history" });
    const after = await ok(recordedKeys);
    expect(after.provenance).toEqual([entryOf(provA, T0 + 7, T0 + 110), entryOf(provB, T0 + 110)]);
    const current = policy({
      policy_version: "rotated",
      provenance_keys: [...after.provenance],
      logs: [{ kind: "private", keys: [...after.log] }],
    });
    await ok(publishPolicy(await envelopeOf(root, current), rotated, T0 + 120));
  });

  it("[FD-PROV-047] refuses a key history that lists a kid twice, so no verifier picks between two windows", async () => {
    const keys: KeysInUse = { provenance: provA, log: logKey };
    await fails(
      publishPolicy(await envelopeOf(root, policy({ policy_version: "probe" })), keys, T0),
    );
    const { provenance, log: logEntries } = await ok(recordedKeys);
    const wider = { ...provenance[0]!, not_before: 0 };
    const twice = policy({
      policy_version: "twice",
      provenance_keys: [...provenance, wider],
      logs: [{ kind: "private", keys: [...logEntries] }],
    });
    const refusal = await fails(publishPolicy(await envelopeOf(root, twice), keys, T0 + 1));
    expect(refusal).toMatchObject({ reason: "key-history" });
    expect(String(refusal["message"])).toContain(`repeats key ${provA.kid}`);
    const logTwice = policy({
      policy_version: "log-twice",
      provenance_keys: [...provenance],
      logs: [
        { kind: "private", keys: [...logEntries] },
        { kind: "private", keys: [...logEntries] },
      ],
    });
    expect(
      String(
        (await fails(publishPolicy(await envelopeOf(root, logTwice), keys, T0 + 1)))["message"],
      ),
    ).toContain(`repeats key ${logKey.kid}`);
    expect(log.appended).toHaveLength(0);
  });
});

describe("provenance-key rotation", () => {
  it("[FD-PROV-048] sets the retired key's not_after to the new key's not_before, the instant of rotation", async () => {
    const history = [entryOf(provA, T0)];
    const use = await Effect.runPromise(
      keyUse("provenance", history, { kid: provB.kid, jwk: entryOf(provB, 0).jwk }, T0 + 500),
    );
    expect(use.retire).toEqual(entryOf(provA, T0, T0 + 500));
    expect(use.insert).toEqual(entryOf(provB, T0 + 500));
    expect(use.retire?.not_after).toBe(use.insert?.not_before);
  });
});
