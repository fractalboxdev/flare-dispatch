// FlareDispatch's result-acceptance check (specs/provenance.md § Acceptance): the application port mameko calls before
// the accept compare-and-set (MAMEKO-LEASE-093). It runs the twelve checks of the acceptance table on the device
// statement a result submission carries, in table order, and stops at the first failure; a rejection concludes the
// execution `failure` with the reason `provenance: <reason>`. A rejection that shows the signing executor or its key
// compromised (`bad-signature`, `revoked-key`, `wrong-executor`, `code-hash-mismatch`) also quarantines that executor
// and raises the `provenance-quarantine` page alarm (FD-PROV-027).
import { AlarmPort, LeaseStore, ResultAcceptanceCheck } from "@fractalboxdev/mameko-ports";
import { Clock, Context, Data, Effect, Layer, Option, Schema } from "effect";
import { DsseEnvelope, fromBase64, verifyDsseSignature } from "./dsse.ts";
import { BindingKind, SLSA_PROVENANCE_V1, TEST_RESULT_V0_1 } from "./statement.ts";

/** The acceptance table's failure reasons, in check order. */
export const ACCEPTANCE_REASONS = [
  "bad-signature",
  "unknown-key",
  "revoked-key",
  "attestation-expired",
  "unissued-lease",
  "wrong-executor",
  "stale-epoch",
  "nonce-mismatch",
  "nonce-reused",
  "digest-mismatch",
  "code-hash-mismatch",
  "model-mismatch",
] as const;
export type AcceptanceReason = (typeof ACCEPTANCE_REASONS)[number];

/** The reasons that quarantine the signing executor and raise a page alarm (FD-PROV-027). */
export const QUARANTINE_REASONS: ReadonlySet<AcceptanceReason> = new Set([
  "bad-signature",
  "revoked-key",
  "wrong-executor",
  "code-hash-mismatch",
]);

/** The page alarm a quarantining rejection raises, keyed by the quarantined executor. */
export const PROVENANCE_QUARANTINE_ALARM = "provenance-quarantine";

/** `attestation_max_age`'s default: 10 days (FD-PROV-016). */
export const DEFAULT_ATTESTATION_MAX_AGE_MS = 10 * 24 * 3_600_000;

/** One device key in the registry mameko keeps at registration, attestation and revocation (MAMEKO-LEASE-092). */
export interface DeviceKeyRecord {
  readonly executorId: string;
  readonly publicKey: JsonWebKey;
  readonly codeHash: string | null;
  readonly attestedAt: number | null;
  readonly revokedAt: number | null;
}

/** The lease or registration the control plane issued for an execution at one epoch. */
export interface IssuedExecution {
  readonly executorId: string;
}

/** The control plane's records each check compares a statement against. */
export class StatementRecords extends Context.Service<
  StatementRecords,
  {
    /** The registry entry of the device key a signature's `keyid` names, revoked or not; null when none does. */
    readonly deviceKey: (keyid: string) => Effect.Effect<DeviceKeyRecord | null>;
    /**
     * The lease or registration issued for the execution at `epoch`, whether or not a reclaim has since moved the
     * execution to a later epoch; null when the control plane issued none at that epoch.
     */
    readonly issued: (executionId: string, epoch: number) => Effect.Effect<IssuedExecution | null>;
    /** The execution's current epoch: the epoch of the lease or registration most recently issued for it. */
    readonly currentEpoch: (executionId: string) => Effect.Effect<number>;
    /** The nonce issued for the execution at `epoch` and not invalidated since; null when none is. */
    readonly issuedNonce: (executionId: string, epoch: number) => Effect.Effect<string | null>;
    /** Whether an accepted statement already consumed the nonce. */
    readonly nonceConsumed: (nonce: string) => Effect.Effect<boolean>;
    /** The model ids the gateway metered for the execution at `epoch`. */
    readonly meteredModels: (
      executionId: string,
      epoch: number,
    ) => Effect.Effect<readonly string[]>;
  }
>()("@fractalboxdev/flare-dispatch-cache/StatementRecords") {}

const Digest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));

/** The result submission a statement arrives with: the submitting executor, the execution and its artifact digests. */
export const ResultSubmission = Schema.Struct({
  execution_id: Schema.String,
  epoch: Schema.Number,
  executor_id: Schema.String,
  artifacts: Schema.Array(Schema.Struct({ name: Schema.String, digest: Digest })),
});
export type ResultSubmission = typeof ResultSubmission.Type;

const LeaseClaim = Schema.Struct({
  execution_id: Schema.String,
  epoch: Schema.Number,
  nonce: Schema.String,
  executor_id: Schema.String,
  binding_kind: BindingKind,
});

