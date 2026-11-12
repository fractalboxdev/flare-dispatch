// The private log's witnesses (FD-PROV-039): the `TransparencyLog` object sends each checkpoint it signs to every
// witness the current verification policy names, over C2SP tlog-witness, and stores each cosignature returned as a
// signature line of the published checkpoint, which is what an inclusion proof carries to `fd verify` (FD-PROV-055).
//
// A request is `POST <url>/add-checkpoint` whose body is the line `old <N>` (the tree size the witness last cosigned),
// the RFC 9162 consistency proof from that size, one base64 hash per line, a blank line, and the signed checkpoint. A
// `200` answers the witness's cosignature lines; a `409` answers the size the witness holds, and the object sends the
// checkpoint again from that size. A cosignature line is a C2SP tlog-cosignature: `— <name> <base64(key id ‖ 8-byte
// big-endian timestamp ‖ Ed25519 signature)>`, the signature over `cosignature/v1\ntime <t>\n<checkpoint body>`. The
// object keeps only lines that verify under the key the policy names, appends them to the published checkpoint with
// an `etagMatches` put, and records each witness's size in its SQLite storage. A witness it could not reach, or that
// refused, is asked again from the object's alarm with back-off.
import { Data, Effect, Schema } from "effect";
import { asBuffer, hex, utf8 } from "../crypto.ts";
import type { Bucket } from "../manifest.ts";
import { fromBase64 } from "./dsse.ts";
import {
  CHECKPOINT_PATH,
  consistencyProof,
  parseCheckpoint,
  sameHash,
  toBase64,
  treeHead,
  type ReadStoredHash,
} from "./merkle.ts";
import type { PolicyStoreFailed, PolicyWitness } from "./policy.ts";

/** How long one `add-checkpoint` request may take before the witness counts as unreachable. */
export const WITNESS_TIMEOUT_MS = 10_000;
/** The first retry delay after a witness round fails, doubling per failed round up to `WITNESS_RETRY_MAX_MS`. */
export const WITNESS_RETRY_MIN_MS = 30_000;
export const WITNESS_RETRY_MAX_MS = 3_600_000;

/** The C2SP tlog-cosignature algorithm byte of an Ed25519 cosignature/v1 key. */
const COSIGNATURE_V1 = 0x04;

/** A witness's C2SP note verifier key, parsed: its name, its 4-byte key id and its Ed25519 public key. */
export interface WitnessKey {
  readonly name: string;
  readonly keyId: Uint8Array;
  readonly publicKey: Uint8Array;
}

const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", asBuffer(bytes)));

/**
 * Parses `<name>+<key id hex>+<base64(0x04 ‖ Ed25519 public key)>`, checking the key id is the first 4 bytes of
 * SHA-256(`<name>\n` ‖ key); `undefined` when the text is not such a key.
 */
export const parseWitnessKey = async (vkey: string): Promise<WitnessKey | undefined> => {
  const m = /^([^+\s]+)\+([0-9a-f]{8})\+(\S+)$/.exec(vkey);
  const key = m === null ? undefined : fromBase64(m[3]!);
  if (m === null || key === undefined || key.byteLength !== 33 || key[0] !== COSIGNATURE_V1)
    return undefined;
  const keyId = (await sha256(new Uint8Array([...utf8(`${m[1]!}\n`), ...key]))).subarray(0, 4);
  return hex(keyId) === m[2] ? { name: m[1]!, keyId, publicKey: key.subarray(1) } : undefined;
};

/** Whether `line` is a cosignature by `key` over the checkpoint body `body`. */
export const verifyCosignature = async (
  body: string,
  key: WitnessKey,
  line: string,
): Promise<boolean> => {
  const m = /^— (\S+) (\S+)$/.exec(line);
  const sig = m === null ? undefined : fromBase64(m[2]!);
  if (m === null || m[1] !== key.name || sig?.byteLength !== 4 + 8 + 64) return false;
  if (!sameHash(sig.subarray(0, 4), key.keyId)) return false;
  const time = new DataView(asBuffer(sig.subarray(4, 12))).getBigUint64(0);
  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      asBuffer(key.publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      asBuffer(sig.subarray(12)),
      asBuffer(utf8(`cosignature/v1\ntime ${time}\n${body}`)),
    );
  } catch {
    return false;
  }
};

