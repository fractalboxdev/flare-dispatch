// The private log's witnesses: RFC 9162 consistency proofs over the stored hashes, the C2SP tlog-witness request, and
// a witness round that sends the published checkpoint to each policy witness and writes each verified cosignature onto
// it, against the Miniflare R2 bucket and witnesses that answer as C2SP tlog-witness specifies.
import { Effect } from "effect";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hex, utf8 } from "../crypto.ts";
import type { Bucket } from "../manifest.ts";
import { emptyBucket, startMiniflare } from "../support.test-support.ts";
import { fromBase64, parseProvenanceKey, type ProvenanceKey } from "./dsse.ts";
import {
  CHECKPOINT_PATH,
  checkpointBody,
  consistencyProof,
  leafHash,
  nodeHash,
  parseCheckpoint,
  signCheckpoint,
  storedHashesForAppend,
  toBase64,
  treeHead,
  verifyConsistency,
  type ReadStoredHash,
} from "./merkle.ts";
import type { PolicyWitness } from "./policy.ts";
import {
  addCheckpointBody,
  cosignCheckpoint,
  parseWitnessKey,
  verifyCosignature,
  witnessRetryDelay,
  WITNESS_RETRY_MAX_MS,
  WITNESS_RETRY_MIN_MS,
  type WitnessFetch,
  type WitnessState,
} from "./witness.ts";
import { witnessOf, type Witness } from "./witness.test-support.ts";

const storedTree = async (entries: readonly Uint8Array[]) => {
  const stored = new Map<string, Uint8Array>();
  const read: ReadStoredHash = (level, index) => {
    const hash = stored.get(`${level}/${index}`);
    if (hash === undefined) throw new Error(`no stored hash ${level}/${index}`);
    return hash;
  };
  for (const [index, entry] of entries.entries())
    for (const h of await storedHashesForAppend(index, await leafHash(entry), read))
      stored.set(`${h.level}/${h.index}`, h.hash);
  return read;
};

const mth = async (entries: readonly Uint8Array[]): Promise<Uint8Array> => {
  if (entries.length === 0)
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array()));
  if (entries.length === 1) return leafHash(entries[0]!);
  let k = 1;
  while (k * 2 < entries.length) k *= 2;
  return nodeHash(await mth(entries.slice(0, k)), await mth(entries.slice(k)));
};

/** RFC 9162 § 2.1.4.1's SUBPROOF, written straight from its definition over the entries. */
const referenceProof = async (
  m: number,
  entries: readonly Uint8Array[],
  complete: boolean,
): Promise<Uint8Array[]> => {
  const n = entries.length;
  if (m === n) return complete ? [] : [await mth(entries)];
  let k = 1;
  while (k * 2 < n) k *= 2;
  return m <= k
    ? [...(await referenceProof(m, entries.slice(0, k), complete)), await mth(entries.slice(k))]
    : [...(await referenceProof(m - k, entries.slice(k), false)), await mth(entries.slice(0, k))];
};

describe("RFC 9162 consistency proofs", () => {
  it("[FD-PROV-039] the proof over the stored hashes equals RFC 9162's SUBPROOF and verifies between every pair of sizes", async () => {
    const entries = Array.from({ length: 20 }, (_, i) => utf8(`leaf-${i}`));
    const read = await storedTree(entries);
    for (let size = 1; size <= entries.length; size++) {
      const root = await treeHead(size, read);
      for (let from = 1; from <= size; from++) {
        const proof = await consistencyProof(from, size, read);
        expect(proof.map(hex)).toEqual(
          (await referenceProof(from, entries.slice(0, size), true)).map(hex),
        );
        const fromRoot = await treeHead(from, read);
        expect(await verifyConsistency(from, size, fromRoot, root, proof)).toBe(true);
        if (proof.length > 0) {
          const bent = proof.map((p, i) =>
            i === proof.length - 1 ? Uint8Array.from(p, (b) => b ^ 1) : p,
          );
          expect(await verifyConsistency(from, size, fromRoot, root, bent)).toBe(false);
        }
        if (from < size)
          expect(
            await verifyConsistency(from, size, await leafHash(utf8("forked")), root, proof),
          ).toBe(false);
      }
    }
    expect(await consistencyProof(0, 5, read)).toEqual([]);
  });
});

/** One `add-checkpoint` request a witness received. */
interface Received {
  readonly url: string;
  readonly old: number;
  readonly proof: readonly Uint8Array[];
  readonly checkpoint: string;
}

