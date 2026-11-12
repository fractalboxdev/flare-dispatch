// FlareDispatch's statement builder: the device extension's `statement` operation (specs/provenance.md § Statement).
// The device executor passes the lease, the outcome, each command's exit status and the digests it computed after the
// job sandbox exited; the builder answers an unsigned DSSE envelope whose payload is an in-toto Statement v1, and the
// device executor signs `dssePae(payloadType, payload)` through the key helper under the `statement` signing purpose
// (MAMEKO-EXEC-122).
import { Effect, Schema } from "effect";

export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
export const TEST_RESULT_V0_1 = "https://in-toto.io/attestation/test-result/v0.1";
/** The SLSA `buildType` of every FlareDispatch build statement. */
export const BUILD_TYPE =
  "https://github.com/fractalboxdev/flare-dispatch/blob/main/specs/provenance.md#statement";

/** The signing purpose the device executor signs a statement under (packages/profile `signing_purposes`). */
export const STATEMENT_SIGNING_PURPOSE = "statement";

const Digest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));
const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/));
/** A name: printable ASCII without whitespace, so no log line, diff hunk, prompt or source text fits in one. */
const Name = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,256}$/));
const NonNegativeInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Int = Schema.Number.check(Schema.isInt());

/** What the device executor passes the builder. Every field outside this schema is dropped on decode (FD-PROV-001). */
export const StatementInput = Schema.Struct({
  /** The lease or registration that binds the work, as the control plane issued it. */
  lease: Schema.Struct({
    execution_id: Id,
    epoch: NonNegativeInt,
    nonce: Id,
    executor_id: Id,
    executor_kind: Id,
    binding_kind: Schema.Literals(["execution-lease", "registration"]),
    run: Schema.Struct({
      name: Name,
      kind: Schema.Literals(["build", "gate"]),
      definition_digest: Digest,
      inputs_digest: Digest,
    }),
    repository: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
    ref: Name,
    commit_sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}([0-9a-f]{24})?$/)),
    image_digest: Digest,
    class: Name,
    policy_version: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,64}$/)),
    confidentiality: Schema.Literals([
      "non-confidential",
      "unclassified",
      "confidential-model",
      "confidential-compute",
    ]),
  }),
  /** The key helper's code hash from the device's registration record (MAMEKO-LEASE-092). */
  code_hash: Digest,
  outcome: Schema.String.check(Schema.isPattern(/^[a-z_-]{1,32}$/)),
  /** Each command's step name, from the run definition, and its exit status, the one field the job sandbox reports. */
  commands: Schema.Array(Schema.Struct({ name: Name, exit_status: Int })),
  /** The digests the device executor computed from the detached output volume after the job sandbox exited. */
  outputs: Schema.Array(Schema.Struct({ name: Name, digest: Digest })),
  lockfiles: Schema.Array(Schema.Struct({ path: Name, digest: Digest })),
  /** The egress proxy's records of admitted fetches; `response_digest` is null where the proxy saw no plaintext. */
  fetches: Schema.Array(
    Schema.Struct({
      host: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/)),
      method: Schema.String.check(Schema.isPattern(/^[A-Z]{1,16}$/)),
      path: Schema.String.check(Schema.isPattern(/^\/[\x21-\x7e]{0,2047}$/)),
      response_digest: Schema.NullOr(Digest),
    }),
  ),
  /** The per-dependency digests the run's lockfiles declare, keyed by the URI the job fetches. */
  locked_dependencies: Schema.Array(
    Schema.Struct({
      uri: Schema.String.check(Schema.isPattern(/^https:\/\/[\x21-\x7e]{1,2300}$/)),
      digest: Digest,
    }),
  ),
  restored_cache: Schema.Array(Schema.Struct({ namespace: Name, key: Name, digest: Digest })),
  egress_log_digest: Digest,
  step_log_digest: Digest,
  /** Each model the gateway metered for the execution and epoch, with its token count. */
  models: Schema.Array(Schema.Struct({ id: Name, tokens: NonNegativeInt })),
});
export type StatementInput = typeof StatementInput.Type;

