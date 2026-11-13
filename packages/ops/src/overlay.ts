// The operator overlay: a JSON document of values only, decoded against the value schema with every undeclared key
// rejected (specs/operability.md § Template, overlay and rendered configuration, FD-OPS-002 to FD-OPS-004, FD-OPS-056).
import type { RegistryEntry } from "@fractalboxdev/flare-dispatch-agentic";
import {
  PolicyRules,
  spendConfigWith,
  type SpendConfig,
} from "@fractalboxdev/flare-dispatch-profile";
import { Effect, Schema } from "effect";
import { decodeStrict, type DecodeIssue } from "./decode.ts";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const Usd = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const Ids = Schema.Record(Schema.String, NonEmpty);
const opt = Schema.optional;

/** An HTTPS webhook URL or an email address (FD-OPS-056). */
export const AlertSink = NonEmpty.check(
  Schema.makeFilter((s: string) =>
    /^https:\/\/[^\s/]+/.test(s) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
      ? undefined
      : "an HTTPS URL or an email address",
  ),
);

/**
 * One provider registry entry under `models.registry`, keyed by its entry id (MAMEKO-MDL-020). The route kind stays a
 * string here: the drift check names an unregistered one (FD-MDL-020), and a `workers-ai` entry's rate is checked
 * against its Neurons price there (FD-MDL-022).
 */
export const ModelEntryValues = Schema.Struct({
  providerId: NonEmpty,
  routeKind: NonEmpty,
  serves: Schema.Array(Schema.Literals(["judgment", "transform"])).check(Schema.isMinLength(1)),
  upstreamModel: NonEmpty,
  inputPriceMicroUsdPerMTok: opt(Usd),
  outputPriceMicroUsdPerMTok: opt(Usd),
  neuronsPerMTok: opt(Schema.Struct({ input: Usd, output: Usd })),
  contextWindow: opt(Count),
  weights: opt(NonEmpty),
  quantization: opt(NonEmpty),
});

/**
 * The overlay's `spend` values in USD: `B`, `F`, the release reserve, `R_ops`, `R_m,min`, `D` and the overhead factor
 * (specs/profile.md § Spend configuration). The control plane's `SPEND` var holds the same struct with every value set.
 */