/** The signature lines of a signed note, after its blank line. */
const signatureLines = (text: string): readonly string[] =>
  text
    .slice(text.indexOf("\n\n") + 2)
    .split("\n")
    .filter((line) => line !== "");

/** The body of a signed note: everything up to and including the line before its blank line. */
const noteBody = (text: string): string => text.slice(0, text.indexOf("\n\n") + 1);

/** The C2SP tlog-witness `add-checkpoint` request body. */
export const addCheckpointBody = (
  oldSize: number,
  proof: readonly Uint8Array[],
  checkpoint: string,
): string => `old ${oldSize}\n${proof.map((h) => `${toBase64(h)}\n`).join("")}\n${checkpoint}`;

/** What a witness answered one `add-checkpoint` request. */
export type WitnessAnswer = Data.TaggedEnum<{
  /** `200`: the signature lines of its answer. */
  Cosigned: { readonly lines: readonly string[] };
  /** `409`: the tree size the witness holds for the log, which the next request starts from. */
  Conflict: { readonly size: number };
  /** Any other status. */
  Refused: { readonly status: number; readonly message: string };
}>;
export const WitnessAnswer = Data.taggedEnum<WitnessAnswer>();

export class WitnessUnreachable extends Schema.TaggedError<WitnessUnreachable>()(
  "WitnessUnreachable",
  { witness: Schema.String, message: Schema.String },
) {}

/** The fetch the object sends witness requests with. */
export type WitnessFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Sends one `add-checkpoint` request to `witness`. */
export const submitCheckpoint = (
  fetchWitness: WitnessFetch,
  witness: PolicyWitness,
  oldSize: number,
  proof: readonly Uint8Array[],
  checkpoint: string,
): Effect.Effect<WitnessAnswer, WitnessUnreachable> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetchWitness(`${witness.url.replace(/\/+$/, "")}/add-checkpoint`, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: addCheckpointBody(oldSize, proof, checkpoint),
        signal: AbortSignal.timeout(WITNESS_TIMEOUT_MS),
      });
      const text = await response.text();
      if (response.status === 200)
        return WitnessAnswer.Cosigned({ lines: text.split("\n").filter((l) => l !== "") });
      const size = text.trim();
      if (response.status === 409 && /^(0|[1-9][0-9]*)$/.test(size))
        return WitnessAnswer.Conflict({ size: Number(size) });
      return WitnessAnswer.Refused({ status: response.status, message: text.slice(0, 200) });
    },
    catch: (e) =>
      new WitnessUnreachable({
        witness: witness.name,
        message: e instanceof Error ? e.message : String(e),
      }),
  });

/**
 * Why a witness round left a witness's cosignature missing:
 *
 * - `unreachable`: the request failed or timed out.
 * - `refused`: the witness answered a status other than `200` or `409`.
 * - `witness-ahead`: the witness holds a tree larger than the object's; the log may be split.
 * - `no-cosignature`: the witness's `200` carried no line that verifies under the policy's key.
 * - `bad-key`: the policy's key for the witness is not a C2SP Ed25519 note verifier key.
 * - `checkpoint-changed`: the published checkpoint changed before the cosignatures were written.
 */
export const WitnessFailureReason = Schema.Literals([
  "unreachable",
  "refused",
  "witness-ahead",
  "no-cosignature",
  "bad-key",
  "checkpoint-changed",
]);
export type WitnessFailureReason = typeof WitnessFailureReason.Type;

export interface WitnessFailure {
  readonly witness: string;
  readonly reason: WitnessFailureReason;
  readonly detail: string;
}

