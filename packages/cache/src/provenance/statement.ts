// The statement format every FlareDispatch builder writes (specs/provenance.md § Statement): an in-toto Statement v1
// whose predicate is SLSA provenance v1 for a build recipe and the in-toto test-result predicate for a gate recipe.
// The device executor's builder (packages/device) and the control plane's cloud-builder writer (`cloud-statement.ts`)
// both build their statements here; they differ only in where the subject digests come from and in the builder version.
import { Schema } from "effect";
import { fromBase64, type AnyDsseEnvelope } from "./dsse.ts";

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
export const TEST_RESULT_V0_1 = "https://in-toto.io/attestation/test-result/v0.1";
/** The SLSA `buildType` of every FlareDispatch build statement. */
export const BUILD_TYPE =
  "https://github.com/fractalboxdev/flare-dispatch/blob/main/specs/provenance.md#statement";

/** A `sha256:<hex>` digest. */
export const StatementDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));
const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/));
/** A name: printable ASCII without whitespace, so no log line, diff hunk, prompt or source text fits in one. */
export const StatementName = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,256}$/));
const NonNegativeInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Int = Schema.Number.check(Schema.isInt());

/** The execution the control plane issued, as the lease or registration that binds the work names it. */
export const StatementLease = Schema.Struct({
  execution_id: Id,
  epoch: NonNegativeInt,
  nonce: Id,
  executor_id: Id,
  executor_kind: Id,
  run: Schema.Struct({
    name: StatementName,
    kind: Schema.Literals(["build", "gate"]),
    definition_digest: StatementDigest,
    inputs_digest: StatementDigest,
  }),
  repository: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  ref: StatementName,
  commit_sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}([0-9a-f]{24})?$/)),
  image_digest: StatementDigest,
  class: StatementName,
  policy_version: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,64}$/)),
  confidentiality: Schema.Literals([
    "non-confidential",
    "unclassified",
    "confidential-model",
    "confidential-compute",
  ]),
});

/** What binds the work: an execution lease the control plane granted, or a registration of capacity-lease work. */
export const BindingKind = Schema.Literals(["execution-lease", "registration"]);
export type BindingKind = typeof BindingKind.Type;

/** The run's evidence every statement records, whichever builder writes it (FD-PROV-005, FD-PROV-006). */
export const StatementEvidenceFields = {
  outcome: Schema.String.check(Schema.isPattern(/^[a-z_-]{1,32}$/)),
  /** Each command's step name, from the run definition, and its exit status, the one field the job sandbox reports. */
  commands: Schema.Array(Schema.Struct({ name: StatementName, exit_status: Int })),
  lockfiles: Schema.Array(Schema.Struct({ path: StatementName, digest: StatementDigest })),
  /** The egress proxy's records of admitted fetches; `response_digest` is null where the proxy saw no plaintext. */
  fetches: Schema.Array(
    Schema.Struct({
      host: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/)),
      method: Schema.String.check(Schema.isPattern(/^[A-Z]{1,16}$/)),
      path: Schema.String.check(Schema.isPattern(/^\/[\x21-\x7e]{0,2047}$/)),
      response_digest: Schema.NullOr(StatementDigest),
    }),
  ),
  /** The per-dependency digests the run's lockfiles declare, keyed by the URI the job fetches. */
  locked_dependencies: Schema.Array(
    Schema.Struct({
      uri: Schema.String.check(Schema.isPattern(/^https:\/\/[\x21-\x7e]{1,2300}$/)),
      digest: StatementDigest,
    }),
  ),
  restored_cache: Schema.Array(
    Schema.Struct({ namespace: StatementName, key: StatementName, digest: StatementDigest }),
  ),
  egress_log_digest: StatementDigest,
  step_log_digest: StatementDigest,
  /** Each model the gateway metered for the execution and epoch, with its token count. */
  models: Schema.Array(Schema.Struct({ id: StatementName, tokens: NonNegativeInt })),
};

/** Everything a statement records beside its subjects and builder version. */
export const StatementBody = Schema.Struct({
  lease: Schema.Struct({ ...StatementLease.fields, binding_kind: BindingKind }),
  ...StatementEvidenceFields,
});
export type StatementBody = typeof StatementBody.Type;

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

/** `sha256:<hex>` as an in-toto digest set. */
export const digestSet = (digest: string) => ({ sha256: digest.slice("sha256:".length) });

/**
 * Each dependency the job fetched, from the egress proxy's records of admitted fetches, with the source of its digest:
 * `proxy` where the egress proxy hashed the fetched bytes, `lockfile` where the digest comes from the run's lockfiles
 * entry for the fetched URI (FD-PROV-006). A fetch with no digest from either source resolves nothing; the egress proxy
 * log, whose digest the statement carries, still records it. A locked dependency the job did not fetch is not listed.
 */
