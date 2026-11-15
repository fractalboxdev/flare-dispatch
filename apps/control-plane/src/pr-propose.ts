// The `pr.propose` row the control plane generates `on: accepted` (specs/runs/agentic.md § Staged write, FD-AGT-034,
// MAMEKO-OUT-060). The staged write a result carries is its manifest in the artifact store at the accepted epoch; the
// `prProposePayload` binding answers the row's payload for a `success` result that carries one and `none` otherwise.
// mameko's executor channel inserts no `on: accepted` row at the pinned commit, so the control plane's channel step
// inserts it after the accept compare-and-set, under `cp:pr:propose`, through host-cloudflare's `insertOutboxRows`,
// which leaves a key that already has a row as it is: a redelivered result or a repeated step inserts no second row.
import {
  Manifest,
  prProposePayload,
  STAGED_WRITE_MANIFEST,
  type ArtifactObjects,
} from "@fractalboxdev/flare-dispatch-agentic";
import { artifactPath } from "@fractalboxdev/flare-dispatch-cache";
import { canonicalJson } from "@fractalboxdev/flare-dispatch-intake";
import { drawsReserve, type Profile } from "@fractalboxdev/flare-dispatch-profile";
import { insertOutboxRows, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { Effect, Exit, Option, Schema } from "effect";
import { profileOf, type ControlPlaneEnv } from "./config.ts";
import type { ChannelSocket } from "./provenance.ts";

/** The generated key of the `pr.propose` kind: `cp:` and the kind with each `.` replaced by `:`. */
export const PR_PROPOSE_KEY = "cp:pr:propose";

/** The control plane's store or artifact bucket could not be read or written; the row is not inserted. */
export class PrProposeUnavailable extends Schema.TaggedError<PrProposeUnavailable>()(
  "PrProposeUnavailable",
  { executionId: Schema.String, message: Schema.String },
) {}

const ResultFrame = Schema.Struct({
  type: Schema.Literal("exec.result"),
  execution_id: Schema.String,
  epoch: Schema.Number,
  outcome: Schema.Unknown,
});
const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(ResultFrame));
const decodeManifest = Schema.decodeUnknownExit(Schema.fromJsonString(Manifest));

/** An `exec.result` a channel frame carries: the execution, the epoch and the run's reported status. */
export const resultOf = (frame: string) =>
  Option.map(decodeResult(frame), (m) => {
    const status = (m.outcome as { readonly status?: unknown } | null)?.status;
    return {
      executionId: m.execution_id,
      epoch: m.epoch,
      // mameko's channel records any status other than these as `failure` (MAMEKO-RUN-065).
      outcome:
        status === "success" || status === "cancelled" || status === "skipped" ? status : "failure",
    };
  });

/** What the step inserts on: the store and the bucket that holds `artifact/`, unbound on a deploy that binds none. */
export interface PrProposeStores {
  readonly db: D1Like;
  readonly artifacts: ArtifactObjects | undefined;
}

interface AcceptedRow {
  readonly state: string;
  readonly accepted_epoch: number | null;
  readonly executor_id: string | null;
  readonly scope_id: string;
  readonly run: string;
  readonly class: string | null;
}

const sha256Hex = (text: string) =>
  Effect.promise(async () => {
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    );
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  });

/**
 * Inserts the execution's `pr.propose` row for a result the placement accepted at `epoch` from `executorId`, and
 * answers whether the binding gave a payload. A result the placement did not accept from that executor at that epoch
 * gets none. A `success` result's staged write is its manifest at `artifact/<execution_id>/<epoch>/`; an absent
 * manifest is a result with no staged write. A manifest that does not decode, an unreadable bucket or store, or a
 * deploy that binds no bucket fails, so no caller reads a missing row as "nothing staged".
 */
