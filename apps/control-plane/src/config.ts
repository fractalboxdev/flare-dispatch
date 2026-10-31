// The Worker's bindings, and the two `json` configurations host-cloudflare reads, derived from the profile so one
// document decides both.
import { deploymentOf } from "@fractalboxdev/flare-dispatch-catalog";
import {
  buildProfile,
  classNamed,
  deviceSlotDefaults,
  type Deployment,
  type Profile,
} from "@fractalboxdev/flare-dispatch-profile";
import type { ExecutionPayload } from "@fractalboxdev/mameko-coordinator";
import type {
  D1Like,
  ExecutionEngineEnv,
  ExecutorChannelEnv,
} from "@fractalboxdev/mameko-host-cloudflare";
import { Match } from "effect";

interface Namespace<Stub> {
  idFromName(name: string): unknown;
  get(id: unknown): Stub;
}

/** The `ExecutionEngine` RPC methods the channel calls, plus the one this application calls. */
export type EngineStub = ReturnType<ExecutorChannelEnv["EXECUTION"]["get"]> & {
  start(payload: ExecutionPayload): Promise<void>;
};

/** The bindings of `wrangler.jsonc`, plus the channel and engine namespaces the mameko classes read. */
export interface ControlPlaneEnv {
  readonly DB: D1Like;
  readonly CHANNEL: Namespace<{
    fetch(request: Request): Promise<Response>;
    wake(): Promise<void>;
  }>;
  readonly EXECUTION: Namespace<EngineStub>;
  readonly EPOCH_ANCHOR: ExecutorChannelEnv["EPOCH_ANCHOR"];
  readonly DEPLOYMENT?: string;
  readonly PLANE_ID: string;
  /** The bearer token of the operator routes. With none set, those routes answer `not_configured`. */
  readonly OPERATOR_TOKEN?: string;
}

export const deployment = (env: ControlPlaneEnv): Deployment => deploymentOf(env.DEPLOYMENT);

export const profileOf = (env: ControlPlaneEnv): Profile => buildProfile(deployment(env));

/** One channel per device executor. No catalogue run requires `LocalContent` yet. */
export const channelConfig = (profile: Profile): ExecutorChannelEnv["MAMEKO_CHANNEL_CONFIG"] => ({
  reclaimPolicy: profile.reclaim_policy,
  localContent: false,
  anyOutcomeKinds: Object.entries(profile.intent_kinds)
    .filter(([, kind]) => kind.applied_for === "any")
    .map(([name]) => name),
  executorKind: "device",
  planeShare: deviceSlotDefaults.total,
});

/**
 * The stage configuration. A device execution has no container rate and the channel takes no hold at claim, so each
 * class's hold terms are zero.
 */
export const executionConfig = (
  profile: Profile,
): ExecutionEngineEnv["MAMEKO_EXECUTION_CONFIG"] => {
  const surface = profile.outcome_mapping.surface_kind;
  return {
    classes: Object.fromEntries(
      profile.classes.map((c) => [
        c.name,
        {
          rank: c.rank,
          guaranteed: c.guaranteed,
          rateMicroUsdPerS: 0,
          settleMarginS: 0,
          modelAllowanceMicroUsd: 0,
          networkEstimateMicroUsd: 0,
        },
      ]),
    ),
    outcomeKind: surface,
    outcomeEffectClass: profile.intent_kinds[surface]?.effect_class ?? "adoptable",
  };
};

/** The class's outcome at `deadline_at`, as the `Execution` workflow takes it. */
export const deadlineOutcomeOf = (
  profile: Profile,
  className: string,
): ExecutionPayload["deadlineOutcome"] =>
  Match.value(classNamed(profile, className)?.terminal_outcome).pipe(
    Match.when("deferred", () => "deferred" as const),
    Match.when("expired", () => "expired" as const),
    Match.orElse(() => "failure" as const),
  );
