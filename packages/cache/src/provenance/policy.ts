// The verification policy and the control plane's key history (specs/provenance.md § Verification policy, § Verification
// policy and key history). The operator signs each policy version with the policy root key, which the control plane
// never holds (FD-PROV-045), and publishes it as a DSSE envelope; the control plane checks it, appends it to the private
// transparency log, and only then serves it (FD-PROV-046), the latest logged version as the current policy and every
// earlier one by its `policy_version` (FD-PROV-044).
//
// The control plane keeps its own record of every provenance key and log key it has used, each with its validity
// window, and never removes an entry (FD-PROV-047). A publish records each key the deploy holds; a key the control plane
// has not recorded before rotates the role: the retired key's `not_after` is set to the new key's `not_before`, the
// instant of that publish (FD-PROV-048). The operator reads the recorded windows from the key-history route, and every
// key-history refusal names the entry the control plane expects. A policy version whose key history drops or changes
// an entry of the earlier version, repeats a kid, or omits or misstates a key the control plane has used, is refused. A
// policy that lets a `managed-workstation` builder claim a SLSA Build level above L1 is refused at publish and at every
// serve (FD-PROV-052).
//
// Times are milliseconds since the Unix epoch, as log entries' integrated times are.
import { Context, Effect, Option, Schema } from "effect";
import { canonicalJson } from "../crypto.ts";
import type { LogAppendFailed, LogEntry } from "./append.ts";
import { LogKind } from "./append.ts";
import { fromBase64, type ProvenanceKey } from "./dsse.ts";

/** The DSSE payload type of a verification-policy envelope. */
export const POLICY_PAYLOAD_TYPE = "application/vnd.flare-dispatch.provenance-policy+json";

/** The highest SLSA Build level a `managed-workstation` builder may claim (FD-PROV-052). */
export const MANAGED_WORKSTATION_MAX_SLSA_LEVEL = 1;

const Millis = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/** A public ES256 JWK, as the key history publishes it. */
export const PublicKeyJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.NonEmptyString,
  y: Schema.NonEmptyString,
});
export type PublicKeyJwk = typeof PublicKeyJwk.Type;

/** One key of a key history: valid from `not_before` up to, not including, `not_after`; absent for the active key. */
export const KeyHistoryEntry = Schema.Struct({
  kid: Schema.NonEmptyString,
  jwk: PublicKeyJwk,
  not_before: Millis,
  not_after: Schema.optionalKey(Millis),
});
export type KeyHistoryEntry = typeof KeyHistoryEntry.Type;

export const PostureTier = Schema.Literals(["attested-dedicated", "managed-workstation"]);
export const ProvenanceTier = Schema.Literals(["device-signed", "platform", "reproduced"]);
export const SlsaBuildLevel = Schema.Literals([0, 1, 2, 3]);

export const PolicyDevice = Schema.Struct({
  key_thumbprint: Schema.NonEmptyString,
  executor_id: Schema.NonEmptyString,
  posture_tier: PostureTier,
  registered_at: Millis,
  revoked_at: Schema.NullOr(Millis),
  compromised_from: Schema.NullOr(Millis),
});

/**
 * A witness of the private log: its name, its C2SP note verifier key (`<name>+<key id hex>+<base64 key>`), and `url`,
 * the C2SP tlog-witness submission prefix the control plane sends each new checkpoint to, at `<url>/add-checkpoint`
 * (FD-PROV-039).
 */
export const PolicyWitness = Schema.Struct({
  name: Schema.NonEmptyString,
  key: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
});
export type PolicyWitness = typeof PolicyWitness.Type;

export const PolicyLog = Schema.Struct({
  kind: LogKind,
  keys: Schema.Array(KeyHistoryEntry),
  witnesses: Schema.optionalKey(Schema.Array(PolicyWitness)),
});

/** One version of the verification policy (specs/provenance.md § Verification policy). */
export const VerificationPolicy = Schema.Struct({
  policy_version: Schema.NonEmptyString,
  issued_at: Millis,
  provenance_keys: Schema.Array(KeyHistoryEntry),
  logs: Schema.Array(PolicyLog),
  devices: Schema.Array(PolicyDevice),
  required_tiers: Schema.Struct({
    release: ProvenanceTier,
    package: ProvenanceTier,
    image: ProvenanceTier,
    "pr-artifact": ProvenanceTier,
    preview: ProvenanceTier,
    verdict: ProvenanceTier,
  }),
  /** The SLSA Build level each builder tier may claim: the cloud builder and each device posture tier. */
  slsa_build_levels: Schema.Struct({
    cloud: SlsaBuildLevel,
    "attested-dedicated": SlsaBuildLevel,
    "managed-workstation": SlsaBuildLevel,
  }),
});
export type VerificationPolicy = typeof VerificationPolicy.Type;

