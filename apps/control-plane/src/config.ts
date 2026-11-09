// The Worker's bindings, and the two `json` configurations host-cloudflare reads, derived from the profile so one
// document decides both.
import { deploymentOf } from "@fractalboxdev/flare-dispatch-catalog";
import type { MonitorNamespace } from "@fractalboxdev/flare-dispatch-ops";
import type { CacheEnv } from "./cache.ts";
import {
  buildProfile,
  deviceSlotDefaults,
  type Deployment,
  type Profile,
} from "@fractalboxdev/flare-dispatch-profile";
import type {
  D1Like,
  ExecutionEngineEnv,
  ExecutorChannelEnv,
} from "@fractalboxdev/mameko-host-cloudflare";

/** The bindings of `wrangler.jsonc`, plus the channel and engine namespaces the mameko classes read. */
export interface ControlPlaneEnv extends CacheEnv {
  readonly DB: D1Like;
  readonly CHANNEL: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response>; wake(): Promise<void> };
  };
  readonly EXECUTION: ExecutorChannelEnv["EXECUTION"];
  readonly EPOCH_ANCHOR: ExecutorChannelEnv["EPOCH_ANCHOR"];
  /** The one `LivenessMonitor` object the minute tick starts. */
  readonly MONITOR: MonitorNamespace;
  /** `alerts.sink`; without it every alarm delivery fails and the alarm stays active. */
  readonly ALERT_SINK?: string;
  readonly DEPLOYMENT?: string;
  readonly PLANE_ID: string;
  /** The GitHub App's id and private key (a Worker secret); without both, nothing is applied to GitHub. */
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_APP_PRIVATE_KEY?: string;
  /** The App's slug, whose bot the App commits as. */
  readonly GITHUB_APP_SLUG?: string;
  /** The webhook secret (a Worker secret); unset refuses every webhook (FD-INT-022). */
  readonly WEBHOOK_SECRET?: string;
  /** `dispatch.oidcAudience`; unset refuses every Actions token. */
  readonly DISPATCH_OIDC_AUDIENCE?: string;
  /** The Slack verdict endpoint and its signing secret. */
  readonly SLACK_URL?: string;
  readonly SLACK_SECRET?: string;
  /** The gate image's digest, `sha256:<hex>`, which every lease outside a device host execution names. */
  readonly GATE_IMAGE_DIGEST?: string;
  /** The repository a `development` deployment with no GitHub App reads (`dev-repository.ts`). */
  readonly FD_DEV_REPOSITORY?: string;
}

export const deployment = (env: ControlPlaneEnv): Deployment => deploymentOf(env.DEPLOYMENT);

export const profileOf = (env: ControlPlaneEnv): Profile => buildProfile(deployment(env));

/**
 * One channel per device executor. No catalogue run requires `LocalContent` yet. A class whose terminal outcome is
 * `deferred` starts no workflow at admission, so the channel starts one at the winning claim (MAMEKO-ARCH-037).
 */
export const channelConfig = (profile: Profile): ExecutorChannelEnv["MAMEKO_CHANNEL_CONFIG"] => ({
  reclaimPolicy: profile.reclaim_policy,
  deferredClasses: profile.classes
    .filter((c) => c.terminal_outcome === "deferred")
    .map((c) => c.name),
  localContent: false,
  anyOutcomeKinds: Object.fromEntries(
    Object.entries(profile.intent_kinds)
      .filter(([, kind]) => kind.applied_for === "any")
      .map(([name, kind]) => [name, kind.effect_class]),
  ),
  notApplicableDetails: [...profile.outcome_mapping.not_applicable_details],
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
