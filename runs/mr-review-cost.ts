// Per-run cost accounting for `mr-review` — a small, PURE pricing + footer
// module (no Effect, no bindings) so the math is unit-testable in plain Node.
//
// Workers AI bills in "neurons": an abstract compute unit, $0.011 per 1,000
// neurons on the paid plan (the free plan grants a daily 10k-neuron allowance).
// Most catalog models ALSO report token usage on the response — the model
// gateway now surfaces it (inputTokens / outputTokens). We turn tokens → USD via
// a per-model $/M-token table, then USD → neurons so the footer speaks the unit
// the operator's Cloudflare dashboard bills in.
//
//   neurons = usd / 0.000011              ( $0.011 / 1000 )
//   usd     = inTok/1e6 * inRate + outTok/1e6 * outRate
//
// The footer degrades honestly: a model with NO reported usage renders no footer
// at all (we never guess token counts); a model with usage but no known price
// renders the token counts alone (no USD / neuron figures invented); a model
// whose reported counts are non-finite or negative (a malformed backend
// response) renders `?` token counts and never a dollar figure — a silent `0`
// fallback would UNDERSTATE the real cost, which is worse than admitting we
// don't know it.

/** A model's price, per MILLION tokens: `[inputPerM, outputPerM]` USD. */
export type ModelPricing = readonly [inputPerM: number, outputPerM: number];

/**
 * One model's metered usage. `mr-review` runs personas, naive seats and
 * verifiers that can each be pinned to a DIFFERENT model id (`pr-review.naive.model`
 * / `pr-review.verify.model` can diverge from the persona model) — so usage,
 * and the price it is billed at, is tracked PER MODEL (see {@link CostUsage.byModel}),
 * not as one blended total.
 */
export type ModelUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * How many model calls were metered — every domain reviewer, naive seat and
   * verifier call, success or failure alike (a call that failed still cost a
   * request). `undefined` for a `ModelUsage`/`CostUsage` value built before
   * this field existed; treat as 0. Feeds the timing/infra-cost footer's "<N>
   * model calls" line (gitlab-review-outcome.ts's `estimateInfraUsd`), separate
   * from the $/token pricing this module computes.
   */
  readonly calls?: number;
  /**
   * `true` when at least one metered call for this model reported a
   * NON-FINITE or NEGATIVE token count (a malformed backend response), on
   * EITHER side. {@link costFooter} renders `?` for BOTH sides and skips the
   * dollar figure entirely for a bucket marked `unknown` — coercing a bad
   * count to `0` would silently UNDERSTATE the real spend, which is a worse
   * lie than admitting we don't know it.
   */
  readonly unknown?: boolean;
  /**
   * `true` when at least one metered call reported the OTHER side's token
   * count but not this one — a genuinely MISSING data point, distinct from a
   * model that never reports usage at all (both sides absent renders no
   * footer at all, never `?`). {@link costFooter} renders `?` for just this
   * side and skips the dollar figure (a price needs both sides), rather than
   * silently pricing the missing side as free.
   */
  readonly inputUnknown?: boolean;
  /** Same as {@link ModelUsage.inputUnknown}, for the output side. */
  readonly outputUnknown?: boolean;
};

/** Aggregated token usage across a run's (possibly multi-model) model fan-out. */
export type CostUsage = ModelUsage & {
  /** Usage broken out per model id — the source {@link costFooter} prices
   *  each model's tokens at ITS OWN rate rather than one blended price. The
   *  top-level `inputTokens`/`outputTokens`/`calls`/`unknown` fields remain the
   *  AGGREGATE across every model, for a caller that only wants the total. */
  readonly byModel?: Readonly<Record<string, ModelUsage>>;
};

/**
 * Published Workers AI $/M-token rates for the models this PoC uses. Overridable
 * per-model via CONFIG_KV `pr-review.pricing.<model>` = `"<in>,<out>"` (see
 * {@link parsePricingOverride}) so a rate change needs no redeploy. A model
 * absent here AND absent from config renders token-only (no USD).
 */