/** A policy version as the operator publishes it: a DSSE envelope signed by the policy root key. */
export const PolicyEnvelope = Schema.Struct({
  payloadType: Schema.Literal(POLICY_PAYLOAD_TYPE),
  /** The policy's JSON serialization, standard base64. */
  payload: Schema.String,
  signatures: Schema.NonEmptyArray(Schema.Struct({ keyid: Schema.String, sig: Schema.String })),
});
export type PolicyEnvelope = typeof PolicyEnvelope.Type;

// ---------------------------------------------------------------------------------------------------------------------
// Errors

/**
 * Why the control plane refuses a policy version:
 *
 * - `malformed`: the envelope or its payload does not decode as a policy.
 * - `slsa-level`: a `managed-workstation` builder may claim a SLSA Build level above L1 (FD-PROV-052).
 * - `key-history`: the key history drops or changes an entry, or misses a key the control plane used (FD-PROV-047).
 * - `version-exists`: another envelope already holds this `policy_version`.
 */
export const PolicyRefusal = Schema.Literals([
  "malformed",
  "slsa-level",
  "key-history",
  "version-exists",
]);
export type PolicyRefusal = typeof PolicyRefusal.Type;

export class PolicyRefused extends Schema.TaggedError<PolicyRefused>()("PolicyRefused", {
  reason: PolicyRefusal,
  message: Schema.String,
}) {}

export class PolicyNotFound extends Schema.TaggedError<PolicyNotFound>()("PolicyNotFound", {
  policyVersion: Schema.NullOr(Schema.String),
}) {}

export class PolicyStoreFailed extends Schema.TaggedError<PolicyStoreFailed>()(
  "PolicyStoreFailed",
  { message: Schema.String },
) {}

/** A configured key whose validity window has closed: it was retired by a rotation and signs nothing (FD-PROV-048). */
export class SigningKeyRetired extends Schema.TaggedError<SigningKeyRetired>()(
  "SigningKeyRetired",
  { role: Schema.String, kid: Schema.String, notAfter: Schema.Number },
) {}

// ---------------------------------------------------------------------------------------------------------------------
// Checks

const decodePolicyJson = Schema.decodeUnknownOption(Schema.fromJsonString(VerificationPolicy));
const decodeEnvelope = Schema.decodeUnknownOption(PolicyEnvelope);

/** The policy an envelope carries, or a `malformed` refusal. */
export const decodePolicyEnvelope = (
  input: unknown,
): Effect.Effect<{ envelope: PolicyEnvelope; policy: VerificationPolicy }, PolicyRefused> => {
  const envelope = Option.getOrUndefined(decodeEnvelope(input));
  if (envelope === undefined)
    return Effect.fail(
      new PolicyRefused({
        reason: "malformed",
        message: `a policy is a DSSE envelope with payload type ${POLICY_PAYLOAD_TYPE} and at least one signature`,
      }),
    );
  const bytes = fromBase64(envelope.payload);
  const policy =
    bytes === undefined
      ? undefined
      : Option.getOrUndefined(decodePolicyJson(new TextDecoder().decode(bytes)));
  return policy === undefined
    ? Effect.fail(
        new PolicyRefused({
          reason: "malformed",
          message: "the envelope payload is not a verification policy",
        }),
      )
    : Effect.succeed({ envelope, policy });
};

/** Refuses a policy that lets a `managed-workstation` builder claim a SLSA Build level above L1 (FD-PROV-052). */
export const checkSlsaLevels = (policy: VerificationPolicy): Effect.Effect<void, PolicyRefused> => {
  const level = policy.slsa_build_levels["managed-workstation"];
  return level > MANAGED_WORKSTATION_MAX_SLSA_LEVEL
    ? Effect.fail(
        new PolicyRefused({
          reason: "slsa-level",
          message: `policy ${policy.policy_version} lets a managed-workstation builder claim SLSA Build L${level}; the most it may claim is L${MANAGED_WORKSTATION_MAX_SLSA_LEVEL}`,
        }),
      )
    : Effect.void;
};

/** The two roles whose keys the control plane holds and records. */
export const KeyRole = Schema.Literals(["provenance", "log"]);
export type KeyRole = typeof KeyRole.Type;