/** What one witness round answers. */
export type CosignOutcome = Data.TaggedEnum<{
  /**
   * The checkpoint of `size` leaves: the witnesses that cosigned it in this round, those whose cosignature it already
   * carried, and those that did not.
   */
  Witnessed: {
    readonly size: number;
    readonly cosigned: readonly string[];
    readonly already: readonly string[];
    readonly failed: readonly WitnessFailure[];
  };
  /** No checkpoint the object signed is published: nothing to send. */
  NoCheckpoint: {};
}>;
export const CosignOutcome = Data.taggedEnum<CosignOutcome>();

export class WitnessStoreFailed extends Schema.TaggedError<WitnessStoreFailed>()(
  "WitnessStoreFailed",
  { path: Schema.String, message: Schema.String },
) {}

/** What a witness round reads and records in the object's storage. */
export interface WitnessState {
  readonly read: ReadStoredHash;
  /** The tree size of the last checkpoint the object signed. */
  readonly signedSize: () => number;
  /** The tree size `witness` last cosigned, or `undefined` before its first cosignature. */
  readonly witnessedSize: (witness: string) => number | undefined;
  readonly witnessed: (witness: string, size: number) => void;
}

/** What a witness round sends with. */
export interface WitnessConfig {
  readonly bucket: Bucket;
  /** The R2 prefix of the log's objects, ending in `/`. */
  readonly prefix: string;
  /** The witnesses the current verification policy names for the private log (FD-PROV-039). */
  readonly witnesses: Effect.Effect<readonly PolicyWitness[], PolicyStoreFailed>;
  readonly fetch: WitnessFetch;
}

type Asked =
  | { readonly lines: readonly string[]; readonly size: number }
  | { readonly failure: WitnessFailureReason; readonly detail: string };

/**
 * Asks one witness to cosign the checkpoint of `size` leaves, starting from `recorded`, the size it last cosigned. A
 * `409` names the witness's size; the request is sent once more from it.
 */
const ask = (
  read: ReadStoredHash,
  fetchWitness: WitnessFetch,
  witness: PolicyWitness,
  key: WitnessKey,
  checkpoint: string,
  size: number,
  recorded: number,
) =>
  Effect.gen(function* () {
    const body = noteBody(checkpoint);
    let from = recorded <= size ? recorded : 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const proof = yield* Effect.promise(() => consistencyProof(from, size, read));
      const answer = yield* submitCheckpoint(fetchWitness, witness, from, proof, checkpoint);
      const next: Asked | number = yield* WitnessAnswer.$match(answer, {
        Cosigned: ({ lines }) =>
          Effect.gen(function* () {
            const valid: string[] = [];
            for (const line of lines)
              if (yield* Effect.promise(() => verifyCosignature(body, key, line))) valid.push(line);
            return valid.length === 0
              ? {
                  failure: "no-cosignature" as const,
                  detail: `${lines.length} line(s), none verifying under ${witness.key}`,
                }
              : { lines: valid, size };
          }),
        Conflict: ({ size: held }) =>
          Effect.succeed(
            held > size
              ? {
                  failure: "witness-ahead" as const,
                  detail: `the witness holds size ${held}; the log's is ${size}`,
                }
              : held,
          ),
        Refused: ({ status, message }) =>
          Effect.succeed({ failure: "refused" as const, detail: `${status}: ${message}` }),
      });
      if (typeof next !== "number") return next;
      from = next;
    }
    return {
      failure: "refused" as const,
      detail: "the witness answered 409 twice",
    } satisfies Asked;
  }).pipe(
    Effect.catchTag("WitnessUnreachable", (e) =>
      Effect.succeed({ failure: "unreachable" as const, detail: e.message } satisfies Asked),
    ),
  );

/**
 * Runs `effect` with the object's appends and checkpoint runs held off until it ends. A witness round runs only its
 * reads of the object's state and its writes under it, never a witness request.
 */
export type Exclusive = <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;

/**
 * One witness round over the published checkpoint (FD-PROV-039): sends it to each witness of the current policy whose
 * cosignature it does not yet carry, and writes every cosignature returned onto it. Only a checkpoint over the object's
 * own tree at its signed size is sent.
 *
 * The round reads the checkpoint, its etag and the signed size under `exclusive`, sends the witness requests outside
 * it, and takes it again to record each witness's size and append the verified lines with an `etagMatches` put. An
 * append or a checkpoint run therefore never waits on a witness, and no checkpoint run reads the checkpoint between
 * the round's read and its put.
 */