export class StatementInputInvalid extends Schema.TaggedError<StatementInputInvalid>()(
  "StatementInputInvalid",
  { message: Schema.String },
) {}

export interface ResourceDescriptor {
  readonly name?: string;
  readonly uri?: string;
  readonly digest?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, string | number>>;
}

export interface Statement {
  readonly _type: typeof STATEMENT_TYPE;
  readonly subject: readonly ResourceDescriptor[];
  readonly predicateType: typeof SLSA_PROVENANCE_V1 | typeof TEST_RESULT_V0_1;
  readonly predicate: Readonly<Record<string, unknown>>;
}

export interface DsseEnvelope {
  readonly payloadType: typeof DSSE_PAYLOAD_TYPE;
  /** The statement's canonical JSON, base64-encoded. */
  readonly payload: string;
  readonly signatures: readonly { readonly keyid: string; readonly sig: string }[];
}

/** `sha256:<hex>` as an in-toto digest set. */
const digestSet = (digest: string) => ({ sha256: digest.slice("sha256:".length) });

/**
 * Each resolved dependency the job fetched, with the source of its digest: `proxy` where the egress proxy hashed the
 * fetched bytes, `lockfile` where the digest comes from the run's lockfiles (FD-PROV-006). A fetch with no digest from
 * either source resolves nothing; the egress proxy log, whose digest the statement carries, still records it.
 */
export const resolvedFetches = (input: StatementInput): ResourceDescriptor[] => {
  const proxied = new Map<string, string>();
  for (const f of input.fetches)
    if (f.response_digest !== null) proxied.set(`https://${f.host}${f.path}`, f.response_digest);
  const out: ResourceDescriptor[] = [...proxied].map(([uri, digest]) => ({
    uri,
    digest: digestSet(digest),
    annotations: { digest_source: "proxy" },
  }));
  for (const d of input.locked_dependencies)
    if (!proxied.has(d.uri))
      out.push({
        uri: d.uri,
        digest: digestSet(d.digest),
        annotations: { digest_source: "lockfile" },
      });
  return out;
};

const leaseBinding = (input: StatementInput) => ({
  execution_id: input.lease.execution_id,
  epoch: input.lease.epoch,
  nonce: input.lease.nonce,
  executor_id: input.lease.executor_id,
  binding_kind: input.lease.binding_kind,
});

/** The inputs every statement names, whichever predicate carries them (FD-PROV-005). */
const inputDescriptors = (input: StatementInput): ResourceDescriptor[] => [
  {
    name: "commit",
    uri: `git+https://github.com/${input.lease.repository}@${input.lease.ref}`,
    digest: { gitCommit: input.lease.commit_sha },
  },
  { name: "image", digest: digestSet(input.lease.image_digest) },
  ...input.lockfiles.map((l) => ({ name: `lockfile:${l.path}`, digest: digestSet(l.digest) })),
  ...resolvedFetches(input),
  ...input.restored_cache.map((c) => ({
    name: `cache:${c.namespace}/${c.key}`,
    digest: digestSet(c.digest),
    annotations: { namespace: c.namespace, key: c.key },
  })),
];

const logDescriptors = (input: StatementInput): ResourceDescriptor[] => [
  { name: "egress-proxy-log", digest: digestSet(input.egress_log_digest) },
  { name: "step-log", digest: digestSet(input.step_log_digest) },
];

const slsaPredicate = (input: StatementInput) => ({
  buildDefinition: {
    buildType: BUILD_TYPE,
    externalParameters: {
      run: input.lease.run.name,
      run_definition_digest: input.lease.run.definition_digest,
      repository: input.lease.repository,
      ref: input.lease.ref,
      commit_sha: input.lease.commit_sha,
      inputs_digest: input.lease.run.inputs_digest,
    },
    internalParameters: {
      lease: leaseBinding(input),
      class: input.lease.class,
      policy_version: input.lease.policy_version,
      confidentiality: input.lease.confidentiality,
    },
    resolvedDependencies: inputDescriptors(input),
  },
  runDetails: {
    builder: {
      id: `${input.lease.executor_kind}:${input.lease.executor_id}`,
      version: { code_hash: input.code_hash },
    },
    metadata: { invocationId: input.lease.execution_id },
    byproducts: [
      ...logDescriptors(input),
      ...input.models.map((m) => ({ name: `model:${m.id}`, annotations: { tokens: m.tokens } })),
    ],
  },
});

