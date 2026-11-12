// The Worker's bindings, and the two `json` configurations host-cloudflare reads, derived from the profile so one
// document decides both.
import {
  apiConfigFromEnv,
  ConfigInvalid,
  type ApiEnv,
} from "@fractalboxdev/flare-dispatch-api/config";
import type { ConcludeKind, QuotaObject } from "@fractalboxdev/flare-dispatch-github";
import type { TickUnit } from "@fractalboxdev/flare-dispatch-intake";
import {
  PRESIGNER_BINDINGS,
  spendConfigOfVar,
  unsetBindings,
  type MonitorNamespace,
  type SpendUnreadable,
} from "@fractalboxdev/flare-dispatch-ops";
import type { Effect } from "effect";
import {
  DEFAULT_ATTESTATION_MAX_AGE_MS,
  type AcceptanceSettings,
  type AppendOutcome,
  type PrivateLogInclusionProof,
  type R2PresignerConfig,
} from "@fractalboxdev/flare-dispatch-cache";
import type { CacheEnv } from "./cache.ts";
import {
  buildProfile,
  CURRENT_PHASE,
  deploymentOf,
  deviceSlotDefaults,
  drawsReserve,
  type Deployment,
  type Phase,
  type Profile,
  type SpendConfig,
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
    get(
      id: unknown,
    ): { fetch(request: Request): Promise<Response> } & ReturnType<
      NonNullable<ExecutionEngineEnv["CHANNEL"]>["get"]
    >;
  };
  /** Both mameko classes call the engine: the channel to grant leases, the engine to cancel a parent's children. */
  readonly EXECUTION: {
    idFromName(name: string): unknown;
    get(
      id: unknown,
    ): ReturnType<ExecutorChannelEnv["EXECUTION"]["get"]> &
      ReturnType<NonNullable<ExecutionEngineEnv["EXECUTION"]>["get"]>;
  };
  readonly EPOCH_ANCHOR: ExecutorChannelEnv["EPOCH_ANCHOR"];
  /** The one `LivenessMonitor` object the minute tick starts. */
  readonly MONITOR: MonitorNamespace;
  /** One `IntakeUnits` object per GitHub App installation, by `idFromName(<installation id>)` (FD-INT-067). */
  readonly INTAKE_UNITS: {
    idFromName(name: string): unknown;
    get(id: unknown): { enqueue(units: readonly TickUnit[]): Promise<number> };
  };
  /**
   * One `InstallationQuota` object per GitHub App installation, by `idFromName(<installation id>)`: the permit ledger
   * every isolate's applier calls share (FD-ARCH-003).
   */
  readonly INSTALLATION_QUOTA: {
    idFromName(name: string): unknown;
    get(id: unknown): QuotaObject;
  };
  /** `alerts.sink`; without it every alarm delivery fails and the alarm stays active. */
  readonly ALERT_SINK?: string;
  /** The rendered `{{spend}}`: the overlay's spend values in USD, each it leaves out at its default (FD-PROF-054). */
  readonly SPEND?: unknown;
  /** The rendered `{{policy.rules}}`: each repository's synced policy rules (FD-PROF-025, `policy.ts`). */
  readonly POLICY_RULES?: unknown;
  readonly DEPLOYMENT?: string;
  readonly PLANE_ID: string;
  /** The GitHub App's id and private key (a Worker secret); without both, nothing is applied to GitHub. */
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_APP_PRIVATE_KEY?: string;
  /** `github.fixtureRepo`: the repository the synthetic webhook canary pushes to (FD-OPS-038). */
  readonly GITHUB_FIXTURE_REPO?: string;
  /** The App's slug, whose bot the App commits as. */
  readonly GITHUB_APP_SLUG?: string;
  /** The webhook secret (a Worker secret); unset refuses every webhook (FD-INT-022). */
  readonly WEBHOOK_SECRET?: string;
  /** `dispatch.oidcAudience`; unset refuses every Actions token. */
  readonly DISPATCH_OIDC_AUDIENCE?: string;
  /**
   * The rendered `{{records.url}}`: the HTTPS URL that receives job and verdict records, empty where the overlay sets
   * none (FD-GH-093).
   */
  readonly RECORDS_URL?: string;
  /**
   * The verdict record signing key (a Worker secret), distinct from the webhook secret, the link key, the OIDC key and
   * the provenance key: `/health` answers `misconfigured` on a clash (FD-GH-099).
   */
  readonly RECORDS_SIGNING_KEY?: string;
  /** The Slack verdict endpoint and its signing secret. */
  readonly SLACK_URL?: string;
  readonly SLACK_SECRET?: string;
  /**
   * The rendered `{{provenance.attestationMaxAgeDays}}`: `attestation_max_age` in days, 10 where the overlay sets none
   * (FD-PROV-016). Wrangler delivers it as a number, a `.dev.vars` entry as its text.
   */
  readonly ATTESTATION_MAX_AGE_DAYS?: unknown;
  /**
   * The rendered `{{scan.advisoryEcosystems}}`: the OSV ecosystems `advisory-refresh` stores, none where the overlay
   * sets none (FD-OPS-100). Wrangler delivers it as an array, a `.dev.vars` entry as its JSON text.
   */
  readonly ADVISORY_ECOSYSTEMS?: unknown;
  /** The gate image's digest, `sha256:<hex>`, which every lease outside a device host execution names. */
  readonly GATE_IMAGE_DIGEST?: string;
  /** The repository a `development` deployment with no GitHub App reads (`dev-repository.ts`). */
  readonly FD_DEV_REPOSITORY?: string;
  /** `accountId`: every presigned URL is on the bucket's S3 endpoint `<account_id>.r2.cloudflarestorage.com`. */
  readonly R2_ACCOUNT_ID?: string;
  /** `r2.CACHE`: the name of the bucket `CACHE` binds, which every presigned URL's path starts with. */
  readonly CACHE_BUCKET_NAME?: string;
  /**
   * The object-store presigner's R2 API token (Worker secrets): scoped to the cache and artifact buckets with Object
   * Read & Write, and read by nothing but the presigner (FD-CACHE-091).
   */
  readonly R2_PRESIGN_ACCESS_KEY_ID?: string;
  readonly R2_PRESIGN_SECRET_ACCESS_KEY?: string;
  /** The one `TransparencyLog` object, `idFromName("private")`: the private log's only writer (FD-PROV-074). */
  readonly TRANSPARENCY_LOG?: {
    idFromName(name: string): unknown;
    get(id: unknown): {
      append(entry: Uint8Array): Promise<AppendOutcome>;
      inclusionProof(index: number): Promise<PrivateLogInclusionProof | null>;
    };
  };
}