/** The keys the control plane has used, each role's history in the order it recorded them. */
export type RecordedKeys = Readonly<Record<KeyRole, readonly KeyHistoryEntry[]>>;

const sameJwk = (a: PublicKeyJwk, b: PublicKeyJwk) =>
  a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y;

/** Why `next` does not keep `kept` unchanged, naming the entry it expects, or `undefined` when it does. */
const entryMismatch = (
  where: string,
  kept: KeyHistoryEntry,
  next: readonly KeyHistoryEntry[],
): string | undefined => {
  const found = next.find((e) => e.kid === kept.kid);
  const problem =
    found === undefined
      ? `${where} drops key ${kept.kid}`
      : !sameJwk(found.jwk, kept.jwk)
        ? `${where} changes the public key of ${kept.kid}`
        : found.not_before !== kept.not_before
          ? `${where} gives ${kept.kid} not_before ${found.not_before}`
          : found.not_after !== kept.not_after
            ? `${where} gives ${kept.kid} not_after ${found.not_after ?? "absent"}`
            : undefined;
  return problem === undefined ? undefined : `${problem}; expected ${canonicalJson(kept)}`;
};

/** The kids a key history lists more than once: each kid names one entry, one window (FD-PROV-047). */
const repeatedKids = (where: string, entries: readonly KeyHistoryEntry[]): string | undefined => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const e of entries) (seen.has(e.kid) ? repeated : seen).add(e.kid);
  return repeated.size === 0 ? undefined : `${where} repeats key ${[...repeated].join(", ")}`;
};

/** A key of the previous version: kept as it was, except that an active key may be retired. */
const previousMismatch = (
  where: string,
  kept: KeyHistoryEntry,
  next: readonly KeyHistoryEntry[],
): string | undefined => {
  const found = next.find((e) => e.kid === kept.kid);
  return kept.not_after === undefined && found !== undefined && found.not_after !== undefined
    ? entryMismatch(where, { ...kept, not_after: found.not_after }, next)
    : entryMismatch(where, kept, next);
};

const logKeys = (policy: VerificationPolicy, kind: LogKind) =>
  policy.logs.filter((l) => l.kind === kind).flatMap((l) => l.keys);

/**
 * Refuses a policy version whose key history does not keep every entry of the previous version (FD-PROV-047): the same
 * public key and `not_before`, and the same `not_after`, which only an active key may gain. Every key the control
 * plane has used must appear with the window the control plane recorded: provenance keys in the provenance key
 * history, log keys in the private log's key history. A history that lists a kid twice is refused, so a verifier never
 * picks between two windows for one key.
 */
export const checkKeyHistory = (
  previous: VerificationPolicy | undefined,
  next: VerificationPolicy,
  recorded: RecordedKeys,
): Effect.Effect<void, PolicyRefused> => {
  const problems: string[] = [];
  const add = (problem: string | undefined) => {
    if (problem !== undefined) problems.push(problem);
  };
  add(repeatedKids("the provenance key history", next.provenance_keys));
  for (const kind of LogKind.literals)
    add(repeatedKids(`the ${kind} log's key history`, logKeys(next, kind)));
  if (previous !== undefined) {
    for (const kept of previous.provenance_keys)
      add(previousMismatch("the provenance key history", kept, next.provenance_keys));
    for (const kind of LogKind.literals)
      for (const kept of logKeys(previous, kind))
        add(previousMismatch(`the ${kind} log's key history`, kept, logKeys(next, kind)));
  }
  for (const used of recorded.provenance)
    add(entryMismatch("the provenance key history", used, next.provenance_keys));
  for (const used of recorded.log)
    add(entryMismatch("the private log's key history", used, logKeys(next, "private")));
  return problems.length === 0
    ? Effect.void
    : Effect.fail(
        new PolicyRefused({
          reason: "key-history",
          message: `policy ${next.policy_version}: ${[...new Set(problems)].join("; ")}`,
        }),
      );
};

// ---------------------------------------------------------------------------------------------------------------------
// The control plane's key history

/** What recording one use of a key changes in its role's history. */
export interface KeyUse {
  /** The active key the use retires, with `not_after` set to the use's instant. */
  readonly retire: KeyHistoryEntry | undefined;
  /** The new key, with `not_before` the use's instant. */
  readonly insert: KeyHistoryEntry | undefined;
}

