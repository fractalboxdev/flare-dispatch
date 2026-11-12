// FlareDispatch's local registration port: what a rehearsal registers, and the execution id and nonce it receives
// (specs/local-scheduler.md § Rehearsal and registration, MAMEKO-PROTO-082, MAMEKO-LOCAL-069).
import { LocalRegistration } from "@fractalboxdev/mameko-ports";
import { Clock, Effect, Exit, Layer, Schema } from "effect";
import { LocalStore, Provenance } from "./store.ts";

/** What the local scheduler asks of a registration: reuse, writeback, or both. */
export interface RegistrationWants {
  readonly reuse: boolean;
  readonly writeback: boolean;
}

/** A local execution registers exactly when it requests rehearsal reuse or writeback (FD-LOCAL-075). */
export const needsRegistration = (wants: RegistrationWants): boolean =>
  wants.reuse || wants.writeback;

/** The registration payload `local.register` carries beside its provenance fields. */
export const RegistrationPayload = Schema.Struct({
  ...Provenance.fields,
  reuseKey: Schema.NonEmptyString,
  scopeId: Schema.NonEmptyString,
  executorId: Schema.NonEmptyString,
  repository: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  environmentNames: Schema.Array(Schema.String),
  wants: Schema.Struct({ reuse: Schema.Boolean, writeback: Schema.Boolean }),
});
export type RegistrationPayload = typeof RegistrationPayload.Type;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID of 26 Crockford base32 characters: 48 bits of milliseconds, then 80 random bits (MAMEKO-ADM-032). */
export const ulid = (
  now: number,
  random: Uint8Array = crypto.getRandomValues(new Uint8Array(10)),
): string => {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = (CROCKFORD[t % 32] as string) + time;
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (const b of random) bits = (bits << 8n) | BigInt(b);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = (CROCKFORD[Number(bits & 31n)] as string) + rand;
    bits >>= 5n;
  }
  return time + rand;
};

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export interface RegistrationConfig {
  /** Whether the run is in the catalogue the control plane serves. */
  readonly runKnown: (run: string) => boolean;
}

const decodeRegistration = Schema.decodeUnknownExit(RegistrationPayload);

/**
 * Registers one rehearsal: records its environment names beside the tree hash, base commit, run-definition digest,
 * image digest, platform and inputs digest (FD-LOCAL-072), and issues a ULID execution id and a 256-bit nonce. A
 * registration that requests neither reuse nor writeback, names a run outside the catalogue or fails to decode is
 * rejected, so the execution runs unregistered (MAMEKO-LOCAL-070).
 */
export const registerRehearsal = (
  config: RegistrationConfig,
  lease: { readonly leaseId: string; readonly epoch: number },
  run: string,
  registration: unknown,
) =>
  Effect.gen(function* () {
    const decoded = decodeRegistration(registration);
    if (Exit.isFailure(decoded) || !needsRegistration(decoded.value.wants) || !config.runKnown(run))
      return { _tag: "rejected" } as const;
    const r = decoded.value;
    const store = yield* LocalStore;
    const now = yield* Clock.currentTimeMillis;
    const executionId = ulid(now);
    const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
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
 * The `LocalRegistration` port Layer. A store failure rejects the registration, so the rehearsal runs unregistered
 * and advisory rather than being reused on a record that was never written.
 */
export const localRegistrationLayer = (
  config: RegistrationConfig,
): Layer.Layer<LocalRegistration, never, LocalStore> =>
  Layer.effect(
    LocalRegistration,
    Effect.gen(function* () {
      const store = yield* LocalStore;
      return {
        register: (lease, run, registration) =>
          registerRehearsal(config, lease, run, registration).pipe(
            Effect.provideService(LocalStore, store),
            Effect.catchTag("LocalStoreFailed", () =>
              Effect.succeed({ _tag: "rejected" } as const),
            ),
          ),
      };
    }),
  );
