// Intake on D1 for a dispatch or MCP trigger: the run catalogue, the run's input schema, the installation, class
// resolution and mameko's `admitExecution`, which writes the `executions`, dedup-key and `placements` rows (FD-INT-001).
// FlareDispatch writes only its own `execution_inputs` and `execution_origins` rows.
import { lookupRun, type CatalogEntry } from "@fractalboxdev/flare-dispatch-catalog";
import {
  classNamed,
  isolationOf,
  type ConfidentialityMode,
  type Deployment,
  type Profile,
} from "@fractalboxdev/flare-dispatch-profile";
import { dedupKey, executionId, type DedupRecipe } from "@fractalboxdev/mameko-coordinator";
import {
  admitExecution,
  wakeStandingClaims,
  type D1Like,
} from "@fractalboxdev/mameko-host-cloudflare";
import { Effect, Layer, Match, Schema } from "effect";
import { sha256Hex } from "../crypto.ts";
import { apiError, type ApiError } from "../errors.ts";
import { Intake, type DispatchSubmission } from "../ports.ts";
import { dropExecutionRows, putExecutionRows } from "./tables.ts";

/** Resolves the installation of the GitHub App that covers a repository (FD-INT-042); `undefined` when none does. */
export type InstallationLookup = (
  repository: string,
) => Effect.Effect<string | undefined, ApiError>;

/** `resolveClass` (specs/profile.md § Class resolution), given the run's declared class and the `class` input. */
export type ClassResolver = (input: {
  readonly run: CatalogEntry;
  readonly repository: string;
  readonly requested: string | undefined;
  readonly trigger: DispatchSubmission["trigger"];
}) => Effect.Effect<string, ApiError>;

export interface ChannelNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { wake(): Promise<void> };
}

export interface D1IntakeOptions {
  readonly db: D1Like;
  readonly channels: ChannelNamespace;
  readonly deployment: Deployment;
  readonly profile: Profile;
  readonly installations: InstallationLookup;
  readonly resolveClass: ClassResolver;
  /** A repository's confidentiality mode; `unclassified`, mameko's fail-closed default, where nothing classifies it. */
  readonly confidentiality: (repository: string) => ConfidentialityMode;
}

interface KeyedRequest {
  readonly run: string;
  readonly repository: string;
  readonly sha: string | undefined;
  readonly idempotencyKey: string | undefined;
}

/**
 * The dispatch's dedup recipes in the profile's order: `idempotency-key` when the header is present (FD-INT-010), then
 * the commit-scoped `commit` key `<run>:<owner>/<repo>:<sha>` (FD-INT-009).
 */
export const dispatchRecipes: readonly DedupRecipe<KeyedRequest>[] = [
  {
    name: "idempotency-key",
    run: (r) =>
      r.idempotencyKey === undefined ? null : `idem:${r.repository}:${r.idempotencyKey}`,
  },
  { name: "commit", run: (r) => `${r.run}:${r.repository}:${r.sha ?? "no-sha"}` },
];

const decodeInputs = (entry: CatalogEntry, inputs: unknown) =>
  Schema.decodeUnknownEffect(entry.input)(inputs).pipe(
    Effect.mapError((e) => apiError("invalid_inputs", e.message)),
  );

/** The commit of a dispatch: the body's or the token's `sha`, else the `sha` the run's inputs carry. */
const shaOf = (submission: DispatchSubmission, inputs: unknown): string | undefined => {
  if (submission.sha !== undefined) return submission.sha;
  const sha = (inputs as { readonly sha?: unknown } | null)?.sha;
  return typeof sha === "string" ? sha : undefined;
};

const boundsOf = (profile: Profile, className: string) => {
  const bounds = classNamed(profile, className)?.bounds;
  if (bounds === undefined)
    return Effect.fail(apiError("misconfigured", `class ${className} declares no bounds`));
  return Effect.succeed({
    global: bounds.global,
    perScope: "per_scope" in bounds ? bounds.per_scope : bounds.per_run_scope,
  });
};

