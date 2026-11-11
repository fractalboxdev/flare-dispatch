// The application's lease fields: which image an execution of a run runs in, by digest, and what names the execution.
import type { CatalogEntry } from "@fractalboxdev/flare-dispatch-catalog";
import { requestContextOf, type IntakeRecord } from "@fractalboxdev/flare-dispatch-intake";
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

/**
 * A gate run's lease input: the recorded input with the execution's `deadline_at` as `GateContext.deadlineAt`, so every
 * command of the run stops there and records `deadline` (FD-GATE-007). An agentic run's input is the recorded one.
 */
export const gateInputs = (entry: CatalogEntry | null, inputs: unknown, deadlineAt: number) =>
  entry !== null && entry.agentic === undefined && isRecord(inputs)
    ? { ...inputs, deadlineAt }
    : inputs;

/**
 * The application's lease fields that name the execution (FD-PROF-063): the repository admission wrote on the
 * execution row as the scope id, the recorded inputs with the commit SHA they verify, the run registry's run version
 * and workflow version, and the request context intake recorded before admission.
 */
export const requestLeaseFields = (
  entry: CatalogEntry | null,
  record: IntakeRecord,
  execution: { readonly scope_id: string; readonly deadline_at: number },
) => ({
  run_version: entry?.spec.version ?? "",
  workflow_version: entry?.workflowVersion ?? 1,
  request_context: requestContextOf(record),
  scope_id: execution.scope_id,
  inputs: gateInputs(entry, record.inputs, execution.deadline_at),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