const parseRequest = (url: string, body: string): Received => {
  const split = body.indexOf("\n\n");
  const [oldLine, ...proofLines] = body.slice(0, split).split("\n");
  return {
    url,
    old: Number(/^old (\d+)$/.exec(oldLine!)![1]),
    proof: proofLines.map((l) => fromBase64(l)!),
    checkpoint: body.slice(split + 2),
  };
};

/**
 * A witness that answers as C2SP tlog-witness specifies: `409` with its size when `old` differs from it, `422` when the
 * consistency proof does not verify, else `200` with its cosignature line. `answer` overrides what it returns.
 */
const stubWitness = (
  witness: Witness,
  received: Received[],
  options: { size?: number; root?: Uint8Array; answer?: () => Response } = {},
) => {
  let size = options.size ?? 0;
  let root = options.root;
  const handle = async (request: Received): Promise<Response> => {
    if (options.answer !== undefined) return options.answer();
    const checkpoint = parseCheckpoint(request.checkpoint)!;
    if (request.old !== size)
      return new Response(`${size}\n`, {
        status: 409,
        headers: { "content-type": "text/x.tlog.size" },
      });
    if (
      size > 0 &&
      !(await verifyConsistency(size, checkpoint.size, root!, checkpoint.root, request.proof))
    )
      return new Response("inconsistent", { status: 422 });
    size = checkpoint.size;
    root = checkpoint.root;
    return new Response(`${await witness.cosign(checkpoint.body, 1_780_000_000)}\n`);
  };
  return (url: string, body: string) => {
    const request = parseRequest(url, body);
    received.push(request);
    return handle(request);
  };
};

const ORIGIN = "ci.example.com/private-log";