/**
 * What a use of `key` at `at` changes in `history` (FD-PROV-048). A key already in the history changes nothing while
 * its window is open, and fails `SigningKeyRetired` from its `not_after` on. A new key rotates the role: the active key
 * gets `not_after` = `at` and the new key `not_before` = `at`, so the two windows meet at the instant of rotation.
 */
export const keyUse = (
  role: KeyRole,
  history: readonly KeyHistoryEntry[],
  key: { readonly kid: string; readonly jwk: PublicKeyJwk },
  at: number,
): Effect.Effect<KeyUse, SigningKeyRetired> => {
  const known = history.find((e) => e.kid === key.kid);
  if (known !== undefined)
    return known.not_after !== undefined && at >= known.not_after
      ? Effect.fail(new SigningKeyRetired({ role, kid: key.kid, notAfter: known.not_after }))
      : Effect.succeed({ retire: undefined, insert: undefined });
  const active = history.find((e) => e.not_after === undefined);
  const instant = active === undefined ? at : Math.max(at, active.not_before);
  return Effect.succeed({
    retire: active === undefined ? undefined : { ...active, not_after: instant },
    insert: { kid: key.kid, jwk: key.jwk, not_before: instant },
  });
};

/** The control plane's record of the keys it has used. Entries are added and retired, never removed (FD-PROV-047). */
export class KeyHistoryStore extends Context.Service<
  KeyHistoryStore,
  {
    readonly entries: (
      role: KeyRole,
    ) => Effect.Effect<readonly KeyHistoryEntry[], PolicyStoreFailed>;
    /** Applies a use's changes atomically: sets the retired key's `not_after` and adds the new key. */
    readonly apply: (role: KeyRole, use: KeyUse) => Effect.Effect<void, PolicyStoreFailed>;
  }
>()("@fractalboxdev/flare-dispatch-cache/KeyHistoryStore") {}

/**
 * The control plane's key history, each role's entries with the windows it recorded: what a published policy's key
 * history must carry (FD-PROV-047), and what the operator's key-history route answers.
 */
export const recordedKeys: Effect.Effect<RecordedKeys, PolicyStoreFailed, KeyHistoryStore> =
  Effect.gen(function* () {
    const history = yield* KeyHistoryStore;
    return {
      provenance: yield* history.entries("provenance"),
      log: yield* history.entries("log"),
    };
  });