export const SpendValues = Schema.Struct({
  budgetUsd: opt(Usd),
  fixedUsd: opt(Usd),
  releaseReserveUsd: opt(Usd),
  opsReserveUsd: opt(Usd),
  measuredReserveMinUsd: opt(Usd),
  measuredReserveDays: opt(Count),
  overheadFactor: opt(Schema.Number.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type SpendValues = typeof SpendValues.Type;

/** Every value path the overlay may hold; nothing else (FD-OPS-002). */
export const OverlayValues = Schema.Struct({
  accountId: NonEmpty,
  d1: Ids,
  kv: opt(Ids),
  r2: Ids,
  /**
   * The id of the account R2 API token the object-store presigner signs with, which is the Access Key ID the Worker
   * secret `R2_PRESIGN_ACCESS_KEY_ID` holds; the drift check reads its policies (FD-CACHE-091).
   */
  presign: opt(Schema.Struct({ tokenId: NonEmpty })),
  hostnames: Ids,
  access: Schema.Struct({ teamDomain: NonEmpty, aud: NonEmpty }),
  operators: Schema.Array(NonEmpty).check(Schema.isMinLength(1)),
  dispatchers: opt(Schema.Array(NonEmpty)),
  github: Schema.Struct({ appId: NonEmpty, fixtureRepo: NonEmpty }),
  intake: opt(Schema.Struct({ webhookEvents: opt(Schema.Array(NonEmpty)) })),
  dispatch: opt(Schema.Struct({ oidcAudience: NonEmpty })),
  executors: Schema.Struct({ planeId: NonEmpty }),
  alerts: Schema.Struct({ sink: AlertSink, webhookSilentHours: opt(Count) }),
  spend: opt(SpendValues),
  pools: opt(Schema.Record(Schema.String, Schema.Struct({ maxInstances: Count }))),
  aws: opt(
    Schema.Struct({
      budgetUsd: opt(Usd),
      /** The ECS launcher's IAM role; required to prove an IAM Budgets action stops that launcher. */
      launcherRoleArn: opt(NonEmpty),
      launchCap: opt(Count),
      egressProxy: opt(NonEmpty),
      imageRegistry: opt(NonEmpty),
    }),
  ),
  gha: opt(
    Schema.Struct({
      concurrencyCap: opt(Count),
      runnerRepo: opt(NonEmpty),
      workflow: opt(NonEmpty),
    }),
  ),
  egress: opt(Schema.Struct({ targetPatterns: Schema.Array(NonEmpty) })),
  models: opt(
    Schema.Struct({
      registry: opt(Schema.Record(Schema.String, ModelEntryValues)),
      fallbackPriceUsdPerMTok: opt(Usd),
      bucketShares: opt(Schema.Record(Schema.String, Schema.Number)),
      breaker: opt(Schema.Number),
    }),
  ),
  /**
   * Each repository's policy rules, keyed `<owner>/<repo>`: the class rules of class resolution and the repository's
   * confidentiality mode, which policy sync checks before the deploy writes anything (FD-PROF-025).
   */
  policy: opt(Schema.Struct({ rules: opt(PolicyRules) })),
  provenance: opt(
    Schema.Struct({
      attestationMaxAgeDays: opt(Count),
      reattestIntervalDays: opt(Count),
      auditRate: opt(Schema.Number),
      statementRetentionDays: opt(Count),
    }),
  ),
});
export type OverlayValues = typeof OverlayValues.Type;

/** `fd deploy` refused the overlay before any Cloudflare state changed; each issue names its path. */
export class OverlayRejected extends Schema.TaggedError<OverlayRejected>()("OverlayRejected", {
  issues: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
}) {}

/** `attestation_max_age` where the overlay sets none: 10 days (FD-PROV-016). */
export const ATTESTATION_MAX_AGE_DEFAULT_DAYS = 10;
/** `reattest_interval` where the overlay sets none: 7 days (FD-PROV-030). */
export const REATTEST_INTERVAL_DEFAULT_DAYS = 7;
/** The margin `attestation_max_age` keeps over `reattest_interval`: 48 h. */
export const REATTEST_MARGIN_HOURS = 48;

/**
 * The cross-field rules of the overlay's provenance values: `attestation_max_age` is at least `reattest_interval` plus
 * 48 h, each at its default where the overlay sets none (FD-PROV-077). Below that, a device that re-attests on time
 * still outlives its last attestation, and its statements answer `attestation-expired` (FD-PROV-016).
 */
export const provenanceIssues = (overlay: OverlayValues): readonly DecodeIssue[] => {
  const maxAge = overlay.provenance?.attestationMaxAgeDays ?? ATTESTATION_MAX_AGE_DEFAULT_DAYS;
  const interval = overlay.provenance?.reattestIntervalDays ?? REATTEST_INTERVAL_DEFAULT_DAYS;
  return maxAge * 24 >= interval * 24 + REATTEST_MARGIN_HOURS
    ? []
    : [
        {
          path: "provenance.attestationMaxAgeDays",
          message: `attestation_max_age (${maxAge} d) is below reattest_interval (${interval} d) plus ${REATTEST_MARGIN_HOURS} h`,
        },
      ];
};

/** Parses and decodes an overlay document (FD-OPS-003, FD-OPS-004, FD-OPS-056, FD-PROV-077). */
export const decodeOverlay = (text: string) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (e) =>
        new OverlayRejected({ issues: [{ path: "", message: `not JSON: ${String(e)}` }] }),
    });
    const overlay = yield* decodeStrict(OverlayValues, parsed).pipe(
      Effect.mapError((issues: readonly DecodeIssue[]) => new OverlayRejected({ issues })),
    );
    const issues = provenanceIssues(overlay);
    if (issues.length > 0) return yield* new OverlayRejected({ issues });
    return overlay;
  });

const micro = (usd: number | undefined) => (usd === undefined ? undefined : Math.round(usd * 1e6));

/** The spend configuration a set of spend values delivers, each unset value at its default (FD-PROF-054). */
export const spendConfigFrom = (s: SpendValues = {}): SpendConfig => {
  const release = micro(s.releaseReserveUsd);
  return spendConfigWith({
    ...(s.budgetUsd === undefined ? {} : { budget: micro(s.budgetUsd)! }),
    ...(s.fixedUsd === undefined ? {} : { fixed: micro(s.fixedUsd)! }),
    ...(s.opsReserveUsd === undefined ? {} : { ops_reserve: micro(s.opsReserveUsd)! }),
    ...(s.measuredReserveMinUsd === undefined
      ? {}
      : { measured_reserve_min: micro(s.measuredReserveMinUsd)! }),
    ...(s.measuredReserveDays === undefined
      ? {}
      : { measured_reserve_days: s.measuredReserveDays }),
    ...(s.overheadFactor === undefined ? {} : { overhead_factor: s.overheadFactor }),
    ...(release === undefined ? {} : { reserves: { "release-reserve": release } }),
  });
};

/** The spend configuration the overlay delivers, each unset value at its default (FD-PROF-054, FD-OPS-083). */
export const spendConfigOf = (overlay: OverlayValues): SpendConfig =>
  spendConfigFrom(overlay.spend);

/**
 * The overlay's spend values with every one the overlay leaves out at its default, in USD: what a template's
 * `{{spend}}` and `{{spend.<key>}}` placeholders render (FD-PROF-054).
 */