describe("a witness round over the published checkpoint", () => {
  let mf: Miniflare;
  let bucket: Bucket;
  let logKey: ProvenanceKey;
  const prefix = "witness-test/";

  beforeAll(async () => {
    ({ mf, bucket } = await startMiniflare());
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    logKey = parseProvenanceKey(JSON.stringify({ ...jwk, kid: "log-1" }))!;
  });
  afterAll(async () => {
    await mf?.dispose();
  });
  beforeEach(async () => {
    await emptyBucket(bucket);
  });

  const entries = Array.from({ length: 9 }, (_, i) => utf8(`statement-${i}`));

  /** The object's state at `size` leaves, with the checkpoint it signed published. */
  const published = async (size: number, witnessed: Map<string, number> = new Map()) => {
    const read = await storedTree(entries);
    const text = await signCheckpoint(
      { origin: ORIGIN, size, root: await treeHead(size, read) },
      logKey,
    );
    await bucket.put(`${prefix}${CHECKPOINT_PATH}`, text);
    const state: WitnessState = {
      read,
      signedSize: () => size,
      witnessedSize: (w) => witnessed.get(w),
      witnessed: (w, s) => {
        witnessed.set(w, s);
      },
    };
    return { state, text, witnessed };
  };

  const routed =
    (routes: Record<string, (url: string, body: string) => Promise<Response>>): WitnessFetch =>
    async (url, init) => {
      const route = routes[new URL(url).host];
      if (route === undefined) throw new Error(`connect ECONNREFUSED ${url}`);
      return route(url, String(init.body));
    };

  const policyWitness = (w: Witness, host: string): PolicyWitness => ({
    name: w.name,
    key: w.vkey,
    url: `https://${host}/witness/`,
  });

  const run = (state: WitnessState, witnesses: readonly PolicyWitness[], fetch: WitnessFetch) =>
    Effect.runPromise(
      cosignCheckpoint(state, { bucket, prefix, witnesses: Effect.succeed(witnesses), fetch }),
    );

  const checkpointNow = async () =>
    (await (await bucket.get(`${prefix}${CHECKPOINT_PATH}`))!.text()) as string;

  it("[FD-PROV-039] sends the checkpoint to every policy witness over add-checkpoint and stores each cosignature on the published checkpoint", async () => {
    const [a, b] = [await witnessOf("witness-a.example"), await witnessOf("witness-b.example")];
    const received: Received[] = [];
    const { state, text, witnessed } = await published(5);
    const outcome = await run(
      state,
      [policyWitness(a, "a.example"), policyWitness(b, "b.example")],
      routed({ "a.example": stubWitness(a, received), "b.example": stubWitness(b, received) }),
    );
    expect(outcome).toMatchObject({
      _tag: "Witnessed",
      size: 5,
      cosigned: [a.name, b.name],
      failed: [],
    });
    expect(received.map((r) => [r.url, r.old, r.proof.length, r.checkpoint])).toEqual([
      ["https://a.example/witness/add-checkpoint", 0, 0, text],
      ["https://b.example/witness/add-checkpoint", 0, 0, text],
    ]);
    const stored = await checkpointNow();
    expect(stored.startsWith(text)).toBe(true);
    const body = checkpointBody({ origin: ORIGIN, size: 5, root: parseCheckpoint(text)!.root });
    const lines = stored
      .slice(text.length)
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    expect(await verifyCosignature(body, (await parseWitnessKey(a.vkey))!, lines[0]!)).toBe(true);
    expect(await verifyCosignature(body, (await parseWitnessKey(b.vkey))!, lines[1]!)).toBe(true);
    expect([...witnessed]).toEqual([
      [a.name, 5],
      [b.name, 5],
    ]);
    // The cosigned checkpoint still parses with its log-key line first, and a second round asks no witness again.
    expect(parseCheckpoint(stored)).toMatchObject({
      size: 5,
      signatures: [{ kid: "log-1" }, {}, {}],
    });
    received.length = 0;
    expect(
      await run(
        state,
        [policyWitness(a, "a.example"), policyWitness(b, "b.example")],
        routed({ "a.example": stubWitness(a, received), "b.example": stubWitness(b, received) }),
      ),
    ).toMatchObject({ cosigned: [], already: [a.name, b.name], failed: [] });
    expect(received).toEqual([]);
  });

  it("[FD-PROV-039] sends a grown checkpoint with the consistency proof from the size the witness last cosigned", async () => {
    const a = await witnessOf("witness-a.example");
    const read = await storedTree(entries);
    const received: Received[] = [];
    const stub = stubWitness(a, received, { size: 3, root: await treeHead(3, read) });
    const { state } = await published(9, new Map([[a.name, 3]]));
    const outcome = await run(
      state,
      [policyWitness(a, "a.example")],
      routed({ "a.example": stub }),
    );
    expect(outcome).toMatchObject({ cosigned: [a.name], failed: [] });
    expect(received).toHaveLength(1);
    expect(received[0]!.old).toBe(3);
    expect(received[0]!.proof.map(hex)).toEqual((await consistencyProof(3, 9, read)).map(hex));
  });

  it("[FD-PROV-039] sends the checkpoint again from the size a 409 names", async () => {
    const a = await witnessOf("witness-a.example");
    const read = await storedTree(entries);
    const received: Received[] = [];
    // The object never recorded this witness; the witness holds size 4 from an earlier round.
    const stub = stubWitness(a, received, { size: 4, root: await treeHead(4, read) });
    const { state, witnessed } = await published(7);
    const outcome = await run(
      state,
      [policyWitness(a, "a.example")],
      routed({ "a.example": stub }),
    );
    expect(outcome).toMatchObject({ cosigned: [a.name], failed: [] });
    expect(received.map((r) => r.old)).toEqual([0, 4]);
    expect(witnessed.get(a.name)).toBe(7);
  });

  it("[FD-PROV-039] keeps no line that fails under the policy key, and a witness it cannot reach leaves the others' cosignatures stored", async () => {
    const [a, b, c, stranger] = [
      await witnessOf("witness-a.example"),
      await witnessOf("witness-b.example"),
      await witnessOf("witness-c.example"),
      await witnessOf("witness-a.example"),
    ];
    const received: Received[] = [];
    const { state, text } = await published(6);
    const outcome = await run(
      state,
      [
        policyWitness(a, "a.example"),
        policyWitness(b, "b.example"),
        policyWitness(c, "down.example"),
      ],
      routed({
        // Answers with a cosignature by a key the policy does not name.
        "a.example": stubWitness(stranger, received),
        "b.example": stubWitness(b, received),
      }),
    );
    expect(outcome).toMatchObject({
      _tag: "Witnessed",
      cosigned: [b.name],
      failed: [
        { witness: a.name, reason: "no-cosignature" },
        { witness: c.name, reason: "unreachable" },
      ],
    });
    const lines = (await checkpointNow())
      .slice(text.length)
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(`— ${b.name} `)).toBe(true);
  });

  it("[FD-PROV-039] stores nothing when a witness refuses, and sends no checkpoint the object did not sign", async () => {
    const a = await witnessOf("witness-a.example");
    const received: Received[] = [];
    const refusing = stubWitness(a, received, {
      answer: () => new Response("unknown log", { status: 404 }),
    });
    const { state, text } = await published(4);
    expect(
      await run(state, [policyWitness(a, "a.example")], routed({ "a.example": refusing })),
    ).toMatchObject({ cosigned: [], failed: [{ witness: a.name, reason: "refused" }] });
    expect(await checkpointNow()).toBe(text);

    // A checkpoint over a tree other than the object's is never sent.
    received.length = 0;
    const forged = await signCheckpoint(
      { origin: ORIGIN, size: 4, root: await leafHash(utf8("forged")) },
      logKey,
    );
    await bucket.put(`${prefix}${CHECKPOINT_PATH}`, forged);
    expect(
      await run(
        state,
        [policyWitness(a, "a.example")],
        routed({ "a.example": stubWitness(a, received) }),
      ),
    ).toMatchObject({ _tag: "NoCheckpoint" });
    expect(received).toEqual([]);
  });

  it("[FD-PROV-039] sends nothing to a witness whose policy key is malformed or names another witness", async () => {
    const [a, b, other] = [
      await witnessOf("witness-a.example"),
      await witnessOf("witness-b.example"),
      await witnessOf("witness-other.example"),
    ];
    const received: Received[] = [];
    const { state, text } = await published(5);
    const outcome = await run(
      state,
      [
        { ...policyWitness(a, "a.example"), key: "witness-a.example+00000000+not-a-key" },
        { ...policyWitness(b, "b.example"), key: other.vkey },
      ],
      routed({ "a.example": stubWitness(a, received), "b.example": stubWitness(b, received) }),
    );
    expect(outcome).toMatchObject({
      cosigned: [],
      failed: [
        { witness: a.name, reason: "bad-key" },
        { witness: b.name, reason: "bad-key", detail: other.vkey },
      ],
    });
    expect(received).toEqual([]);
    expect(await checkpointNow()).toBe(text);
  });

  it("[FD-PROV-039] records a witness that holds a larger tree than the log's as ahead, and stores nothing", async () => {
    const a = await witnessOf("witness-a.example");
    const received: Received[] = [];
    const { state, text, witnessed } = await published(5);
    const outcome = await run(
      state,
      [policyWitness(a, "a.example")],
      routed({ "a.example": stubWitness(a, received, { size: 8 }) }),
    );
    expect(outcome).toMatchObject({
      cosigned: [],
      failed: [{ witness: a.name, reason: "witness-ahead" }],
    });
    // The 409 named size 8: no second request is sent from a size the log does not have.
    expect(received.map((r) => r.old)).toEqual([0]);
    expect(await checkpointNow()).toBe(text);
    expect(witnessed.has(a.name)).toBe(false);
  });

  it("[FD-PROV-039] appends nothing when the checkpoint is replaced between the round's read and its put", async () => {
    const a = await witnessOf("witness-a.example");
    const received: Received[] = [];
    const { state, witnessed } = await published(5);
    const replaced = await signCheckpoint(
      { origin: ORIGIN, size: 6, root: await treeHead(6, state.read) },
      logKey,
    );
    const stub = stubWitness(a, received);
    const outcome = await run(
      state,
      [policyWitness(a, "a.example")],
      routed({
        // A checkpoint run publishes a grown checkpoint while the witness request is out.
        "a.example": async (url, body) => {
          await bucket.put(`${prefix}${CHECKPOINT_PATH}`, replaced);
          return stub(url, body);
        },
      }),
    );
    expect(outcome).toMatchObject({
      size: 5,
      cosigned: [],
      failed: [{ witness: a.name, reason: "checkpoint-changed" }],
    });
    expect(received).toHaveLength(1);
    expect(await checkpointNow()).toBe(replaced);
    // The witness cosigned size 5, so the next round sends from it.
    expect(witnessed.get(a.name)).toBe(5);
  });
});

describe("the add-checkpoint request and the retry delay", () => {
  it("[FD-PROV-039] writes the old size, one base64 proof hash per line, a blank line and the checkpoint", () => {
    const h = new Uint8Array(32).fill(7);
    expect(addCheckpointBody(3, [h, h], "o\n9\nroot\n\n— k sig\n")).toBe(
      `old 3\n${toBase64(h)}\n${toBase64(h)}\n\no\n9\nroot\n\n— k sig\n`,
    );
    expect(addCheckpointBody(0, [], "c\n")).toBe("old 0\n\nc\n");
  });

  it("backs off from the minimum delay, doubling per failed round, up to the maximum", () => {
    expect(witnessRetryDelay(1)).toBe(WITNESS_RETRY_MIN_MS);
    expect(witnessRetryDelay(2)).toBe(2 * WITNESS_RETRY_MIN_MS);
    expect(witnessRetryDelay(40)).toBe(WITNESS_RETRY_MAX_MS);
  });
});
