// The `TransparencyLog` Durable Object: the only writer of the private transparency log (FD-PROV-074). One object,
// `idFromName("private")`, records each leaf at its index in its SQLite storage before it writes the leaf to R2, and
// writes the log's leaves and tiles with create-only puts (log.ts). An append arms the object's alarm, which signs the checkpoint no later than
// `CHECKPOINT_DELAY_MS` after it (FD-PROV-037), then sends it to each witness the current verification policy names and
// stores each cosignature returned (FD-PROV-039, witness.ts). A round that leaves a cosignature missing re-arms the
// alarm with back-off; an append still arms it within `CHECKPOINT_DELAY_MS`.
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import {
  appendEntry,
  CHECKPOINT_DELAY_MS,
  CheckpointOutcome,
  logStore,
  proveInclusion,
  publishCheckpoint,
  refusedOutcome,
  type AppendOutcome,
  type LogStore,
  type PrivateLogInclusionProof,
  type TransparencyLogConfig,
} from "./log.ts";
import { cosignCheckpoint, CosignOutcome, witnessRetryDelay } from "./witness.ts";

export * from "./log.ts";
export * from "./witness.ts";

/** A plain copy of an outcome: RPC carries plain objects, not the tagged-enum values `Data` builds. */
const plain = <A extends object>(value: A): A => ({ ...value });

/**
 * The `TransparencyLog` Durable Object class. A deploy subclasses it with `config()`: the bucket, the log key, the
 * checkpoint origin and the alarm port. Appends and checkpoint runs go one at a time, in arrival order.
 */
export abstract class TransparencyLog<Env = unknown> extends DurableObject<Env> {
  private readonly store: LogStore;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = logStore(ctx.storage.sql);
  }

  protected abstract config(): TransparencyLogConfig;

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Appends one entry, the countersigned envelope's bytes, and arms the checkpoint alarm (FD-PROV-074). An append
   * whose leaf write fails still arms it: the leaf is recorded, and the checkpoint run writes it first.
   */
  append(entry: Uint8Array): Promise<AppendOutcome> {
    return this.serial(async () => {
      const config = this.config();
      const now = Date.now();
      try {
        const outcome = await Effect.runPromise(
          appendEntry(this.store, config, entry, now).pipe(
            Effect.catchTag("PrivateLogWriteRefused", refusedOutcome(config)),
          ),
        );
        return plain(outcome);
      } finally {
        const armed = await this.ctx.storage.getAlarm();
        // A witness retry may be armed further out than the checkpoint bound allows.
        if (
          this.store.signedSize() < this.store.size() &&
          (armed === null || armed > now + CHECKPOINT_DELAY_MS)
        )
          await this.ctx.storage.setAlarm(now + CHECKPOINT_DELAY_MS);
      }
    });
  }

  /** The number of leaves the object has assigned. */
  size(): number {
    return this.store.size();
  }

  /**
   * The inclusion proof of leaf `index` against the published checkpoint, or `null` while no checkpoint covers it. A
   * failed checkpoint read rejects.
   */
  inclusionProof(index: number): Promise<PrivateLogInclusionProof | null> {
    return Effect.runPromise(proveInclusion(this.store, this.config(), index)).then((proof) =>
      proof === null ? null : { ...proof, hashes: [...proof.hashes] },
    );
  }

  /** When the armed checkpoint alarm fires, or `null` when none is armed. */
  checkpointDueAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** Signs a checkpoint over every recorded leaf; a store failure or a missing log key fails, so the alarm retries. */
  checkpoint(): Promise<CheckpointOutcome> {
    return this.serial(async () => {
      const config = this.config();
      const outcome = await Effect.runPromise(
        publishCheckpoint(this.store, config, Date.now()).pipe(
          Effect.catchTag("PrivateLogWriteRefused", refusedOutcome(config)),
        ),
      );
      return plain(outcome);
    });
  }

  /**
   * Sends the published checkpoint to each witness of the current policy whose cosignature it lacks, and writes each
   * cosignature returned onto it (FD-PROV-039). A failed read of the policy or the checkpoint rejects.
   */
  witness(): Promise<CosignOutcome> {
    return this.serial(async () =>
      plain(await Effect.runPromise(cosignCheckpoint(this.store, this.config()))),
    );
  }

  /**
   * Signs the checkpoint and sends it to the witnesses. It re-arms itself when a leaf appended while it ran is still
   * unsigned, and with back-off when a witness's cosignature is still missing. A refusal does not re-arm: the next
   * append does, and pages again.
   */
  override async alarm(): Promise<void> {
    const outcome = await this.checkpoint();
    console.log(JSON.stringify({ privateLogCheckpoint: outcome }));
    if (CheckpointOutcome.$is("Refused")(outcome)) return;
    const witnessed = await this.witness().catch((e: unknown) => {
      console.error(
        JSON.stringify({ privateLogWitnesses: e instanceof Error ? e.message : String(e) }),
      );
      return undefined;
    });
    if (witnessed !== undefined) console.log(JSON.stringify({ privateLogWitnesses: witnessed }));
    const missing =
      witnessed === undefined ||
      (CosignOutcome.$is("Witnessed")(witnessed) && witnessed.failed.length > 0);
    const failures = missing ? this.store.witnessFailures() + 1 : 0;
    this.store.setWitnessFailures(failures);
    const now = Date.now();
    const due = [
      ...(CheckpointOutcome.$is("Published")(outcome) && this.store.signedSize() < this.store.size()
        ? [now + CHECKPOINT_DELAY_MS]
        : []),
      ...(missing ? [now + witnessRetryDelay(failures)] : []),
    ];
    if (due.length > 0) await this.ctx.storage.setAlarm(Math.min(...due));
  }
}
