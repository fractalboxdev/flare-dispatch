// What intake is configured with and the ports it calls: mameko's admission
// function, class resolution and the error every refusal becomes.
import { classNamed, type Profile } from "@fractalboxdev/flare-dispatch-profile";
import type { Resolution } from "@fractalboxdev/mameko-coordinator";
import type {
  D1AdmitInput,
  D1AdmitResult,
  D1Like,
  IntakeUnavailable,
} from "@fractalboxdev/mameko-host-cloudflare/d1";
import { admitExecution } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Context, Effect, Layer, Schema } from "effect";
import type { Caller, RecordedTrigger } from "./event.ts";
import type { IntakeRun, RunCatalog } from "./runs.ts";

/** A refusal as the HTTP API answers it: a status and a code from the error-model table (FD-IFC-009). */
export class IntakeError extends Schema.TaggedError<IntakeError>()("IntakeError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
  /** The existing execution a `conflict` names (FD-INT-003). */
  executionId: Schema.optionalKey(Schema.String),
}) {}

export const intakeError = (status: number, code: string, message: string, executionId?: string) =>
  new IntakeError({
    status,
    code,
    message,
    ...(executionId === undefined ? {} : { executionId }),
  });

export interface IntakeSettings {
  readonly catalog: RunCatalog;
  readonly profile: Profile;
  /** The GitHub App's id; a check run of another App is foreign (FD-INT-055). */
  readonly appId: number;
  /** Unset when the deployment holds no webhook secret (FD-INT-022). */
  readonly webhookSecret: string | undefined;
  /** `intake.webhookEvents`; undefined admits every supported event (FD-INT-027). */
  readonly webhookEvents: readonly string[] | undefined;
  /** `dispatch.oidcAudience`; unset refuses every Actions token. */
  readonly oidcAudience: string | undefined;
  /** Access identities that may dispatch (FD-IFC-027). */
  readonly dispatchers: readonly string[];
  /** The operator policy: whether a repository may run a run at all (FD-INT-015). */
  readonly allows: (repo: string, run: string) => boolean;
}

export class IntakeConfig extends Context.Service<IntakeConfig, IntakeSettings>()(
  "@fractalboxdev/flare-dispatch-intake/IntakeConfig",
) {}

/** mameko's admission transaction, and what follows a queued admission. */
export class Admission extends Context.Service<
  Admission,
  {
    readonly admit: (input: D1AdmitInput) => Effect.Effect<D1AdmitResult, IntakeUnavailable>;
    /** Runs after a request is queued, for the caller to wake standing claims. */
    readonly queued: (className: string) => Effect.Effect<void>;
  }
>()("@fractalboxdev/flare-dispatch-intake/Admission") {}

/** Admission on the deployment's D1, with the Worker's wake-up after each queued request. */
export const d1Admission = (
  db: D1Like,
  queued: (className: string) => Effect.Effect<void> = () => Effect.void,
) => Layer.succeed(Admission, { admit: (input) => admitExecution(db, input), queued });

/** The request class resolution sees (specs/profile.md § Class resolution). */
export interface ClassRequest {
  readonly run: IntakeRun;
  readonly trigger: RecordedTrigger;
  /** The webhook event name, or null for another trigger kind. */
  readonly event: string | null;
  readonly repo: string;
  readonly ref: string;
  readonly checkName: string;
  /** A dispatch's or an MCP call's `class` input (FD-IFC-033). */
  readonly classInput: string | null;
  readonly caller: Caller | null;
}

/** The `resolveClass` binding, with its declared inputs already gathered. */
export class ClassResolver extends Context.Service<
  ClassResolver,
  { readonly resolve: (request: ClassRequest) => Effect.Effect<Resolution> }
>()("@fractalboxdev/flare-dispatch-intake/ClassResolver") {}

/** The class bounds admission enforces, from the profile's class entry. */
export const boundsOf = (profile: Profile, className: string) => {
  const bounds = classNamed(profile, className)?.bounds;
  if (bounds === undefined)
    return Effect.fail(intakeError(503, "misconfigured", `class ${className} declares no bounds`));
  return Effect.succeed({
    global: bounds.global,
    perScope: "per_scope" in bounds ? bounds.per_scope : bounds.per_run_scope,
  });
};
