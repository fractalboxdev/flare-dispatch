// The public Rekor log's append (specs/provenance.md FD-PROV-035). A countersigned envelope is proposed to Rekor's
// `POST /api/v1/log/entries` as a `dsse` entry (apiVersion `0.0.1`) carrying the envelope's canonical JSON and, as
// verifiers, the base64 PEM SubjectPublicKeyInfo of each signer's key: the device key and the provenance key. Rekor
// answers `201` with the new entry, or `409` with a `Location` header naming the entry the same envelope already has,
// which the client reads back, so a retried append answers the first entry. An entry's `integratedTime` is Rekor's
// clock in seconds.
import { Effect, Option, Schema } from "effect";
import { LogAppendFailed, type LogEntry } from "./append.ts";

/** The public Rekor instance. */
export const REKOR_PUBLIC_URL = "https://rekor.sigstore.dev";

const ENTRIES_PATH = "/api/v1/log/entries";

const RekorEntry = Schema.Struct({
  body: Schema.String,
  integratedTime: Schema.Number,
  logID: Schema.String,
  logIndex: Schema.Number,
});
const decodeAnswer = Schema.decodeUnknownOption(Schema.Record(Schema.String, RekorEntry));

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

/** A public P-256 JWK as a PEM `PUBLIC KEY` block. */
export const publicKeyPem = async (jwk: JsonWebKey): Promise<string> => {
  const { kty, crv, x, y } = jwk;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty, crv, x, y },
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  const der = toBase64(new Uint8Array((await crypto.subtle.exportKey("spki", key)) as ArrayBuffer));
  const lines = der.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
};

/** The proposed `dsse` entry for an envelope and its signers' public keys. */
export const rekorProposedEntry = async (
  envelopeJson: string,
  verifiers: readonly JsonWebKey[],
) => ({
  apiVersion: "0.0.1",
  kind: "dsse",
  spec: {
    proposedContent: {
      envelope: envelopeJson,
      verifiers: await Promise.all(
        verifiers.map(async (jwk) => toBase64(new TextEncoder().encode(await publicKeyPem(jwk)))),
      ),
    },
  },
});

export interface RekorOptions {
  /** The Rekor instance; the public one by default. */
  readonly url?: string;
  readonly fetch?: typeof fetch;
}

const failed = (message: string) => new LogAppendFailed({ log: "rekor", message });

/** The one entry of a Rekor answer, `{ <uuid>: entry }`. */
const entryOf = (body: unknown): LogEntry | undefined => {
  const answer = Option.getOrUndefined(decodeAnswer(body));
  const [uuid, entry] = Object.entries(answer ?? {})[0] ?? [];
  if (uuid === undefined || entry === undefined) return undefined;
  return {
    log: "rekor",
    logIndex: entry.logIndex,
    entryId: uuid,
    integratedTime: entry.integratedTime * 1000,
  };
};

/** Appends an envelope to Rekor, answering its entry, or the earlier entry of the same envelope on `409`. */
export const rekorAppend =
  (options: RekorOptions = {}) =>
  (
    envelopeJson: string,
    verifiers: readonly JsonWebKey[],
  ): Effect.Effect<LogEntry, LogAppendFailed> =>
    Effect.gen(function* () {
      const base = (options.url ?? REKOR_PUBLIC_URL).replace(/\/+$/, "");
      const send = options.fetch ?? fetch;
      const request = (url: string, init?: RequestInit) =>
        Effect.tryPromise({
          try: async () => {
            const response = await send(url, init);
            const text = await response.text();
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              body = undefined;
            }
            return {
              status: response.status,
              location: response.headers.get("location"),
              body,
              text,
            };
          },
          catch: (e) => failed(`rekor unreachable: ${e instanceof Error ? e.message : String(e)}`),
        });
      const proposed = yield* Effect.promise(() => rekorProposedEntry(envelopeJson, verifiers));
      const created = yield* request(`${base}${ENTRIES_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(proposed),
      });
      let answered = created;
      if (created.status === 409) {
        if (created.location === null)
          return yield* failed("rekor answered 409 without the existing entry's location");
        answered = yield* request(new URL(created.location, `${base}/`).toString(), {
          headers: { accept: "application/json" },
        });
        if (answered.status !== 200)
          return yield* failed(`rekor answered ${answered.status} reading the existing entry`);
      } else if (created.status !== 201)
        return yield* failed(`rekor answered ${created.status}: ${created.text.slice(0, 200)}`);
      const entry = entryOf(answered.body);
      if (entry === undefined) return yield* failed("rekor answered no log entry");
      return entry;
    });