/**
 * The values the presigner signs with that this deploy leaves unset, by binding name: the ops package's
 * `PRESIGNER_BINDINGS`, which the deploy stage's composition check reads too (FD-ARCH-039).
 */
export const presignerMissingOf = (env: ControlPlaneEnv): ReadonlyArray<string> =>
  unsetBindings(env, PRESIGNER_BINDINGS);

/**
 * The presigner's signing configuration, or `undefined` on a deploy missing the token, the account id or the bucket
 * name: it signs with the presign token and nothing else, on the account's S3 endpoint (FD-CACHE-091).
 */
export const presignerConfigOf = (env: ControlPlaneEnv): R2PresignerConfig | undefined =>
  presignerMissingOf(env).length === 0
    ? {
        // Each is set: `PRESIGNER_BINDINGS` names all four.
        accountId: env.R2_ACCOUNT_ID as string,
        bucket: env.CACHE_BUCKET_NAME as string,
        accessKeyId: env.R2_PRESIGN_ACCESS_KEY_ID as string,
        secretAccessKey: env.R2_PRESIGN_SECRET_ACCESS_KEY as string,
      }
    : undefined;

export const deployment = (env: Pick<ControlPlaneEnv, "DEPLOYMENT">): Deployment =>
  deploymentOf(env.DEPLOYMENT);

/** A rendered var holding an array arrives as the array; the API reads each identity list as JSON text. */
const textVar = (value: unknown): string | undefined =>
  value === undefined || typeof value === "string" ? value : JSON.stringify(value);

/** The API's bindings, as `apiConfigFromEnv` reads them. */
export const apiEnvOf = (env: ControlPlaneEnv): ApiEnv => {
  const raw = env as unknown as Readonly<Record<string, unknown>>;
  return {
    ...(raw as ApiEnv),
    OPERATORS: textVar(raw["OPERATORS"]),
    DISPATCHERS: textVar(raw["DISPATCHERS"]),
  } as ApiEnv;
};

/**
 * What `GET /health` answers: the deployment and plane id, or `503` `misconfigured` when the API refuses a binding,
 * among them a provenance key equal to the OIDC key, the log key or a capability-token key (FD-PROV-033), and a
 * records signing key equal to the webhook secret, the link key, the OIDC key or the provenance key (FD-GH-099). The
 * post-deploy probe reads anything but `200` as a failed deploy (FD-OPS-013). `/health` is public, so the body names
 * neither the refused binding nor its value; the Worker log carries the binding and the reason for the operator.
 */
export const healthOf = (
  env: ControlPlaneEnv,
  origin: string,
): { readonly status: 200 | 503; readonly body: Readonly<Record<string, string>> } => {
  const config = apiConfigFromEnv(apiEnvOf(env), origin);
  if (config instanceof ConfigInvalid) {
    console.error(`health: misconfigured: ${config.path}: ${config.message}`);
    return { status: 503, body: { status: "misconfigured" } };
  }
  return {
    status: 200,
    body: { status: "ok", deployment: deployment(env), plane_id: env.PLANE_ID },
  };
};

/** `records.url`, or undefined where the overlay sets none and the var renders empty (FD-GH-093). */
export const recordsUrlOf = (env: Pick<ControlPlaneEnv, "RECORDS_URL">): string | undefined => {
  const url = env.RECORDS_URL?.trim();
  return url === undefined || url === "" ? undefined : url;
};

