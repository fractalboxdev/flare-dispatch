// The control plane's `WritebackRecords` over its own stores: the staged write's blobs read back from the artifact
// store at the execution's accepted epoch, each with the SHA-256 digest of the bytes read; whether the model gateway
// recorded a call for the execution, and the model entries that answered its calls; and the credentials the control
// plane issued to it (specs/runs/agentic.md § Staged write, FD-AGT-013, FD-AGT-040). Every read that cannot be
// answered fails; none answers empty.
import { Effect, Layer } from "effect";
import type { D1Binding } from "../local/store.ts";
import { stagedBlobName, type ManifestEntry } from "../staged-write/manifest.ts";
import { StagedWriteReadFailed, textOf, WritebackRecords, type LoadedBlob } from "./applier.ts";

/** The part of an R2 bucket the blob read takes. */
export interface ArtifactObjects {
  get(key: string): Promise<{ readonly size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export interface WritebackRecordsConfig {
  /** The control plane's database: mameko's `placements`, `executors` and `model_calls` tables. */
  readonly db: D1Binding;
  /** The bucket that holds `artifacts/`; undefined on a deploy that binds none, where every blob read fails. */
  readonly artifacts: ArtifactObjects | undefined;
  /** The object key of an execution's artifact name at an epoch (`artifacts/<execution_id>/<epoch>/<name>`). */
  readonly artifactPath: (executionId: string, epoch: number, name: string) => string;
  /** Every credential the control plane issued to the execution, at any epoch (FD-AGT-029). */
  readonly issuedCredentials: (
    executionId: string,
  ) => Effect.Effect<readonly string[], StagedWriteReadFailed>;
}

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

const rows = <T>(db: D1Binding, source: string, query: string, ...values: unknown[]) =>
  Effect.tryPromise({
    try: async () =>
      (
        await db
          .prepare(query)
          .bind(...values)
          .all()
      ).results as T[],
    catch: (cause) => new StagedWriteReadFailed({ source, detail: String(cause) }),
  });

/** The placement's accepted epoch, else its current one, and the kind of executor that holds it. */
const placementOf = (db: D1Binding, executionId: string) =>
  Effect.gen(function* () {
    const [placement] = yield* rows<{ epoch: number; kind: string | null }>(
      db,
      "placements",
      `select coalesce(p.accepted_epoch, p.epoch) as epoch, x.kind as kind from placements p
       left join executors x on x.executor_id = p.executor_id where p.execution_id = ?`,
      executionId,
    );
    if (placement === undefined)
      return yield* new StagedWriteReadFailed({
        source: "placements",
        detail: `no placement for ${executionId}`,
      });
    return placement;
  });

/**
 * Reads each distinct blob of the entries from `artifacts/<execution_id>/<epoch>/staged-write/blobs/<sha256>` and
 * recomputes the SHA-256 digest of the bytes read, so the gate compares the manifest with what is stored rather than
 * with the key it was stored under. A blob absent from the store is left out, for the gate to reject as
 * `blob-missing`. When the stored sizes of the distinct blobs add up to more than `maxBytes`, no bytes are read, so an
 * oversized staged write never enters the isolate's memory: each blob carries its stored size with empty bytes, an
 * empty digest and no text, and the gate rejects the manifest as `too-large` (FD-AGT-026).
 */
const readBlobs =
  (config: WritebackRecordsConfig) =>
  (executionId: string, entries: readonly ManifestEntry[], maxBytes: number) =>
    Effect.gen(function* () {
      const bucket = config.artifacts;
      if (bucket === undefined)
        return yield* new StagedWriteReadFailed({
          source: "artifacts",
          detail: "this deploy binds no artifact bucket",
        });
      const { epoch } = yield* placementOf(config.db, executionId);
      const artifactsFailed = (cause: unknown) =>
        new StagedWriteReadFailed({ source: "artifacts", detail: String(cause) });
      const objects = new Map<string, Awaited<ReturnType<ArtifactObjects["get"]>>>();
      let total = 0;
      for (const digest of new Set(entries.map((e) => e.digest))) {
        const key = config.artifactPath(executionId, epoch, stagedBlobName(digest));
        const object = yield* Effect.tryPromise({
          try: () => bucket.get(key),
          catch: artifactsFailed,
        });
        objects.set(digest, object);
        total += object?.size ?? 0;
      }
      const oversized = total > maxBytes;
      const byDigest = new Map<string, Omit<LoadedBlob, "path"> | null>();
      for (const [digest, object] of objects) {
        if (object === null) {
          byDigest.set(digest, null);
          continue;
        }
        if (oversized) {
          byDigest.set(digest, {
            digest: "",
            size: object.size,
            text: null,
            bytes: new Uint8Array(),
          });
          continue;
        }
        const read = yield* Effect.tryPromise({
          try: async () => {
            const buffer = await object.arrayBuffer();
            return {
              bytes: new Uint8Array(buffer),
              digest: hex(await crypto.subtle.digest("SHA-256", buffer)),
            };
          },
          catch: artifactsFailed,
        });
        byDigest.set(digest, {
          digest: read.digest,
          size: read.bytes.byteLength,
          text: textOf(read.bytes),
          bytes: read.bytes,
        });
      }
      return entries.flatMap((entry): LoadedBlob[] => {
        const read = byDigest.get(entry.digest);
        return read === null || read === undefined ? [] : [{ path: entry.path, ...read }];
      });
    });

/**
 * Whether a model call is on record for the execution. A call the gateway recorded answers true. Otherwise a cloud
 * placement answers false; a device placement fails, because the device executor's local-call report is not read, and
 * false there could hide a local model call.
 */
const readModelCalls = (db: D1Binding) => (executionId: string) =>
  Effect.gen(function* () {
    const [calls] = yield* rows<{ n: number }>(
      db,
      "gateway",
      "select count(*) as n from model_calls where execution_id = ?",
      executionId,
    );
    if ((calls?.n ?? 0) > 0) return true;
    const { kind } = yield* placementOf(db, executionId);
    if (kind === null || kind === "device")
      return yield* new StagedWriteReadFailed({
        source: "device",
        detail: `no local-call report is read for ${executionId}`,
      });
    return false;
  });

/**
 * The model entry ids that answered the execution's calls. A cloud placement with no call on record answers none. A
 * call on record fails the read, because mameko's `model_calls` rows hold the call's allowance and not the model entry
 * id that answered it; a device placement fails, because the device executor's local-call report is not read. Neither
 * answers empty, so a commit a model drafted never goes out without its `Drafted-With:` trailer (FD-AGT-040).
 */
const readModelEntries = (db: D1Binding) => (executionId: string) =>
  Effect.gen(function* () {
    const [calls] = yield* rows<{ n: number }>(
      db,
      "gateway",
      "select count(*) as n from model_calls where execution_id = ?",
      executionId,
    );
    if ((calls?.n ?? 0) > 0)
      return yield* new StagedWriteReadFailed({
        source: "gateway",
        detail: `the model-call records of ${executionId} name no model entry`,
      });
    const { kind } = yield* placementOf(db, executionId);
    if (kind === null || kind === "device")
      return yield* new StagedWriteReadFailed({
        source: "device",
        detail: `no local-call report is read for ${executionId}`,
      });
    return [] as readonly string[];
  });

/** The live `WritebackRecords` Layer the control plane composes for the `pr.propose` applier and the writeback gate. */
export const writebackRecordsLayer = (
  config: WritebackRecordsConfig,
): Layer.Layer<WritebackRecords> =>
  Layer.succeed(WritebackRecords, {
    blobs: readBlobs(config),
    modelCalls: readModelCalls(config.db),
    modelEntries: readModelEntries(config.db),
    issuedCredentials: config.issuedCredentials,
  });
