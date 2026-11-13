// The `TransparencyLog` Durable Object: the only writer of the private transparency log (FD-PROV-074). One object,
// `idFromName("private")`, records each leaf at its index in its SQLite storage before it writes the leaf to R2, and
// writes the log's leaves and tiles with create-only puts (log.ts). An append arms the object's alarm, which signs the checkpoint no later than
// `CHECKPOINT_DELAY_MS` after it (FD-PROV-037).
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import {
  appendEntry,
  CHECKPOINT_DELAY_MS,
  CheckpointOutcome,
  logStore,
  publishCheckpoint,
  refusedOutcome,
  type AppendOutcome,
  type LogStore,
  type TransparencyLogConfig,
} from "./log.ts";

export * from "./log.ts";

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
        if (
          this.store.signedSize() < this.store.size() &&
          (await this.ctx.storage.getAlarm()) === null
        )
          await this.ctx.storage.setAlarm(now + CHECKPOINT_DELAY_MS);
      }
    });
  }

  /** The number of leaves the object has assigned. */
  size(): number {
    return this.store.size();
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
   * Signs the checkpoint, and re-arms itself when a leaf appended while it ran is still unsigned. A refusal does not
   * re-arm: the next append does, and pages again.
   */
  override async alarm(): Promise<void> {
    const outcome = await this.checkpoint();
    console.log(JSON.stringify({ privateLogCheckpoint: outcome }));
    if (CheckpointOutcome.$is("Published")(outcome) && this.store.signedSize() < this.store.size())
      await this.ctx.storage.setAlarm(Date.now() + CHECKPOINT_DELAY_MS);
  }
}