const publicOf = (key: ProvenanceKey) => ({
  kid: key.kid,
  jwk: { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
});

/**
 * Records a use of `key` at `now` in the control plane's key history (FD-PROV-047), rotating the role when the key is
 * new (FD-PROV-048), and answers the key. A key whose window has closed fails `SigningKeyRetired` and signs nothing.
 */
export const useKey = (role: KeyRole, key: ProvenanceKey, now: number) =>
  Effect.gen(function* () {
    const store = yield* KeyHistoryStore;
    const use = yield* keyUse(role, yield* store.entries(role), publicOf(key), now);
    if (use.retire !== undefined || use.insert !== undefined) yield* store.apply(role, use);
    return key;
  });

// ---------------------------------------------------------------------------------------------------------------------
// Publishing and serving

/** One stored policy version. `entry` is absent until its log append succeeds; until then it is not served. */
export interface StoredPolicy {
  readonly policyVersion: string;
  /** The envelope's canonical JSON: the bytes the log appends and the route serves. */
  readonly envelope: string;
  readonly entry: LogEntry | undefined;
}

export class PolicyStore extends Context.Service<
  PolicyStore,
  {
    readonly get: (version: string) => Effect.Effect<StoredPolicy | undefined, PolicyStoreFailed>;
    /** The most recently logged version. */
    readonly current: () => Effect.Effect<StoredPolicy | undefined, PolicyStoreFailed>;
    /** Inserts a version unless one with its `policy_version` exists; answers whether it inserted. */
    readonly insert: (
      version: string,
      envelope: string,
      now: number,
    ) => Effect.Effect<boolean, PolicyStoreFailed>;
    /** Records the log entry of a version not yet logged; a logged version keeps its first entry. */
    readonly logged: (version: string, entry: LogEntry) => Effect.Effect<void, PolicyStoreFailed>;
  }
>()("@fractalboxdev/flare-dispatch-cache/PolicyStore") {}

/** The transparency log a policy version is appended to: the private log. */
export class PolicyTransparencyLog extends Context.Service<
  PolicyTransparencyLog,
  { readonly append: (envelopeJson: string) => Effect.Effect<LogEntry, LogAppendFailed> }
>()("@fractalboxdev/flare-dispatch-cache/PolicyTransparencyLog") {}

/** The keys the control plane holds now, which a published policy must carry in its key history. */
export interface KeysInUse {
  readonly provenance: ProvenanceKey | undefined;
  readonly log: ProvenanceKey | undefined;
}

const policyOfStored = (stored: StoredPolicy) =>
  decodePolicyEnvelope(JSON.parse(stored.envelope) as unknown);

/**
 * Publishes one policy version (FD-PROV-046): checks it (FD-PROV-047, FD-PROV-052), records the keys the control plane
 * holds in its key history, stores the version unserved, appends its envelope to the transparency log, and marks it
 * logged, which is what makes it servable. A failed append leaves the version unserved; publishing the same envelope
 * again retries the append. Answers the version and its log entry.
 */
export const publishPolicy = (input: unknown, keys: KeysInUse, now: number) =>
  Effect.gen(function* () {
    const { envelope, policy } = yield* decodePolicyEnvelope(input);
    yield* checkSlsaLevels(policy);
    const json = canonicalJson(envelope);
    const store = yield* PolicyStore;
    const existing = yield* store.get(policy.policy_version);
    if (existing !== undefined && existing.envelope !== json)
      return yield* Effect.fail(
        new PolicyRefused({
          reason: "version-exists",
          message: `policy version ${policy.policy_version} is already published with other content`,
        }),
      );
    if (existing?.entry !== undefined)
      return { policyVersion: policy.policy_version, entry: existing.entry };
    if (keys.provenance !== undefined) yield* useKey("provenance", keys.provenance, now);
    if (keys.log !== undefined) yield* useKey("log", keys.log, now);
    const recorded = yield* recordedKeys;
    const current = yield* store.current();
    const previous =
      current === undefined || current.policyVersion === policy.policy_version
        ? undefined
        : (yield* policyOfStored(current)).policy;
    yield* checkKeyHistory(previous, policy, recorded);
    if (existing === undefined) yield* store.insert(policy.policy_version, json, now);
    const log = yield* PolicyTransparencyLog;
    const entry = yield* log.append(json);
    yield* store.logged(policy.policy_version, entry);
    return { policyVersion: policy.policy_version, entry };
  });

/**
 * The witnesses the current policy names for the private log: what each new checkpoint is sent to (FD-PROV-039). With
 * no policy published, there are none.
 */
export const privateLogWitnesses: Effect.Effect<
  readonly PolicyWitness[],
  PolicyStoreFailed,
  PolicyStore
> = Effect.gen(function* () {
  const current = yield* (yield* PolicyStore).current();
  if (current === undefined) return [];
  const { policy } = yield* Effect.try({
    try: () => JSON.parse(current.envelope) as unknown,
    catch: () => new PolicyStoreFailed({ message: "the stored policy envelope is not JSON" }),
  }).pipe(
    Effect.flatMap(decodePolicyEnvelope),
    Effect.catchTag("PolicyRefused", (e) =>
      Effect.fail(
        new PolicyStoreFailed({ message: `the current policy is unreadable: ${e.message}` }),
      ),
    ),
  );
  return policy.logs.filter((l) => l.kind === "private").flatMap((l) => l.witnesses ?? []);
});

/**
 * The policy envelope to serve: the current version, or the version `policyVersion` names (FD-PROV-044). Only a logged
 * version is served (FD-PROV-046), and one that lets a `managed-workstation` builder claim above L1 is refused
 * (FD-PROV-052).
 */
export const servedPolicy = (policyVersion: string | undefined) =>
  Effect.gen(function* () {
    const store = yield* PolicyStore;
    const stored =
      policyVersion === undefined ? yield* store.current() : yield* store.get(policyVersion);
    if (stored?.entry === undefined)
      return yield* Effect.fail(new PolicyNotFound({ policyVersion: policyVersion ?? null }));
    const { envelope, policy } = yield* policyOfStored(stored);
    yield* checkSlsaLevels(policy);
    return envelope;
  });

// ---------------------------------------------------------------------------------------------------------------------
// The D1 stores

/** The tables of the policy versions and the key history. */
export const POLICY_SCHEMA = [
  `create table if not exists provenance_policies (
     policy_version text primary key,
     envelope text not null,
     inserted_at integer not null,
     log text,
     log_index integer,
     entry_id text,
     integrated_time integer,
     logged_seq integer)`,
  `create table if not exists provenance_key_history (
     role text not null,
     kid text not null,
     jwk text not null,
     not_before integer not null,
     not_after integer,
     primary key (role, kid))`,
];

interface PolicyRow {
  readonly policy_version: string;
  readonly envelope: string;
  readonly log: LogKind | null;
  readonly log_index: number | null;
  readonly entry_id: string | null;
  readonly integrated_time: number | null;
}

const storedOf = (row: PolicyRow): StoredPolicy => ({
  policyVersion: row.policy_version,
  envelope: row.envelope,
  entry:
    row.integrated_time === null
      ? undefined
      : {
          log: row.log ?? "private",
          logIndex: row.log_index ?? 0,
          entryId: row.entry_id ?? "",
          integratedTime: row.integrated_time,
        },
});

interface KeyRow {
  readonly kid: string;
  readonly jwk: string;
  readonly not_before: number;
  readonly not_after: number | null;
}

const entryOf = (row: KeyRow): KeyHistoryEntry => ({
  kid: row.kid,
  jwk: JSON.parse(row.jwk) as PublicKeyJwk,
  not_before: row.not_before,
  ...(row.not_after === null ? {} : { not_after: row.not_after }),
});

/** A runner over D1 that creates the policy tables on first use. */
const d1Runner = (db: D1Database) => {
  let ready: Promise<unknown> | undefined;
  return <A>(work: () => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        ready ??= db.batch(POLICY_SCHEMA.map((s) => db.prepare(s))).catch((e: unknown) => {
          ready = undefined;
          throw e;
        });
        await ready;
        return await work();
      },
      catch: (e) => new PolicyStoreFailed({ message: e instanceof Error ? e.message : String(e) }),
    });
};

