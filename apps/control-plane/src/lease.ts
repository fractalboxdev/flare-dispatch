// The lease's image field: which image an execution of a run runs in, by digest.
import type { CatalogEntry } from "@fractalboxdev/flare-dispatch-catalog";
import { Effect, Schema } from "effect";

/** The image a host execution names: it runs in no image, and a lease must carry the field. */
export const NO_IMAGE = "none: host execution";

/** A lease for a run that executes in the gate image, on a deploy that names no digest for it. */
export class GateImageUnpinned extends Schema.TaggedError<GateImageUnpinned>()(
  "GateImageUnpinned",
  {
    run: Schema.String,
    executorKind: Schema.String,
  },
) {}

/**
 * The image a lease names (MAMEKO-EXEC-031): none for a host execution on a device, else the gate image by digest
 * (`infra/v2/Dockerfile.gate`), which the deploy holds as `GATE_IMAGE_DIGEST`. Without it such a lease fails.
 */
export const imageDigestOf = (
  entry: CatalogEntry | null,
  executorKind: string,
  gateDigest: string | undefined,
): Effect.Effect<string, GateImageUnpinned> =>
  executorKind === "device" && (entry === null || entry.hostExecution)
    ? Effect.succeed(NO_IMAGE)
    : gateDigest !== undefined && /^sha256:[0-9a-f]{64}$/.test(gateDigest)
      ? Effect.succeed(gateDigest)
      : Effect.fail(new GateImageUnpinned({ run: entry?.spec.name ?? "", executorKind }));