/** The profile this deploy serves: its deployment at the current phase, with the record kinds where `records.url` is set. */
export const profileOf = (env: ControlPlaneEnv, phase: Phase = CURRENT_PHASE): Profile =>
  buildProfile(deployment(env), phase, { records: recordsUrlOf(env) !== undefined });

const DAY_MS = 24 * 3_600_000;

/**
 * The result-acceptance check's settings from the overlay: `attestation_max_age` from `ATTESTATION_MAX_AGE_DAYS`, the
 * 10-day default where the var is unset or empty (FD-PROV-016). A value that is not a positive number of days admits
 * no attestation, so a malformed var never lengthens the window a device's attestation stays valid in.
 */
export const acceptanceSettingsOf = (
  env: Pick<ControlPlaneEnv, "ATTESTATION_MAX_AGE_DAYS">,
): AcceptanceSettings => {
  const raw = env.ATTESTATION_MAX_AGE_DAYS;
  if (raw === undefined || raw === null || raw === "")
    return { attestationMaxAgeMs: DEFAULT_ATTESTATION_MAX_AGE_MS };
  const days = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return { attestationMaxAgeMs: Number.isFinite(days) && days > 0 ? days * DAY_MS : 0 };
};

/**
 * `scan.advisoryEcosystems` from `ADVISORY_ECOSYSTEMS`: none where the var is unset or empty, and `ConfigInvalid`
 * for a value that is not a list of non-empty names, so a malformed var stores nothing rather than a guessed list.
 */
export const advisoryEcosystemsOf = (
  env: Pick<ControlPlaneEnv, "ADVISORY_ECOSYSTEMS">,
): readonly string[] | ConfigInvalid => {
  const raw = env.ADVISORY_ECOSYSTEMS;
  if (raw === undefined || raw === null || raw === "") return [];
  let value: unknown = raw;
  if (typeof raw === "string")
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
  return Array.isArray(value) && value.every((e) => typeof e === "string" && e.trim() !== "")
    ? (value as string[]).map((e) => e.trim())
    : new ConfigInvalid({
        path: "ADVISORY_ECOSYSTEMS",
        message: "not a JSON list of ecosystem names",
      });
};

/**
 * The spend configuration the operator overlay delivers through the `SPEND` var, which the coordinator's spend view
 * reads; every value the overlay sets none for is at its default (FD-PROF-054).
 */
export const spendConfigOf = (env: ControlPlaneEnv): Effect.Effect<SpendConfig, SpendUnreadable> =>
  spendConfigOfVar(env.SPEND);

/**
 * One channel per device executor. No catalogue run requires `LocalContent` yet. A class whose terminal outcome is
 * `deferred` starts no workflow at admission, so the channel starts one at the winning claim (MAMEKO-ARCH-037). A claim
 * keyed by a name outside the catalogue answers `unknown-key` (MAMEKO-PROTO-031). Executor batches may carry only
 * kinds whose origin is `run`; the control plane's generated payloads never come from an executor.
 */
export const channelConfig = (profile: Profile): ExecutorChannelEnv["MAMEKO_CHANNEL_CONFIG"] => ({
  reclaimPolicy: profile.reclaim_policy,
  deferredClasses: profile.classes
    .filter((c) => c.terminal_outcome === "deferred")
    .map((c) => c.name),
  classes: profile.classes.map((c) => c.name),
  localContent: false,
  anyOutcomeKinds: Object.fromEntries(
    Object.entries(profile.intent_kinds)
      .filter(([, kind]) => kind.origin === "run" && kind.applied_for === "any")
      .map(([name, kind]) => [name, kind.effect_class]),
  ),
  intentKinds: Object.fromEntries(
    Object.entries(profile.intent_kinds)
      .filter(([, kind]) => kind.origin === "run")
      .map(([name, kind]) => [name, kind.effect_class]),
  ),
  notApplicableDetails: [...profile.outcome_mapping.not_applicable_details],
  executorKind: "device",
  planeShare: deviceSlotDefaults.total,
});

/**
 * The stage configuration. A device execution has no container rate and the channel takes no hold at claim, so each
 * class's hold terms are zero. A staged intent is written only for an outcome its kind is applied for (MAMEKO-RUN-074).
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
    appliedFor: Object.fromEntries(
      Object.entries(profile.intent_kinds).map(([name, kind]) => [name, kind.applied_for]),
    ),
  };
};

/** The row fields of the profile's `check.conclude` kind, which a child's conclusion carries like any row of it. */
export const concludeKindOf = (profile: Profile): ConcludeKind => {
  const entry = profile.intent_kinds["check.conclude"];
  return {
    tier: entry?.delivery_tier ?? "outcome",
    priority: entry?.priority ?? 0,
    effectClass: entry?.effect_class ?? "adoptable",
    drawsReserve: entry === undefined || drawsReserve(entry),
    classRanks: Object.fromEntries(profile.classes.map((c) => [c.name, c.rank])),
  };
};