const Descriptor = Schema.Struct({
  name: Schema.optional(Schema.String),
  digest: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  annotations: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
type Descriptor = typeof Descriptor.Type;

const SlsaClaims = Schema.Struct({
  subject: Schema.Array(Descriptor),
  predicateType: Schema.Literal(SLSA_PROVENANCE_V1),
  predicate: Schema.Struct({
    buildDefinition: Schema.Struct({ internalParameters: Schema.Struct({ lease: LeaseClaim }) }),
    runDetails: Schema.Struct({
      builder: Schema.Struct({
        version: Schema.optional(Schema.Struct({ code_hash: Schema.optional(Schema.String) })),
      }),
      byproducts: Schema.Array(Descriptor),
    }),
  }),
});

const TestResultClaims = Schema.Struct({
  subject: Schema.Array(Descriptor),
  predicateType: Schema.Literal(TEST_RESULT_V0_1),
  predicate: Schema.Struct({ configuration: Schema.Array(Descriptor) }),
});

const decodeSlsa = Schema.decodeUnknownOption(SlsaClaims);
const decodeTestResult = Schema.decodeUnknownOption(TestResultClaims);
const decodeLease = Schema.decodeUnknownOption(LeaseClaim);
const decodeSubmission = Schema.decodeUnknownOption(ResultSubmission);
const decodeEnvelope = Schema.decodeUnknownOption(DsseEnvelope);

/** What the checks read from a statement's payload. */
interface StatementClaims {
  readonly lease: typeof LeaseClaim.Type;
  readonly subjectDigests: readonly string[];
  readonly codeHash: string | null;
  readonly models: readonly string[];
}

const modelsOf = (descriptors: readonly Descriptor[]) =>
  descriptors.flatMap((d) => (d.name?.startsWith("model:") ? [d.name.slice("model:".length)] : []));

const sha256Subjects = (subject: readonly Descriptor[]) =>
  subject.flatMap((s) =>
    s.digest?.["sha256"] === undefined ? [] : [`sha256:${s.digest["sha256"]}`],
  );

const stringOr = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The lease binding, subjects, code hash and model list of a statement payload; `undefined` when it carries none. */
const claimsOf = (payload: Uint8Array): StatementClaims | undefined => {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
  const slsa = Option.getOrUndefined(decodeSlsa(json));
  if (slsa !== undefined)
    return {
      lease: slsa.predicate.buildDefinition.internalParameters.lease,
      subjectDigests: sha256Subjects(slsa.subject),
      codeHash: slsa.predicate.runDetails.builder.version?.code_hash ?? null,
      models: modelsOf(slsa.predicate.runDetails.byproducts),
    };
  const gate = Option.getOrUndefined(decodeTestResult(json));
  if (gate === undefined) return undefined;
  const named = (name: string) => gate.predicate.configuration.find((d) => d.name === name);
  const lease = Option.getOrUndefined(decodeLease(named("lease")?.annotations));
  if (lease === undefined) return undefined;
  return {
    lease,
    subjectDigests: sha256Subjects(gate.subject),
    codeHash: stringOr(named("builder")?.annotations?.["code_hash"]),
    models: modelsOf(gate.predicate.configuration),
  };
};

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

const sameList = (a: readonly string[], b: readonly string[]) => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * A statement's verdict. `signer` is the signing executor: the executor the device registry records for the key whose
 * signature verified, or, while no registered key's signature verifies, the executor that submitted the result.
 */
export type AcceptanceVerdict = Data.TaggedEnum<{
  Accepted: { readonly signer: string; readonly executionId: string };
  Rejected: {
    readonly reason: AcceptanceReason;
    readonly signer: string;
    readonly executionId: string;
  };
}>;
export const AcceptanceVerdict = Data.taggedEnum<AcceptanceVerdict>();

export interface AcceptanceSettings {
  /** `attestation_max_age` from the operator overlay, in milliseconds (FD-PROV-016). */
  readonly attestationMaxAgeMs: number;
}

/**
 * Runs the acceptance table's twelve checks on a statement, in table order, stopping at the first that fails. Check 1
 * verifies the envelope's one signature with the registered key its `keyid` names; a `keyid` that names no registered
 * key leaves nothing to verify against and fails check 2. A statement whose payload carries no lease binding, or whose
 * lease binding names an execution other than the submission's, names no lease the control plane issued for this
 * result and fails check 5.
 */
export const evaluateStatement = (
  submission: ResultSubmission,
  envelope: DsseEnvelope,
  now: number,
  settings: AcceptanceSettings,
): Effect.Effect<AcceptanceVerdict, never, StatementRecords> =>
  Effect.gen(function* () {
    const records = yield* StatementRecords;
    const executionId = submission.execution_id;
    const reject = (reason: AcceptanceReason, signer: string) =>
      AcceptanceVerdict.Rejected({ reason, signer, executionId });

    // 1–2. The device's signature, by a key in the registry.
    const [signature, ...extra] = envelope.signatures;
    if (signature === undefined || extra.length > 0)
      return reject("bad-signature", submission.executor_id);
    const device = yield* records.deviceKey(signature.keyid);
    if (device === null) return reject("unknown-key", submission.executor_id);
    const verified = yield* Effect.promise(() =>
      verifyDsseSignature(device.publicKey, envelope, signature),
    );
    if (!verified) return reject("bad-signature", submission.executor_id);
    const signer = device.executorId;

    // 3–4. The key is not revoked, and the device attested within `attestation_max_age`.
    if (device.revokedAt !== null && device.revokedAt <= now) return reject("revoked-key", signer);
    if (device.attestedAt === null || now - device.attestedAt >= settings.attestationMaxAgeMs)
      return reject("attestation-expired", signer);

    // 5–9. The lease or registration at the statement's epoch, its executor, the execution's current epoch and the
    // nonce. Check 6 compares the signer against the lease the statement names, not the execution's current one: after
    // a reclaim, the previous holder's statement for its own epoch is stale (check 7), not another executor's forgery.
    const payload = fromBase64(envelope.payload);
    const claims = payload === undefined ? undefined : claimsOf(payload);
    if (claims === undefined || claims.lease.execution_id !== executionId)
      return reject("unissued-lease", signer);
    const epoch = claims.lease.epoch;
    const issued = yield* records.issued(executionId, epoch);
    if (issued === null) return reject("unissued-lease", signer);
    if (issued.executorId !== signer) return reject("wrong-executor", signer);
    if (epoch !== (yield* records.currentEpoch(executionId))) return reject("stale-epoch", signer);
    const nonce = yield* records.issuedNonce(executionId, epoch);
    if (nonce === null || nonce !== claims.lease.nonce) return reject("nonce-mismatch", signer);
    if (yield* records.nonceConsumed(nonce)) return reject("nonce-reused", signer);

    // 10–12. Subject digests, the key helper's code hash and the metered models.
    if (
      !sameList(
        claims.subjectDigests,
        submission.artifacts.map((a) => a.digest),
      )
    )
      return reject("digest-mismatch", signer);
    if (device.codeHash === null || claims.codeHash !== device.codeHash)
      return reject("code-hash-mismatch", signer);
    const metered = yield* records.meteredModels(executionId, epoch);
    if (!sameSet(claims.models, metered)) return reject("model-mismatch", signer);

    return AcceptanceVerdict.Accepted({ signer, executionId });
  });

/**
 * The reaction to a rejection (FD-PROV-027): where the reason shows the signing executor or its key compromised, the
 * executor's quarantine flag is set, so the executor channel refuses its connection and placement skips it, and the
 * `provenance-quarantine` page alarm is raised. Every other reason is the execution's failure alone. An alarm the port
 * cannot deliver is logged; the quarantine and the rejection stand.
 */
export const reactToRejection = (
  rejection: Data.TaggedEnum.Value<AcceptanceVerdict, "Rejected">,
): Effect.Effect<void, never, LeaseStore | AlarmPort> =>
  Effect.gen(function* () {
    if (!QUARANTINE_REASONS.has(rejection.reason)) return;
    const executors = yield* LeaseStore;
    const quarantined = yield* executors.setFlags(rejection.signer, { quarantine: true });
    const alarms = yield* AlarmPort;
    yield* alarms
      .deliver({
        name: PROVENANCE_QUARANTINE_ALARM,
        severity: "page",
        dedupeKey: `${PROVENANCE_QUARANTINE_ALARM}:${rejection.signer}`,
        state: "raised",
        detail: {
          executor_id: rejection.signer,
          execution_id: rejection.executionId,
          reason: `provenance: ${rejection.reason}`,
          quarantined,
        },
      })
      .pipe(
        Effect.catchTag("AlarmDeliveryFailed", (e) =>
          Effect.logWarning("provenance quarantine alarm undelivered", e.reason),
        ),
      );
  });

/**
 * The `ResultAcceptanceCheck` port over the control plane's statement records, executor registry and alarm port. A
 * result or statement that does not decode names no lease the control plane issued and is rejected `unissued-lease`.
 */
export const resultAcceptanceCheckLayer = (
  settings: AcceptanceSettings = { attestationMaxAgeMs: DEFAULT_ATTESTATION_MAX_AGE_MS },
): Layer.Layer<ResultAcceptanceCheck, never, StatementRecords | LeaseStore | AlarmPort> =>
  Layer.effect(
    ResultAcceptanceCheck,
    Effect.gen(function* () {
      const context = yield* Effect.context<StatementRecords | LeaseStore | AlarmPort>();
      return {
        check: (result: unknown, statement: unknown) =>
          Effect.gen(function* () {
            const submission = Option.getOrUndefined(decodeSubmission(result));
            const envelope = Option.getOrUndefined(decodeEnvelope(statement));
            if (submission === undefined || envelope === undefined)
              return { _tag: "rejected", reasonKind: "provenance: unissued-lease" } as const;
            const now = yield* Clock.currentTimeMillis;
            const verdict = yield* evaluateStatement(submission, envelope, now, settings);
            return yield* AcceptanceVerdict.$match(verdict, {
              Accepted: () => Effect.succeed({ _tag: "accepted" } as const),
              Rejected: (rejection) =>
                Effect.as(reactToRejection(rejection), {
                  _tag: "rejected",
                  reasonKind: `provenance: ${rejection.reason}`,
                } as const),
            });
          }).pipe(Effect.provide(context)),
      };
    }),
  );
