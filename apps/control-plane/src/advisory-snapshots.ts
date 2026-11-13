// The minute tick's `advisory-refresh` step (specs/operability.md FD-OPS-100 to FD-OPS-102): the operability
// package's refresh over the Worker's `fetch`, `crypto.DigestStream` and the `CACHE` bucket, for the ecosystems the
// overlay's `scan.advisoryEcosystems` names. The step runs on every tick and stores an ecosystem's archive only when
// no snapshot of it is recorded on the current UTC day.
import { ConfigInvalid } from "@fractalboxdev/flare-dispatch-api/config";
import {
  refreshAdvisorySnapshots,
  type AdvisoryRefreshPorts,
  type TickStep,
} from "@fractalboxdev/flare-dispatch-ops";
import { Effect, Schema } from "effect";
import { advisoryEcosystemsOf, type ControlPlaneEnv } from "./config.ts";

/** `scan.advisoryEcosystems` names ecosystems and the deploy binds no `CACHE` bucket to store their archives in. */
export class AdvisoryStoreUnbound extends Schema.TaggedError<AdvisoryStoreUnbound>()(
  "AdvisoryStoreUnbound",
  { ecosystems: Schema.Array(Schema.String) },
) {}

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** The stream constructors the Worker runtime supplies; a suite in Node passes its own. */
export interface StreamRuntime {
  /** A sink whose `digest` is the SHA-256 of every byte written to it (`crypto.DigestStream`). */
  readonly digestStream: () => WritableStream<Uint8Array> & { readonly digest: Promise<ArrayBuffer> };
  /** A pass-through that errors unless exactly `length` bytes pass it (`FixedLengthStream`). */
  readonly fixedLength: (length: number) => TransformStream<Uint8Array, Uint8Array>;
}

/** The Worker runtime's `crypto.DigestStream` and `FixedLengthStream`, which Node's globals do not declare. */
const workerd = globalThis as unknown as {
  readonly crypto: {
    readonly DigestStream: new (algorithm: string) => ReturnType<StreamRuntime["digestStream"]>;
  };
  readonly FixedLengthStream: new (length: number) => TransformStream<Uint8Array, Uint8Array>;
};

export const workerStreams: StreamRuntime = {
  digestStream: () => new workerd.crypto.DigestStream("SHA-256"),
  fixedLength: (length) => new workerd.FixedLengthStream(length),
};

/** The bucket calls a refresh makes: an `R2Bucket`'s `head` and `put`. */
export interface AdvisoryBucket {
  head(key: string): Promise<{ readonly size: number } | null>;
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: { readonly sha256: string },
  ): Promise<{ readonly size: number } | null>;
}

/**
 * The refresh's I/O in the Worker. The archive's digest is read through `crypto.DigestStream`, counting the bytes it
 * passes; the store writes through a `FixedLengthStream` of `Content-Length` bytes and asks R2 to check the SHA-256,
 * so R2 keeps no object at `cas/<digest>` whose bytes are other than the archive's.
 */
export const workerAdvisoryPorts = (
  bucket: AdvisoryBucket,
  streams: StreamRuntime = workerStreams,
  get: AdvisoryRefreshPorts["fetch"] = (url) => fetch(url),
): AdvisoryRefreshPorts => ({
  fetch: get,
  sha256: async (body) => {
    const sink = streams.digestStream();
    let bytes = 0;
    await body
      .pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      )
      .pipeTo(sink);
    return { digest: hex(await sink.digest), bytes };
  },
  bucket: {
    head: async (key) => {
      const object = await bucket.head(key);
      return object === null ? null : { size: object.size };
    },
    put: async (key, body, { length, sha256 }) => {
      const object = await bucket.put(key, body.pipeThrough(streams.fixedLength(length)), {
        sha256,
      });
      return object === null ? null : { size: object.size };
    },
  },
});

/**
 * The `advisory-refresh` step at `now`. An overlay that names no ecosystem stores nothing; a malformed
 * `ADVISORY_ECOSYSTEMS` or a deploy with no `CACHE` bucket fails the step, so the tick reports it.
 */
export const advisoryRefreshStep = (
  env: Pick<ControlPlaneEnv, "DB" | "CACHE" | "ADVISORY_ECOSYSTEMS">,
  now: number,
  portsOf: (bucket: AdvisoryBucket) => AdvisoryRefreshPorts = (bucket) =>
    workerAdvisoryPorts(bucket),
): TickStep => ({
  step: "advisory-refresh",
  effect: Effect.gen(function* () {
    const ecosystems = advisoryEcosystemsOf(env);
    if (ecosystems instanceof ConfigInvalid) return yield* ecosystems;
    if (ecosystems.length === 0) return { refreshed: [], current: [], attempting: [] };
    if (env.CACHE === undefined) return yield* new AdvisoryStoreUnbound({ ecosystems });
    return yield* refreshAdvisorySnapshots(
      env.DB,
      portsOf(env.CACHE as unknown as AdvisoryBucket),
      ecosystems,
      now,
    );
  }),
});
