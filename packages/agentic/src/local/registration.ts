// FlareDispatch's local registration port: what a rehearsal registers, the local submit through intake that admits
// it, and the execution id and nonce it receives (specs/local-scheduler.md § Rehearsal and registration,
// MAMEKO-PROTO-089, MAMEKO-LOCAL-069, FD-INT-061).
import { LocalRegistration } from "@fractalboxdev/mameko-ports";
import { Clock, Context, Effect, Exit, Layer, Schema } from "effect";
import { LocalStore, Provenance, type RegistrationRecord } from "./store.ts";

/** What the local scheduler asks of a registration: reuse, writeback, or both. */
export interface RegistrationWants {
  readonly reuse: boolean;
  readonly writeback: boolean;
}

/** A local execution registers exactly when it requests rehearsal reuse or writeback (FD-LOCAL-075). */
export const needsRegistration = (wants: RegistrationWants): boolean =>
  wants.reuse || wants.writeback;

/**
 * The registration payload `local.register` carries beside its provenance fields: the ref the rehearsal tested and
 * the run inputs whose digest is `inputsDigest`, which intake decodes against the run.
 */
export const RegistrationPayload = Schema.Struct({
  ...Provenance.fields,
  reuseKey: Schema.NonEmptyString,
  scopeId: Schema.NonEmptyString,
  executorId: Schema.NonEmptyString,
  repository: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  ref: Schema.NonEmptyString,
  inputs: Schema.Unknown,
  environmentNames: Schema.Array(Schema.String),
  wants: Schema.Struct({ reuse: Schema.Boolean, writeback: Schema.Boolean }),
});
export type RegistrationPayload = typeof RegistrationPayload.Type;

/** What a registration submits through intake as one admission request of trigger kind `local`. */
export interface LocalSubmission {
  readonly repository: string;
  readonly baseCommit: string;
  readonly ref: string;
  readonly treeHash: string;
  readonly inputsDigest: string;
  readonly inputs: unknown;
}

/** Intake's answer to a local submit: the admitted execution, or a refusal that admitted nothing. */
export type LocalSubmitAnswer =
  | { readonly _tag: "admitted"; readonly executionId: string }
  | { readonly _tag: "rejected" };

/**
 * The local submit through intake: trigger kind `local`, class `batch` and the `local-only` placement constraint, so
 * the control plane posts no GitHub check and admits no cloud spend for it (FD-INT-061). A run outside the catalogue,
 * inputs the run rejects and a refusal by admission answer `rejected`.
 */
export class LocalSubmit extends Context.Service<
  LocalSubmit,
  {
    readonly submit: (
      lease: { readonly leaseId: string; readonly epoch: number },
      run: string,
      submission: LocalSubmission,
    ) => Effect.Effect<LocalSubmitAnswer>;
  }
>()("@fractalboxdev/flare-dispatch-agentic/LocalSubmit") {}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A registration nonce's length: 128 random bits (FD-PROV-012). */
export const REGISTRATION_NONCE_BYTES = 16;

const decodeRegistration = Schema.decodeUnknownExit(RegistrationPayload);

/**
 * Whether a stored record holds exactly what this registration describes. Intake's local dedup key covers only the
 * lease, run, tree hash and inputs digest, so a repeat under that key may still differ on the rest of its provenance.
 */
const recordMatches = (prior: RegistrationRecord, r: RegistrationPayload): boolean => {
  const names = [...r.environmentNames].sort();
  return (
    prior.baseCommit === r.baseCommit &&
    prior.runDigest === r.runDigest &&
    prior.imageDigest === r.imageDigest &&
    prior.platform === r.platform &&
    prior.reuseKey === r.reuseKey &&
    prior.scopeId === r.scopeId &&
    prior.executorId === r.executorId &&
    prior.repository === r.repository &&
    prior.environmentNames.length === names.length &&
    prior.environmentNames.every((name, i) => name === names[i]) &&
    prior.wantsReuse === r.wants.reuse &&
    prior.wantsWriteback === r.wants.writeback
  );
};

/**
 * Registers one rehearsal: submits it through intake, records its environment names beside the tree hash, base
 * commit, run-definition digest, image digest, platform and inputs digest under the admitted execution id
 * (FD-LOCAL-072), and issues a nonce of 128 random bits stored with that execution id, the capacity lease id and the
 * capacity-lease epoch (FD-PROV-012). A registration that requests neither reuse nor writeback, fails to
 * decode or that intake refuses is rejected, so the execution runs unregistered (MAMEKO-LOCAL-070). A repeated
 * registration that intake deduplicates to an already registered execution receives that record's nonce only when the
 * record holds exactly its provenance, scope, reuse key, environment names and wants; any other repeat is rejected, so
 * the record keeps describing what the first rehearsal tested.
 */
export const registerRehearsal = (
  lease: { readonly leaseId: string; readonly epoch: number },
  run: string,
  registration: unknown,
) =>
  Effect.gen(function* () {
    const decoded = decodeRegistration(registration);
    if (Exit.isFailure(decoded) || !needsRegistration(decoded.value.wants))
      return { _tag: "rejected" } as const;
    const r = decoded.value;
    const submitted = yield* (yield* LocalSubmit).submit(lease, run, {
      repository: r.repository,
      baseCommit: r.baseCommit,
      ref: r.ref,
      treeHash: r.treeHash,
      inputsDigest: r.inputsDigest,
      inputs: r.inputs,
    });
    if (submitted._tag === "rejected") return { _tag: "rejected" } as const;
    const { executionId } = submitted;
    const store = yield* LocalStore;
    const prior = yield* store.byExecution(executionId);
    if (prior !== null)
      return recordMatches(prior, r)
        ? ({ _tag: "accepted", executionId, nonce: prior.nonce } as const)
        : ({ _tag: "rejected" } as const);
    const now = yield* Clock.currentTimeMillis;
    const nonce = hex(crypto.getRandomValues(new Uint8Array(REGISTRATION_NONCE_BYTES)));
    yield* store.insert({
      executionId,
      scopeId: r.scopeId,
      executorId: r.executorId,
      leaseId: lease.leaseId,
      epoch: lease.epoch,
      run,
      reuseKey: r.reuseKey,
      repository: r.repository,
      treeHash: r.treeHash,
      baseCommit: r.baseCommit,
      runDigest: r.runDigest,
      imageDigest: r.imageDigest,
      platform: r.platform,
      inputsDigest: r.inputsDigest,
      environmentNames: [...r.environmentNames].sort(),
      wantsReuse: r.wants.reuse,
      wantsWriteback: r.wants.writeback,
      nonce,
      registeredAt: now,
      startedAt: null,
      outcome: null,
      statementId: null,
      statementAccepted: false,
    });
    return { _tag: "accepted", executionId, nonce } as const;
  });

/**
 * The `LocalRegistration` port Layer, the one the control plane mounts. A store failure rejects the registration, so
 * the rehearsal runs unregistered and advisory rather than being reused on a record that was never written.
 */
export const localRegistrationLayer: Layer.Layer<
  LocalRegistration,
  never,
  LocalStore | LocalSubmit
> = Layer.effect(
  LocalRegistration,
  Effect.gen(function* () {
    const context = yield* Effect.context<LocalStore | LocalSubmit>();
    return {
      register: (lease, run, registration) =>
        registerRehearsal(lease, run, registration).pipe(
          Effect.provide(context),
          Effect.catchTag("LocalStoreFailed", () => Effect.succeed({ _tag: "rejected" } as const)),
        ),
    };
  }),
);