export const d1Intake = (options: D1IntakeOptions): Layer.Layer<Intake> =>
  Layer.succeed(Intake)({
    submit: (submission) =>
      Effect.gen(function* () {
        const { db, profile } = options;
        const entry = yield* Match.value(lookupRun(options.deployment, submission.run)).pipe(
          Match.tag("Available", ({ entry }) => Effect.succeed(entry)),
          Match.tag("HostExecutionRefused", () =>
            Effect.fail(
              apiError(
                "forbidden",
                `run ${submission.run} executes on the device host, which this deployment refuses`,
              ),
            ),
          ),
          Match.tag("NotInCatalogue", () =>
            Effect.fail(apiError("run_not_found", `no run named ${submission.run}`)),
          ),
          Match.exhaustive,
        );
        const inputs = yield* decodeInputs(entry, submission.inputs);
        const installation = yield* options.installations(submission.repository);
        if (installation === undefined)
          return yield* apiError(
            "installation_not_found",
            `no installation of the GitHub App covers ${submission.repository}`,
          );
        const className = yield* options.resolveClass({
          run: entry,
          repository: submission.repository,
          requested: submission.class,
          trigger: submission.trigger,
        });
        const bounds = yield* boundsOf(profile, className);
        const now = Date.now();
        const id = executionId(now, Math.random);
        const keyed: KeyedRequest = {
          run: submission.run,
          repository: submission.repository,
          sha: shaOf(submission, inputs),
          idempotencyKey: submission.idempotency?.key,
        };
        const key = yield* Effect.promise(() => dedupKey(dispatchRecipes, keyed));
        const idempotent = key.recipe === "idempotency-key" && submission.idempotency !== undefined;
        const requestDigest = idempotent
          ? yield* Effect.promise(() => sha256Hex(submission.idempotency!.canonicalBody))
          : null;
        yield* putExecutionRows(
          db,
          id,
          { inputs, deadlineAtMs: now + entry.spec.limits.maxDurationSec * 1000 },
          {
            identity: submission.caller,
            trigger: submission.trigger,
            ref: submission.ref,
            workflowRef: submission.workflowRef,
          },
        );
        const admitted = yield* admitExecution(db, {
          executionId: id,
          scopeId: submission.repository,
          run: submission.run,
          className,
          enqueuedAtMs: now,
          dedup: {
            sha256: key.sha256,
            canonical: key.canonical,
            requestDigest,
            onMismatch: idempotent ? "conflict" : "duplicate",
          },
          bounds,
          // A dispatch carries no fork input; the class, the repository's mode and the run's grants decide whether a
          // host-process device may take it (MAMEKO-LEASE-083).
          isolation: isolationOf(profile, {
            class: className,
            untrustedInput: false,
            confidentiality: options.confidentiality(submission.repository),
            declaresGrant: entry.spec.grants.setup.length + entry.spec.grants.agent.length > 0,
          }),
        }).pipe(
          Effect.catchTag(["IntakeUnavailable", "ExecutionIdTaken"], () =>
            dropExecutionRows(db, id).pipe(
              Effect.andThen(
                Effect.fail(
                  apiError("intake_unavailable", "admission failed; nothing was written"),
                ),
              ),
            ),
          ),
        );
        return yield* Match.value(admitted).pipe(
          Match.tag("Queued", ({ executionId: queued }) =>
            Effect.promise(() =>
              wakeStandingClaims(db, options.channels, { className, eligibleKinds: null }),
            ).pipe(Effect.as({ _tag: "Admitted" as const, executionId: queued, class: className })),
          ),
          Match.tag("Duplicate", ({ executionId: existing }) =>
            dropExecutionRows(db, id).pipe(
              Effect.as({ _tag: "Duplicate" as const, executionId: existing, class: className }),
            ),
          ),
          Match.tag("Conflict", ({ executionId: existing }) =>
            dropExecutionRows(db, id).pipe(
              Effect.andThen(
                Effect.fail(
                  apiError("conflict", "the Idempotency-Key names a dispatch with another body", {
                    execution_id: existing,
                  }),
                ),
              ),
            ),
          ),
          // A class at its bound concludes the execution `capacity: queue full`; the caller still gets its id, and the
          // record carries the verdict (specs/intake.md § Intake path).
          Match.tag("Concluded", ({ executionId: concluded }) =>
            Effect.succeed({ _tag: "Admitted" as const, executionId: concluded, class: className }),
          ),
          Match.exhaustive,
        );
      }),
  });