export const cosignCheckpoint = (
  state: WitnessState,
  config: WitnessConfig,
  exclusive: Exclusive = (effect) => effect,
) =>
  Effect.gen(function* () {
    const path = `${config.prefix}${CHECKPOINT_PATH}`;
    const { object, size } = yield* exclusive(
      Effect.tryPromise({
        try: async () => {
          const got = await config.bucket.get(path);
          return {
            object: got === null ? null : { etag: got.etag, text: await got.text() },
            size: state.signedSize(),
          };
        },
        catch: (e) =>
          new WitnessStoreFailed({ path, message: e instanceof Error ? e.message : String(e) }),
      }),
    );
    const checkpoint = object === null ? undefined : parseCheckpoint(object.text);
    if (object === null || checkpoint === undefined || checkpoint.size !== size || size === 0)
      return CosignOutcome.NoCheckpoint();
    const root = yield* Effect.promise(() => treeHead(size, state.read));
    if (!sameHash(root, checkpoint.root)) return CosignOutcome.NoCheckpoint();

    const witnesses = yield* config.witnesses;
    const present = signatureLines(object.text);
    // The witnesses are asked at once, so a round takes at most one witness's two requests.
    const answers = yield* Effect.forEach(
      witnesses,
      (witness) =>
        Effect.gen(function* () {
          const key = yield* Effect.promise(() => parseWitnessKey(witness.key));
          if (key === undefined || key.name !== witness.name)
            return { failure: "bad-key" as const, detail: witness.key } satisfies Asked;
          for (const line of present)
            if (yield* Effect.promise(() => verifyCosignature(checkpoint.body, key, line)))
              return "already" as const;
          const recorded = state.witnessedSize(witness.name) ?? 0;
          return yield* ask(state.read, config.fetch, witness, key, object.text, size, recorded);
        }),
      { concurrency: "unbounded" },
    );
    const cosigned: string[] = [];
    const already: string[] = [];
    const failed: WitnessFailure[] = [];
    const lines: string[] = [];
    for (const [i, answer] of answers.entries()) {
      const witness = witnesses[i]!.name;
      if (answer === "already") already.push(witness);
      else if ("failure" in answer)
        failed.push({ witness, reason: answer.failure, detail: answer.detail });
      else {
        cosigned.push(witness);
        lines.push(...answer.lines);
      }
    }
    if (lines.length === 0) return CosignOutcome.Witnessed({ size, cosigned, already, failed });
    // Each witness that cosigned holds `size` now, whether or not its line is written.
    const put = yield* exclusive(
      Effect.tryPromise({
        try: () => {
          for (const witness of cosigned) state.witnessed(witness, size);
          return config.bucket.put(path, `${object.text}${lines.map((l) => `${l}\n`).join("")}`, {
            onlyIf: { etagMatches: object.etag },
            httpMetadata: { contentType: "text/plain; charset=utf-8" },
          });
        },
        catch: (e) =>
          new WitnessStoreFailed({ path, message: e instanceof Error ? e.message : String(e) }),
      }),
    );
    if (put === null)
      return CosignOutcome.Witnessed({
        size,
        cosigned: [],
        already,
        failed: [
          ...failed,
          ...cosigned.map((witness) => ({
            witness,
            reason: "checkpoint-changed" as const,
            detail: `the checkpoint of size ${size} changed before its cosignatures were written`,
          })),
        ],
      });
    return CosignOutcome.Witnessed({ size, cosigned, already, failed });
  });

/** The delay before the next witness round after `failures` consecutive rounds that left a cosignature missing. */
export const witnessRetryDelay = (failures: number): number =>
  Math.min(WITNESS_RETRY_MIN_MS * 2 ** Math.max(0, failures - 1), WITNESS_RETRY_MAX_MS);