const testResultPredicate = (input: StatementInput) => {
  const passed = input.commands.filter((c) => c.exit_status === 0).map((c) => c.name);
  const failed = input.commands.filter((c) => c.exit_status !== 0).map((c) => c.name);
  return {
    result: input.outcome === "success" && failed.length === 0 ? "PASSED" : "FAILED",
    configuration: [
      { name: "lease", annotations: leaseBinding(input) },
      {
        name: "run-definition",
        digest: digestSet(input.lease.run.definition_digest),
        annotations: { run: input.lease.run.name, class: input.lease.class },
      },
      { name: "inputs", digest: digestSet(input.lease.run.inputs_digest) },
      ...inputDescriptors(input),
      ...logDescriptors(input),
      ...input.models.map((m) => ({ name: `model:${m.id}`, annotations: { tokens: m.tokens } })),
    ],
    passedTests: passed,
    warnedTests: [],
    failedTests: failed,
  };
};

/** Every string leaf of a statement is a digest, id, name, timestamp or verdict: one bounded whitespace-free token. */
const LEAF = /^[\x21-\x7e]{1,2400}$/;

/**
 * The path of the first statement value that is not a digest, id, name, timestamp, verdict or count — such as source,
 * file contents, a diff, a log, a prompt or a completion — or `null` when every value is one (FD-PROV-043).
 */
export const disallowedContent = (value: unknown, path = "$"): string | null => {
  if (typeof value === "string") return LEAF.test(value) ? null : path;
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const bad = disallowedContent(v, `${path}[${i}]`);
      if (bad !== null) return bad;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const bad = disallowedContent(v, `${path}.${k}`);
      if (bad !== null) return bad;
    }
    return null;
  }
  return path;
};

/**
 * The in-toto Statement v1 for one execution: subjects from the output digests the device executor passes, the SLSA
 * provenance v1 predicate for a build recipe and the test-result predicate for a gate recipe (FD-PROV-001, -005, -007).
 */
export const buildStatement = (raw: unknown): Effect.Effect<Statement, StatementInputInvalid> =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(StatementInput)(raw).pipe(
      Effect.mapError((e) => new StatementInputInvalid({ message: e.message })),
    );
    const statement: Statement = {
      _type: STATEMENT_TYPE,
      subject: input.outputs.map((o) => ({ name: o.name, digest: digestSet(o.digest) })),
      ...(input.lease.run.kind === "build"
        ? { predicateType: SLSA_PROVENANCE_V1, predicate: slsaPredicate(input) }
        : { predicateType: TEST_RESULT_V0_1, predicate: testResultPredicate(input) }),
    };
    const bad = disallowedContent(statement);
    if (bad !== null)
      return yield* new StatementInputInvalid({ message: `${bad} is not a digest, id or name` });
    return statement;
  });

/** The statement as an unsigned DSSE envelope with payload type `application/vnd.in-toto+json` (FD-PROV-004). */
export const buildEnvelope = (raw: unknown): Effect.Effect<DsseEnvelope, StatementInputInvalid> =>
  Effect.map(buildStatement(raw), (statement) => ({
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
    signatures: [],
  }));

/** DSSE's pre-authentication encoding: the bytes the key helper signs for an envelope (DSSE v1 § Protocol). */
export const dssePae = (payloadType: string, payload: Uint8Array): Uint8Array => {
  const type = new TextEncoder().encode(payloadType);
  const head = new TextEncoder().encode(
    `DSSEv1 ${type.byteLength} ${payloadType} ${payload.byteLength} `,
  );
  const out = new Uint8Array(head.byteLength + payload.byteLength);
  out.set(head);
  out.set(payload, head.byteLength);
  return out;
};