export const resolvedFetches = (
  input: Pick<StatementBody, "fetches" | "locked_dependencies">,
): ResourceDescriptor[] => {
  const locked = new Map(input.locked_dependencies.map((d) => [d.uri, d.digest]));
  const out = new Map<string, ResourceDescriptor>();
  for (const f of input.fetches) {
    const uri = `https://${f.host}${f.path}`;
    const prior = out.get(uri);
    if (f.response_digest !== null) {
      if (prior?.annotations?.digest_source !== "proxy")
        out.set(uri, {
          uri,
          digest: digestSet(f.response_digest),
          annotations: { digest_source: "proxy" },
        });
      continue;
    }
    const digest = locked.get(uri);
    if (prior === undefined && digest !== undefined)
      out.set(uri, { uri, digest: digestSet(digest), annotations: { digest_source: "lockfile" } });
  }
  return [...out.values()];
};

const leaseBinding = (input: StatementBody) => ({
  execution_id: input.lease.execution_id,
  epoch: input.lease.epoch,
  nonce: input.lease.nonce,
  executor_id: input.lease.executor_id,
  binding_kind: input.lease.binding_kind,
});

/** The inputs every statement names, whichever predicate carries them (FD-PROV-005). */
const inputDescriptors = (input: StatementBody): ResourceDescriptor[] => [
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

const byproducts = (input: StatementBody): ResourceDescriptor[] => [
  { name: "egress-proxy-log", digest: digestSet(input.egress_log_digest) },
  { name: "step-log", digest: digestSet(input.step_log_digest) },
  ...input.models.map((m) => ({ name: `model:${m.id}`, annotations: { tokens: m.tokens } })),
];

const slsaPredicate = (
  input: StatementBody,
  builderVersion: Readonly<Record<string, string>> | undefined,
) => ({
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
      ...(builderVersion === undefined ? {} : { version: builderVersion }),
    },
    metadata: { invocationId: input.lease.execution_id },
    byproducts: byproducts(input),
  },
});

const testResultPredicate = (
  input: StatementBody,
  builderVersion: Readonly<Record<string, string>> | undefined,
) => {
  const passed = input.commands.filter((c) => c.exit_status === 0).map((c) => c.name);
  const failed = input.commands.filter((c) => c.exit_status !== 0).map((c) => c.name);
  return {
    result: input.outcome === "success" && failed.length === 0 ? "PASSED" : "FAILED",
    configuration: [
      { name: "lease", annotations: leaseBinding(input) },
      // The builder, as the SLSA predicate's `runDetails.builder` names it, with the device's code hash.
      ...(builderVersion === undefined
        ? []
        : [
            {
              name: "builder",
              annotations: {
                id: `${input.lease.executor_kind}:${input.lease.executor_id}`,
                ...builderVersion,
              },
            },
          ]),
      {
        name: "run-definition",
        digest: digestSet(input.lease.run.definition_digest),
        annotations: { run: input.lease.run.name, class: input.lease.class },
      },
      { name: "inputs", digest: digestSet(input.lease.run.inputs_digest) },
      ...inputDescriptors(input),
      ...byproducts(input),
    ],
    passedTests: passed,
    warnedTests: [],
    failedTests: failed,
  };
};

/**
 * The in-toto Statement v1 for one execution: the given subjects, or the commit when there are none, since in-toto
 * Statement v1 requires at least one; the SLSA provenance v1 predicate for a build recipe and the test-result predicate
 * for a gate recipe (FD-PROV-005, FD-PROV-006, FD-PROV-007). `builderVersion` is the SLSA builder's `version`, such as
 * the device key helper's code hash, and the test-result predicate's `builder` configuration descriptor; a builder with
 * none omits both.
 */
export const statementOf = (
  body: StatementBody,
  subject: readonly ResourceDescriptor[],
  builderVersion?: Readonly<Record<string, string>>,
): Statement => ({
  _type: STATEMENT_TYPE,
  subject:
    subject.length === 0
      ? [{ name: "commit", digest: { gitCommit: body.lease.commit_sha } }]
      : subject,
  ...(body.lease.run.kind === "build"
    ? { predicateType: SLSA_PROVENANCE_V1, predicate: slsaPredicate(body, builderVersion) }
    : { predicateType: TEST_RESULT_V0_1, predicate: testResultPredicate(body, builderVersion) }),
});

/** Every string leaf of a statement is a digest, id, name, timestamp or verdict: one bounded whitespace-free token. */
const LEAF = /^[\x21-\x7e]{1,2400}$/;

/**
 * The path of the first value that is not a digest, id, name, timestamp, verdict or count — such as source, file
 * contents, a diff, a log, a prompt or a completion — or `null` when every value is one (FD-PROV-043). A statement's
 * schemas admit only such values; this check holds every statement, reproduction record and log entry the control
 * plane writes to the same rule, whoever built it.
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
 * The path of the first disallowed value in a DSSE envelope, its payload read as the JSON document it encodes, or
 * `null` when every value is allowed (FD-PROV-043). A payload that is not base64 of UTF-8 JSON is disallowed whole:
 * its bytes could be any file.
 */
export const envelopeDisallowedContent = (envelope: AnyDsseEnvelope): string | null => {
  const bytes = fromBase64(envelope.payload);
  if (bytes === undefined) return "$.payload";
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return "$.payload";
  }
  return disallowedContent({ ...envelope, payload });
};

/** A statement, reproduction record or log entry holds a value other than a digest, id, name, timestamp or verdict. */
export class StatementContentRefused extends Schema.TaggedError<StatementContentRefused>()(
  "StatementContentRefused",
  { path: Schema.String },
) {}
