// The subjects a logged statement names, read from its envelope's canonical JSON (specs/provenance.md § Statement):
// each in-toto subject's name and its digests as `<algorithm>:<value>`. The statement lookup by subject digest
// (FD-PROV-071), the check summary's subject links (FD-PROV-042) and the artifact retention a statement extends
// (FD-PROV-075) all read them here, the retention with the epoch of the statement's lease binding. The module imports nothing that needs the Workers types, so a Node client of the
// statement lookups loads it alone.
import { Option, Schema } from "effect";

/** One subject of a statement: its name and one of its digests, `<algorithm>:<value>`. */
export interface StatementSubject {
  readonly name: string;
  readonly digest: string;
}

const Subjects = Schema.Struct({
  subject: Schema.Array(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      digest: Schema.Record(Schema.String, Schema.String),
    }),
  ),
});

const Envelope = Schema.Struct({ payload: Schema.String });
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope));

/** Standard base64 to bytes; `undefined` for text that is not base64. */
const fromBase64 = (text: string): Uint8Array | undefined => {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
};
const decodeSubjects = Schema.decodeUnknownOption(Subjects);

/** The JSON payload of an envelope's canonical JSON; `undefined` for an envelope or payload that does not parse. */
const payloadOf = (envelopeJson: string): unknown => {
  const envelope = Option.getOrUndefined(decodeEnvelope(envelopeJson));
  const payload = envelope === undefined ? undefined : fromBase64(envelope.payload);
  if (payload === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * The subjects of the statement an envelope carries, one entry per digest in algorithm order; none for an envelope or
 * payload that does not parse.
 */
export const statementSubjects = (envelopeJson: string): readonly StatementSubject[] => {
  const json = payloadOf(envelopeJson);
  if (json === undefined) return [];
  const statement = Option.getOrUndefined(decodeSubjects(json));
  if (statement === undefined) return [];
  return statement.subject.flatMap((s) =>
    Object.keys(s.digest)
      .sort()
      .map((algorithm) => ({ name: s.name ?? "", digest: `${algorithm}:${s.digest[algorithm]}` })),
  );
};

/** The `sha256:<hex>` digests among a statement's subjects: the digests of the artifacts it names. */
export const sha256Subjects = (subjects: readonly StatementSubject[]): readonly string[] => [
  ...new Set(subjects.map((s) => s.digest).filter((d) => /^sha256:[0-9a-f]{64}$/.test(d))),
];

const Epoch = Schema.Struct({ epoch: Schema.Number.check(Schema.isInt()) });
const LeaseEpoch = Schema.Union([
  // SLSA provenance v1: `buildDefinition.internalParameters.lease`.
  Schema.Struct({
    predicate: Schema.Struct({
      buildDefinition: Schema.Struct({ internalParameters: Schema.Struct({ lease: Epoch }) }),
    }),
  }),
  // The test-result predicate: the `configuration` descriptor named `lease`.
  Schema.Struct({
    predicate: Schema.Struct({
      configuration: Schema.Array(
        Schema.Struct({ name: Schema.optional(Schema.String), annotations: Schema.optional(Schema.Unknown) }),
      ),
    }),
  }),
]);
const decodeLeaseEpoch = Schema.decodeUnknownOption(LeaseEpoch);
const decodeEpoch = Schema.decodeUnknownOption(Epoch);

/**
 * The epoch of the lease binding the statement an envelope carries (specs/provenance.md § Statement): the epoch whose
 * artifacts the statement's subjects name. `null` for a statement with no lease binding, such as a reproduction record.
 */
export const statementEpoch = (envelopeJson: string): number | null => {
  const statement = Option.getOrUndefined(decodeLeaseEpoch(payloadOf(envelopeJson)));
  if (statement === undefined) return null;
  const { predicate } = statement;
  if ("buildDefinition" in predicate) return predicate.buildDefinition.internalParameters.lease.epoch;
  const lease = predicate.configuration.find((d) => d.name === "lease");
  return Option.getOrNull(Option.map(decodeEpoch(lease?.annotations), (l) => l.epoch));
};

/** The names of a statement's subjects: the names of the artifacts it keeps (FD-PROV-075). */
export const subjectNames = (subjects: readonly StatementSubject[]): readonly string[] => [
  ...new Set(subjects.map((s) => s.name).filter((name) => name !== "")),
];
