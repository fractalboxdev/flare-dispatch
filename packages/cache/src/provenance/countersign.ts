// The control plane's countersignature (specs/provenance.md § Countersignature and transparency log). Once the
// result-acceptance check accepts a statement, the control plane adds a signature by the active provenance key to the
// envelope's signature list, beside the device signature it verified (FD-PROV-032). A statement from capacity-lease
// work with no registration binds to no execution the control plane issued, so it is never countersigned and its
// result stays advisory (FD-PROV-025).
import { Data, Effect } from "effect";
import {
  EnvelopeMalformed,
  envelopePae,
  ProvenanceKeyInvalid,
  signPae,
  type DsseEnvelope,
  type ProvenanceKey,
} from "./dsse.ts";

/** What binds an accepted statement's work, as the control plane resolved it from its own records. */
export type StatementBinding = Data.TaggedEnum<{
  /** An execution lease the control plane granted: the device or cloud executor ran a scheduled execution. */
  ExecutionLease: { readonly executionId: string; readonly epoch: number };
  /** Local work under a capacity lease that `local.register` bound to an execution id. */
  Registration: { readonly executionId: string; readonly leaseId: string; readonly epoch: number };
  /** Local work under a capacity lease with no registration: no execution id the control plane issued names it. */
  UnregisteredCapacityLease: { readonly leaseId: string; readonly epoch: number };
}>;
export const StatementBinding = Data.taggedEnum<StatementBinding>();

/** What the control plane does with an accepted statement. */
export type CountersignOutcome = Data.TaggedEnum<{
  /** The envelope with the provenance key's countersignature added; ready for the transparency log. */
  Countersigned: { readonly envelope: DsseEnvelope; readonly keyid: string };
  /** The envelope unchanged and no countersignature; the work's result stays advisory. */
  Advisory: { readonly envelope: DsseEnvelope };
}>;
export const CountersignOutcome = Data.taggedEnum<CountersignOutcome>();

/**
 * Adds a countersignature by the active provenance key to the envelope's signature list (FD-PROV-032). Every other
 * signature stays in place, in order. A signature already in the list under the provenance key's `kid` is not the
 * control plane's to trust, since the device chose the list, so it is dropped and the fresh countersignature appended.
 */
export const countersign = (
  envelope: DsseEnvelope,
  key: ProvenanceKey,
): Effect.Effect<DsseEnvelope, EnvelopeMalformed | ProvenanceKeyInvalid> =>
  Effect.gen(function* () {
    const pae = envelopePae(envelope);
    if (pae === undefined)
      return yield* Effect.fail(new EnvelopeMalformed({ message: "the envelope payload is not base64" }));
    const signature = yield* Effect.tryPromise({
      try: () => signPae(key, pae),
      catch: () =>
        new ProvenanceKeyInvalid({ kid: key.kid, message: "the provenance key does not import" }),
    });
    return {
      ...envelope,
      signatures: [...envelope.signatures.filter((s) => s.keyid !== key.kid), signature],
    };
  });

/**
 * The control plane's step after it accepts a statement: countersign it with the active provenance key when an
 * execution lease or a registration binds its work (FD-PROV-032), and keep it uncountersigned and its result advisory
 * when the work is capacity-lease work with no registration (FD-PROV-025).
 */
export const countersignAccepted = (
  envelope: DsseEnvelope,
  binding: StatementBinding,
  key: ProvenanceKey,
): Effect.Effect<CountersignOutcome, EnvelopeMalformed | ProvenanceKeyInvalid> => {
  const signed = Effect.map(countersign(envelope, key), (countersigned) =>
    CountersignOutcome.Countersigned({ envelope: countersigned, keyid: key.kid }),
  );
  return StatementBinding.$match(binding, {
    ExecutionLease: () => signed,
    Registration: () => signed,
    UnregisteredCapacityLease: () => Effect.succeed(CountersignOutcome.Advisory({ envelope })),
  });
};