export const DEFAULT_PRICING: Readonly<Record<string, ModelPricing>> = {
  "@cf/qwen/qwen2.5-coder-32b-instruct": [0.66, 1.0],
  "@cf/meta/llama-3.1-8b-instruct-fast": [0.045, 0.38],
  "@cf/mistralai/mistral-small-3.1-24b-instruct": [0.35, 0.56],
  // Likely next defaults after the bake-off (catalog ids verified against the
  // @cloudflare/workers-types AI catalog).
  "@cf/openai/gpt-oss-120b": [0.35, 0.75],
  "@cf/openai/gpt-oss-20b": [0.2, 0.3],
};

/** USD per neuron — Workers AI bills $0.011 per 1,000 neurons. */
export const USD_PER_NEURON = 0.000011;

/** The CONFIG_KV key an operator sets to override a model's price. */
export const pricingKey = (model: string): string => `pr-review.pricing.${model}`;

/**
 * Parse a CONFIG_KV pricing override — `"<inPerM>,<outPerM>"` (e.g. `"0.66,1.0"`).
 * Returns `undefined` for any malformed value (wrong arity, non-finite,
 * negative, OR a blank component — `"0.66,"` / `",1.0"` mean "unset", never
 * "zero": a fat-fingered override should fall back to the built-in table, not
 * silently bill the output side for free) so a bad override never renders a
 * nonsense price.
 */
export const parsePricingOverride = (raw: string | undefined): ModelPricing | undefined => {
  if (raw === undefined) return undefined;
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 2 || parts.some((p) => p.length === 0)) return undefined;
  const [inRate, outRate] = parts.map(Number) as [number, number];
  if (!Number.isFinite(inRate) || !Number.isFinite(outRate) || inRate < 0 || outRate < 0) {
    return undefined;
  }
  return [inRate, outRate];
};

/** Resolve a model's price — the operator override wins over the built-in table. */
export const resolvePricing = (
  model: string,
  override: ModelPricing | undefined,
): ModelPricing | undefined => override ?? DEFAULT_PRICING[model];

/** Convert an aggregated usage + price into USD + neurons. Assumes `usage`'s
 *  token counts are already known-good (finite, non-negative) — callers with
 *  possibly-bad counts go through {@link costFooter}'s `unknown` guard first. */
export const costOf = (
  usage: ModelUsage,
  pricing: ModelPricing,
): { readonly usd: number; readonly neurons: number } => {
  const usd = (usage.inputTokens / 1e6) * pricing[0] + (usage.outputTokens / 1e6) * pricing[1];
  return { usd, neurons: Math.round(usd / USD_PER_NEURON) };
};

const grouped = (n: number): string => Math.round(n).toLocaleString("en-US");

/**
 * Render a USD figure for the cost footer. `≈` marks a computed (not
 * exact) cost. An EXACT zero renders as plain `$0`
 * — genuinely free (e.g. a `0,0` pricing override) is a different claim than
 * "a fraction of a cent". Sub-millidollar totals render as `< $0.001` rather
 * than the misleading `≈$0.0000` (a run that spent a real, nonzero fraction
 * of a cent should never read as free). Shared with the Workers/Workflows
 * infra-cost estimate (`apps/dispatcher/src/gitlab-review-outcome.ts`'s
 * `estimateInfraUsd` line) — that call site should adopt this formatter too,
 * for the same reason.
 */
export const formatUsd = (usd: number): string =>
  usd === 0 ? "$0" : usd < 0.001 ? "< $0.001" : `≈$${usd.toFixed(4)}`;