export const spendValuesOf = (overlay: OverlayValues): Required<SpendValues> => {
  const c = spendConfigOf(overlay);
  return {
    budgetUsd: c.budget / 1e6,
    fixedUsd: c.fixed / 1e6,
    releaseReserveUsd: (c.reserves["release-reserve"] ?? 0) / 1e6,
    opsReserveUsd: c.ops_reserve / 1e6,
    measuredReserveMinUsd: c.measured_reserve_min / 1e6,
    measuredReserveDays: c.measured_reserve_days,
    overheadFactor: c.overhead_factor,
  };
};

/** The overlay's policy rules, none for a repository the overlay names no rule for (FD-PROF-025). */
export const policyRulesOf = (overlay: OverlayValues): PolicyRules => overlay.policy?.rules ?? {};

/** The values a template's placeholders resolve against (`renderValuesOf`). */
export type RenderValues = Omit<
  OverlayValues,
  "spend" | "policy" | "dispatchers" | "intake" | "dispatch"
> & {
  readonly spend: Required<SpendValues>;
  readonly policy: { readonly rules: PolicyRules };
  readonly dispatchers: readonly string[];
  /** `null` where the overlay sets no list: absent admits every supported event, `[]` none (FD-INT-027). */
  readonly intake: { readonly webhookEvents: readonly string[] | null };
  /** Empty where the overlay sets none, which refuses every Actions token. */
  readonly dispatch: { readonly oidcAudience: string };
};

/**
 * The values a template's placeholders resolve against: the overlay, its spend values completed with their defaults,
 * its policy rules and dispatchers, an empty set where it holds none, its Actions OIDC audience, empty where it sets
 * none, and its intake webhook events, `null` where it sets none, so the rendered Worker tells an absent list (every
 * supported event) from an empty one (none) (FD-INT-027).
 */
export const renderValuesOf = (overlay: OverlayValues): RenderValues => ({
  ...overlay,
  spend: spendValuesOf(overlay),
  policy: { ...overlay.policy, rules: policyRulesOf(overlay) },
  dispatchers: overlay.dispatchers ?? [],
  intake: { webhookEvents: overlay.intake?.webhookEvents ?? null },
  dispatch: { oidcAudience: overlay.dispatch?.oidcAudience ?? "" },
});

/** The overlay's provider registry as the deploy check reads it, each entry under its key as its id. */
export const modelRegistryOf = (overlay: OverlayValues): readonly RegistryEntry[] =>
  Object.entries(overlay.models?.registry ?? {}).map(([id, e]) => ({
    id,
    providerId: e.providerId,
    routeKind: e.routeKind,
    serves: e.serves,
    upstreamModel: e.upstreamModel,
    ...(e.inputPriceMicroUsdPerMTok === undefined
      ? {}
      : { inputPriceMicroUsdPerMTok: e.inputPriceMicroUsdPerMTok }),
    ...(e.outputPriceMicroUsdPerMTok === undefined
      ? {}
      : { outputPriceMicroUsdPerMTok: e.outputPriceMicroUsdPerMTok }),
    ...(e.neuronsPerMTok === undefined ? {} : { neuronsPerMTok: e.neuronsPerMTok }),
  }));

/**
 * A complete overlay of placeholder values, for CI's dry run and the drift check on every pull request. Its provider
 * registry holds one entry per route kind FlareDispatch registers, each priced as the deploy check requires.
 */
export const placeholderOverlay: OverlayValues = {
  accountId: "00000000000000000000000000000000",
  d1: { DB: "00000000-0000-0000-0000-000000000000" },
  kv: { CONFIG: "00000000000000000000000000000000" },
  r2: { CACHE: "flare-dispatch-cache", ARTIFACTS: "flare-dispatch-artifacts" },
  presign: { tokenId: "00000000000000000000000000000000" },
  hostnames: { dispatcher: "dispatch.example.com", docs: "docs.example.com" },
  access: { teamDomain: "example.cloudflareaccess.com", aud: "placeholder-aud" },
  operators: ["operator@example.com"],
  github: { appId: "0", fixtureRepo: "example/canary" },
  executors: { planeId: "flare-dispatch" },
  alerts: { sink: "https://alerts.example.com/hook" },
  models: {
    registry: {
      "workers-ai-example": {
        providerId: "workers-ai",
        routeKind: "workers-ai",
        serves: ["transform"],
        upstreamModel: "@cf/example/model",
        neuronsPerMTok: { input: 25_608, output: 75_147 },
        inputPriceMicroUsdPerMTok: 25_608 * 11,
        outputPriceMicroUsdPerMTok: 75_147 * 11,
      },
      "bedrock-example": {
        providerId: "bedrock",
        routeKind: "bedrock",
        serves: ["judgment"],
        upstreamModel: "example.model-v1",
        inputPriceMicroUsdPerMTok: 3_000_000,
        outputPriceMicroUsdPerMTok: 15_000_000,
      },
    },
  },
};