export const insertAcceptedPrPropose = (
  stores: PrProposeStores,
  profile: Profile,
  accepted: {
    readonly executionId: string;
    readonly epoch: number;
    readonly executorId: string;
    readonly outcome: string;
  },
  now: number,
): Effect.Effect<"proposed" | "none", PrProposeUnavailable> =>
  Effect.gen(function* () {
    const { executionId, epoch } = accepted;
    const unavailable = (message: string) => new PrProposeUnavailable({ executionId, message });
    const row = yield* Effect.tryPromise({
      try: () =>
        stores.db
          .prepare(
            `select p.state, p.accepted_epoch, p.executor_id, e.scope_id, e.run, e.class
             from placements p join executions e on e.id = p.execution_id where p.execution_id = ?`,
          )
          .bind(executionId)
          .all(),
      catch: (cause) => unavailable(`placements: ${cause}`),
    }).pipe(Effect.map(({ results }) => results[0] as AcceptedRow | undefined));
    if (
      row === undefined ||
      row.state !== "accepted" ||
      row.accepted_epoch === null ||
      Number(row.accepted_epoch) !== epoch ||
      row.executor_id !== accepted.executorId
    )
      return "none";
    // A result that is not `success` gets no row whatever it staged, so its manifest is not read.
    let stagedWrite: Manifest | undefined;
    if (accepted.outcome === "success") {
      const bucket = stores.artifacts;
      if (bucket === undefined) return yield* unavailable("this deploy binds no artifact bucket");
      const object = yield* Effect.tryPromise({
        try: () => bucket.get(artifactPath(executionId, epoch, STAGED_WRITE_MANIFEST)),
        catch: (cause) => unavailable(`artifacts: ${cause}`),
      });
      if (object !== null) {
        const text = yield* Effect.tryPromise({
          try: async () => new TextDecoder().decode(await object.arrayBuffer()),
          catch: (cause) => unavailable(`artifacts: ${cause}`),
        });
        const decoded = decodeManifest(text);
        if (Exit.isFailure(decoded))
          return yield* unavailable("the staged manifest does not decode");
        stagedWrite = decoded.value;
      }
    }
    const [owner, name, ...rest] = row.scope_id.split("/");
    if (owner === undefined || name === undefined || rest.length > 0)
      return yield* unavailable(`scope ${row.scope_id} names no repository`);
    const binding = prProposePayload({
      executionId,
      run: row.run,
      repo: { owner, name },
      outcome: accepted.outcome,
      ...(stagedWrite === undefined ? {} : { stagedWrite }),
    });
    if (binding._tag === "none") return "none";
    const entry = profile.intent_kinds["pr.propose"];
    if (entry === undefined) return yield* unavailable("the profile declares no pr.propose kind");
    const payload = binding.payload;
    const effectClass = entry.effect_class;
    const payloadDigest = yield* sha256Hex(canonicalJson(payload));
    yield* Effect.tryPromise({
      try: () =>
        insertOutboxRows(stores.db, [
          {
            id: `${executionId}:${PR_PROPOSE_KEY}`,
            limitKey: row.scope_id,
            tier: entry.delivery_tier,
            priority: entry.priority ?? 0,
            classRank: profile.classes.find((c) => c.name === row.class)?.rank ?? 0,
            drawsReserve: drawsReserve(entry),
            intent: {
              executionId,
              scopeId: row.scope_id,
              intentKey: PR_PROPOSE_KEY,
              kind: "pr.propose",
              payload,
              payloadDigest,
              effectClass,
              attempts: 0,
            },
            row: newRow({ effectClass, insertedAt: now }),
          },
        ]),
      catch: (cause) => unavailable(`outbox insert: ${cause}`),
    });
    return "proposed";
  });

/**
 * The executor channel's step after it handled a frame from `executorId`: an `exec.result` gets its `pr.propose` row.
 * A failure is logged, and the result stays accepted.
 */
export const prProposeOnResult = (
  stores: PrProposeStores,
  profile: Profile,
  frame: string,
  executorId: string,
  now: number,
): Effect.Effect<void> =>
  Option.match(resultOf(frame), {
    onNone: () => Effect.void,
    onSome: (result) =>
      insertAcceptedPrPropose(stores, profile, { ...result, executorId }, now).pipe(
        Effect.flatMap((answer) =>
          answer === "proposed"
            ? Effect.log("pr.propose row in the outbox", {
                executionId: result.executionId,
                epoch: result.epoch,
              })
            : Effect.void,
        ),
        Effect.catchTag("PrProposeUnavailable", (e) =>
          Effect.logWarning("pr.propose row not inserted", {
            executionId: e.executionId,
            epoch: result.epoch,
            message: e.message,
          }),
        ),
      ),
  });

/** `prProposeOnResult` for a frame the executor channel received on `ws`, with the Worker's store and bucket. */
export const prProposeOnFrame = async (
  env: ControlPlaneEnv,
  ws: ChannelSocket,
  message: string | ArrayBuffer,
  now: number,
): Promise<void> => {
  const frame = typeof message === "string" ? message : new TextDecoder().decode(message);
  if (!frame.includes('"exec.result"')) return;
  try {
    const { executorId } = ws.deserializeAttachment();
    await Effect.runPromise(
      prProposeOnResult(
        { db: env.DB, artifacts: env.CACHE },
        profileOf(env),
        frame,
        executorId,
        now,
      ),
    );
  } catch (error) {
    console.error(JSON.stringify({ prPropose: String(error) }));
  }
};