/**
 * Render one model's per-run cost footer line — or `null` to omit it entirely.
 * Shape:
 *
 *   ⚙️ @cf/qwen/qwen2.5-coder-32b-instruct · 14,230 in + 1,872 out tokens · ~1,024 neurons · ≈$0.0113
 *
 * Degradation:
 *   * usage marked {@link ModelUsage.unknown} (a non-finite/negative reported
 *     count on EITHER side) → `? in + ? out tokens`, no price line, ever —
 *     never guess a number, and never let a bad count silently price as zero.
 *   * one side flagged {@link ModelUsage.inputUnknown} / `outputUnknown`
 *     (that side was reported by no call while the OTHER side WAS) → `?` for
 *     just that side, no price line — never price a missing side as free.
 *   * no usage at all (both counts ≤ 0, not unknown/missing) → `null` (no footer).
 *   * usage but no known price → token counts only (no USD/neurons).
 */
export const costFooter = (args: {
  readonly model: string;
  readonly usage: ModelUsage;
  readonly pricing: ModelPricing | undefined;
}): string | null => {
  const { model, usage, pricing } = args;
  const inputOk = Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0;
  const outputOk = Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0;
  const bothUnknown = usage.unknown === true || !inputOk || !outputOk;
  if (bothUnknown) return `⚙️ ${model} · ? in + ? out tokens`;

  // A side flagged individually missing (see {@link ModelUsage.inputUnknown})
  // is NOT the same as both sides being malformed above — render `?` for
  // just that side, and never a dollar figure (a price needs both sides).
  const inputMissing = usage.inputUnknown === true;
  const outputMissing = usage.outputUnknown === true;
  if (!inputMissing && !outputMissing && usage.inputTokens <= 0 && usage.outputTokens <= 0) return null;

  const inputText = inputMissing ? "?" : grouped(usage.inputTokens);
  const outputText = outputMissing ? "?" : grouped(usage.outputTokens);
  const tokens = `${inputText} in + ${outputText} out tokens`;
  if (inputMissing || outputMissing || pricing === undefined) return `⚙️ ${model} · ${tokens}`;

  const { usd, neurons } = costOf(usage, pricing);
  return `⚙️ ${model} · ${tokens} · ~${grouped(neurons)} neurons · ${formatUsd(usd)}`;
};

/**
 * Render the footer for a run's FULL usage — one line per model that was
 * actually metered (see {@link CostUsage.byModel}), each priced at its own
 * rate, joined with a newline; `null` when nothing was metered / every
 * model's line degraded to `null`. `resolvePricingFor` lets the caller
 * resolve each model's operator override from CONFIG_KV (an Effect-ful
 * lookup `mr-review.ts` performs outside this pure module). Falls back to
 * ONE line rendered from the run's AGGREGATE totals when `byModel` carries no
 * breakdown at all, rather than silently omitting the footer when real usage
 * was metered.
 */
export const costFooterForUsage = (
  usage: CostUsage,
  resolvePricingFor: (model: string) => ModelPricing | undefined,
): string | null => {
  const byModel = usage.byModel ?? {};
  const modelIds = Object.keys(byModel);
  if (modelIds.length > 0) {
    const lines = modelIds
      .map((model) => costFooter({ model, usage: byModel[model]!, pricing: resolvePricingFor(model) }))
      .filter((l): l is string => l !== null);
    return lines.length === 0 ? null : lines.join("\n");
  }
  // No per-model breakdown recorded — there is no model id here to price
  // against, so this line is always token-counts-only (never invents a price
  // for an unknown model). Each side degrades on its own: a side flagged
  // `inputUnknown`/`outputUnknown`, non-finite or negative renders `?`, while
  // the other side keeps its grouped count; `unknown === true` still marks BOTH
  // sides `?`.
  const inputOk = Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0;
  const outputOk = Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0;
  if (usage.unknown === true) return "⚙️ ? in + ? out tokens";
  const inputMissing = usage.inputUnknown === true || !inputOk;
  const outputMissing = usage.outputUnknown === true || !outputOk;
  if (!inputMissing && !outputMissing && usage.inputTokens <= 0 && usage.outputTokens <= 0) return null;
  const inputText = inputMissing ? "?" : grouped(usage.inputTokens);
  const outputText = outputMissing ? "?" : grouped(usage.outputTokens);
  return `⚙️ ${inputText} in + ${outputText} out tokens`;
};
