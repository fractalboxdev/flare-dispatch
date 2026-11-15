// The `pr.propose` row the control plane generates `on: accepted` (specs/runs/agentic.md § Staged write, FD-AGT-034,
// MAMEKO-OUT-060). The staged write a result carries is its manifest in the artifact store at the result's epoch; the
// `prProposePayload` binding answers the row's payload for a `success` result that carries one and `none` otherwise.
// mameko's accept inserts the row in the accept's own transaction, under `cp:pr:propose`, from the payload the channel's
// `acceptedPayload` answers: a result the accept refuses or answers `duplicate` inserts none. The binding is
// synchronous, so the channel reads the manifest before it hands the result to mameko's accept (`AcceptedPayloads`).
import {
  Manifest,
  prProposePayload,
  STAGED_WRITE_MANIFEST,
  type ArtifactObjects,
} from "@fractalboxdev/flare-dispatch-agentic";
import { artifactPath } from "@fractalboxdev/flare-dispatch-cache";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Exit, Schema } from "effect";

/** The generated key of the `pr.propose` kind: `cp:` and the kind with each `.` replaced by `:`. */
export const PR_PROPOSE_KEY = "cp:pr:propose";

/** The artifact bucket could not be read, or the staged manifest does not decode; the row is not inserted. */
export class PrProposeUnavailable extends Schema.TaggedError<PrProposeUnavailable>()(
  "PrProposeUnavailable",
  { executionId: Schema.String, message: Schema.String },
) {}

const decodeManifest = Schema.decodeUnknownExit(Schema.fromJsonString(Manifest));

/** What the row reads: the store and the bucket that holds `artifact/`, unbound on a deploy that binds none. */
export interface PrProposeStores {
  readonly db: D1Like;
  readonly artifacts: ArtifactObjects | undefined;
}

/**
 * The staged write of the execution's result at `epoch`: its manifest at `artifact/<execution_id>/<epoch>/`, or
 * undefined where none is stored. A manifest that does not decode, an unreadable bucket or a deploy that binds no
 * bucket fails, so no caller reads a missing manifest as "nothing staged".
 */
export const stagedWriteOf = (
  artifacts: ArtifactObjects | undefined,
  executionId: string,
  epoch: number,
): Effect.Effect<Manifest | undefined, PrProposeUnavailable> =>
  Effect.gen(function* () {
    const unavailable = (message: string) => new PrProposeUnavailable({ executionId, message });
    if (artifacts === undefined) return yield* unavailable("this deploy binds no artifact bucket");
    const object = yield* Effect.tryPromise({
      try: () => artifacts.get(artifactPath(executionId, epoch, STAGED_WRITE_MANIFEST)),
      catch: (cause) => unavailable(`artifacts: ${cause}`),
    });
    if (object === null) return undefined;
    const text = yield* Effect.tryPromise({
      try: async () => new TextDecoder().decode(await object.arrayBuffer()),
      catch: (cause) => unavailable(`artifacts: ${cause}`),
    });
    const decoded = decodeManifest(text);
    if (Exit.isFailure(decoded)) return yield* unavailable("the staged manifest does not decode");
    return decoded.value;
  });

/** What mameko's accept passes the `payload` binding of a kind generated `on: accepted`. */
export interface AcceptedExecution {
  readonly executionId: string;
  readonly scopeId: string;
  readonly run: string;
  readonly className: string;
  readonly outcome?: string;
}

/**
 * The `pr.propose` payload for an accepted execution with the staged write read for it, or null for none: a result
 * that is not `success`, one that staged nothing, or a scope that names no repository.
 */
export const prProposePayloadOf = (
  execution: AcceptedExecution,
  stagedWrite: Manifest | undefined,
): unknown => {
  const [owner, name, ...rest] = execution.scopeId.split("/");
  if (owner === undefined || name === undefined || rest.length > 0) return null;
  const binding = prProposePayload({
    executionId: execution.executionId,
    run: execution.run,
    repo: { owner, name },
    outcome: execution.outcome ?? "failure",
    ...(stagedWrite === undefined ? {} : { stagedWrite }),
  });
  return binding._tag === "payload" ? binding.payload : null;
};

/** An executor message as the channel hands it to the accept. */
interface ResultMessage {
  readonly type?: unknown;
  readonly execution_id?: unknown;
  readonly epoch?: unknown;
  readonly outcome?: unknown;
}

/**
 * The payloads of the kinds generated `on: accepted` for the results one channel object is accepting. `around` reads a
 * `success` result's staged write before the accept runs and holds it while the accept runs; `payload` answers the
 * binding from it. A staged write that cannot be read is logged, and the result is accepted with no `pr.propose` row.
 */
export class AcceptedPayloads {
  private readonly staged = new Map<string, Manifest | undefined>();

  constructor(private readonly artifacts: () => ArtifactObjects | undefined) {}

  async around<A>(message: unknown, accept: () => Promise<A>): Promise<A> {
    const m = (message ?? {}) as ResultMessage;
    const status = (m.outcome as { readonly status?: unknown } | null | undefined)?.status;
    if (
      m.type !== "exec.result" ||
      status !== "success" ||
      typeof m.execution_id !== "string" ||
      typeof m.epoch !== "number"
    )
      return accept();
    const executionId = m.execution_id;
    const read = await Effect.runPromise(
      Effect.result(stagedWriteOf(this.artifacts(), executionId, m.epoch)),
    );
    if (read._tag === "Failure") {
      console.warn(
        JSON.stringify({ prPropose: "staged write unread", executionId, message: read.failure.message }),
      );
      return accept();
    }
    this.staged.set(executionId, read.success);
    try {
      return await accept();
    } finally {
      this.staged.delete(executionId);
    }
  }

  /** The `payload` binding of a kind generated `on: accepted`: `pr.propose`'s, and null for any other kind. */
  payload(kind: string, execution: AcceptedExecution): unknown {
    if (kind !== "pr.propose" || !this.staged.has(execution.executionId)) return null;
    return prProposePayloadOf(execution, this.staged.get(execution.executionId));
  }
}