export const d1PolicyStore = (db: D1Database): PolicyStore["Service"] => {
  const run = d1Runner(db);
  return {
    get: (version) =>
      run(async () => {
        const row = await db
          .prepare("select * from provenance_policies where policy_version = ?")
          .bind(version)
          .first<PolicyRow>();
        return row === null ? undefined : storedOf(row);
      }),
    current: () =>
      run(async () => {
        const row = await db
          .prepare(
            "select * from provenance_policies where logged_seq is not null order by logged_seq desc limit 1",
          )
          .first<PolicyRow>();
        return row === null ? undefined : storedOf(row);
      }),
    insert: (version, envelope, now) =>
      run(async () => {
        const result = await db
          .prepare(
            `insert into provenance_policies (policy_version, envelope, inserted_at) values (?, ?, ?)
             on conflict (policy_version) do nothing`,
          )
          .bind(version, envelope, now)
          .run();
        return result.meta.changes > 0;
      }),
    logged: (version, entry) =>
      run(() =>
        db
          .prepare(
            `update provenance_policies set log = ?, log_index = ?, entry_id = ?, integrated_time = ?,
               logged_seq = (select coalesce(max(logged_seq), 0) + 1 from provenance_policies)
             where policy_version = ? and logged_seq is null`,
          )
          .bind(entry.log, entry.logIndex, entry.entryId, entry.integratedTime, version)
          .run(),
      ).pipe(Effect.asVoid),
  };
};

export const d1KeyHistoryStore = (db: D1Database): KeyHistoryStore["Service"] => {
  const run = d1Runner(db);
  return {
    entries: (role) =>
      run(async () => {
        const { results } = await db
          .prepare(
            "select kid, jwk, not_before, not_after from provenance_key_history where role = ? order by not_before, kid",
          )
          .bind(role)
          .all<KeyRow>();
        return results.map(entryOf);
      }),
    // No statement deletes a row, and a retirement only sets the `not_after` of a key still active (FD-PROV-047).
    apply: (role, use) =>
      run(() =>
        db.batch([
          ...(use.retire === undefined
            ? []
            : [
                db
                  .prepare(
                    "update provenance_key_history set not_after = ? where role = ? and kid = ? and not_after is null",
                  )
                  .bind(use.retire.not_after ?? null, role, use.retire.kid),
              ]),
          ...(use.insert === undefined
            ? []
            : [
                db
                  .prepare(
                    `insert into provenance_key_history (role, kid, jwk, not_before) values (?, ?, ?, ?)
                     on conflict (role, kid) do nothing`,
                  )
                  .bind(
                    role,
                    use.insert.kid,
                    JSON.stringify(use.insert.jwk),
                    use.insert.not_before,
                  ),
              ]),
        ]),
      ).pipe(Effect.asVoid),
  };
};
