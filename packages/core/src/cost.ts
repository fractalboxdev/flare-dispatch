// @fractalbox/flare-dispatch-core — the cost engine (rate card + pure cost functions).
//
// The single source of truth for "what did an execution cost". Pure: no Effect,
// no I/O, no bindings — just the rate card (mirrored from `specs/06-cost.md` and
// the model rate cards) and pure functions over usage components. Consumed by:
//
//   * the runtime (`packages/runtime-cf`) — to persist a per-execution cost
//     rollup at `finishExecution`;
//   * the docs benchmark generator (`scripts/emit-benchmarks.mjs`) — to render a
//     per-recipe modeled speed+cost table (the .mjs mirrors the rate constants
//     below; `cost.test.ts` fails CI if the mirror drifts, the same
//     drift-guard pattern as `signals.ts` ↔ `emit-signals-schema.mjs`);
//   * the analytics endpoint + dashboard — to display per-execution cost.
//
// --- metered vs modeled — the load-bearing distinction --------------------------
//
// Cost is METERED only where we have a real measured number. Today that is model
// tokens, and ONLY for backends whose gateway response carries a usage block
// (Anthropic / Bedrock / DeepSeek). It is MODELED everywhere else:
//
//   * container compute is ALWAYS modeled — `instance vCPU/mem rate × active
//     seconds`. Cloudflare meters container vCPU-s at the ACCOUNT level only
//     (the `cloudflare.usage` GraphQL surface), never per-execution, so a
//     per-execution container number is a model, not a meter.
//   * Workers AI catalog models (`@cf/…`) expose NO token usage (the binding is
//     the auth, billing is account-level Neurons) — so their model cost is
//     UNMETERED. We never invent a USD figure for them; `microUsd` is `null`.
//
// `estimateExecutionCost` returns a per-component breakdown plus an overall
// `basis` so every surface can label honestly. NEVER present a modeled number as
// metered (the project pressure-tests cost claims).
//
// Money is integer **micro-USD** (1 USD = 1_000_000 µ$) to avoid float drift in
// the persisted rollup. The published rate cards are USD-per-million-tokens and
// USD-per-vCPU-second, which fall out to clean µ$ factors (see below).
//
// Spec: specs/06-cost.md (pricing model + worked per-execution anatomy).

/** One micro-USD. 1 USD = 1_000_000 µ$. The persisted/returned unit. */
export const MICRO_USD_PER_USD = 1_000_000;

// --- Container instance types ---------------------------------------------------
//
// vCPU + memory per Cloudflare Containers instance type (specs/05-byoc.md §
// Wrangler config, "Instance types (2026-05)"). A run's instance type is fixed
// by the Durable Object class its `sandboxImage` selects (wrangler.jsonc):
// `lean`/`browser` → `standard-2`, `agent` → `standard-3`.

export type InstanceType =
  | "lite"
  | "basic"
  | "standard-1"
  | "standard-2"
  | "standard-3"
  | "standard-4";

export type InstanceSpec = {
  /** Allotted vCPU for the instance type. */
  readonly vcpu: number;
  /** Allotted memory in GiB. */
  readonly gib: number;
};

/** vCPU / memory by instance type (specs/05-byoc.md § Wrangler config). */
export const INSTANCE_SPECS: Record<InstanceType, InstanceSpec> = {
  lite: { vcpu: 1 / 16, gib: 0.25 },
  basic: { vcpu: 1 / 4, gib: 1 },
  "standard-1": { vcpu: 1 / 2, gib: 4 },
  "standard-2": { vcpu: 1, gib: 6 },
  "standard-3": { vcpu: 2, gib: 8 },
  "standard-4": { vcpu: 4, gib: 12 },
} as const;

// --- Container rates (specs/06-cost.md § Pricing model) -------------------------
//
// $0.000020 / vCPU-s and $0.0000025 / GiB-s. In µ$: multiply USD by 1e6.
//   $0.000020 × 1e6 = 20 µ$ per vCPU-second
//   $0.0000025 × 1e6 = 2.5 µ$ per GiB-second
// (Disk GB-s is billed too but rounds to zero per-execution and we don't track
// it — see specs/06-cost.md § Per-execution cost anatomy.)

/** Container vCPU-second rate, in micro-USD (`$0.000020/vCPU-s`). */
export const CONTAINER_VCPU_MICRO_USD_PER_SEC = 20;
/** Container memory GiB-second rate, in micro-USD (`$0.0000025/GiB-s`). */
export const CONTAINER_GIB_MICRO_USD_PER_SEC = 2.5;

// --- Model token rates ----------------------------------------------------------
//
// USD per MILLION tokens, by model family. The handy identity: micro-USD =
// tokens × (USD per million), since µ$ = (tokens / 1e6 × usdPerM) × 1e6.
//
// Claude rates are authoritative (current model rate card). Bedrock-hosted Claude
// bills at roughly the same per-token rate PLUS the AI Gateway hop + AWS markup
// — treated here as the same planning rate (specs/06-cost.md frames all figures
// as planning estimates). DeepSeek (hosted `reasonix`) is an approximate
// published rate. Workers AI catalog (`@cf/…`) has NO per-token rate — it bills
// as account-level Neurons, so it is UNMETERED here (rate `null`).

export type ModelRate = {
  /** USD per 1M input tokens. */
  readonly inputPerMTokUsd: number;
  /** USD per 1M output tokens. */
  readonly outputPerMTokUsd: number;
  /** Provenance of the rate, for the rate-card footnote. */
  readonly source: string;
};

/**
 * Resolve a (possibly backend-prefixed) model id to its per-token rate, or
 * `null` when the model is unmetered (Workers AI catalog) or unknown. Ordered:
 * the `@cf/` catalog check runs FIRST so a catalog distill that happens to carry
 * "deepseek" in its id (e.g. `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`) is
 * correctly classified unmetered, not billed at DeepSeek's hosted rate.
 *
 * Matching is by family substring so the prefixed ids the runtime actually sees
 * resolve: `anthropic/claude-sonnet-4-6`, `bedrock/us.anthropic.claude-opus-4-6-v1`,
 * `deepseek/deepseek-reasoner`, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
 */
export const modelRate = (model: string): ModelRate | null => {
  const id = model.toLowerCase();
  // Workers AI catalog: the binding is the auth, billing is account-level
  // Neurons — no per-token rate exists. UNMETERED. Check before any family
  // substring so catalog-hosted distills don't match a hosted rate.
  if (id.startsWith("@cf/")) return null;
  if (id.includes("opus-4")) {
    return {
      inputPerMTokUsd: 5,
      outputPerMTokUsd: 25,
      source: "Claude Opus rate card ($5 / $25 per 1M tok)",
    };
  }
  if (id.includes("sonnet-4")) {
    return {
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 15,
      source: "Claude Sonnet rate card ($3 / $15 per 1M tok)",
    };
  }
  if (id.includes("haiku-4")) {
    return {
      inputPerMTokUsd: 1,
      outputPerMTokUsd: 5,
      source: "Claude Haiku rate card ($1 / $5 per 1M tok)",
    };
  }
  if (id.includes("deepseek")) {
    return {
      inputPerMTokUsd: 0.55,
      outputPerMTokUsd: 2.19,
      source: "DeepSeek reasoner published rate (approx, planning estimate)",
    };
  }
  return null;
};

// --- Cost components ------------------------------------------------------------

/** A model-inference cost component. `microUsd` is `null` when the model is
 *  unmetered (catalog / unknown) — the tokens are still recorded by the caller,
 *  but no USD figure is invented. */
export type ModelCost = {
  readonly microUsd: number | null;
  /** True when a per-token rate was found (Anthropic/Bedrock/DeepSeek). */
  readonly rateKnown: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

/**
 * Cost of model inference from token counts. Pure rate application — the caller
 * decides whether the token counts are REAL (metered, from a gateway usage
 * block) or estimated (modeled, for the docs benchmark); `cost.ts` only converts
 * tokens × rate. Unmetered model → `{ microUsd: null, rateKnown: false }`.
 */
export const modelCost = (opts: {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}): ModelCost => {
  const rate = modelRate(opts.model);
  if (rate === null) {
    return {
      microUsd: null,
      rateKnown: false,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
    };
  }
  // µ$ = tokens × (USD per million tokens).
  const microUsd = Math.round(
    opts.inputTokens * rate.inputPerMTokUsd + opts.outputTokens * rate.outputPerMTokUsd,
  );
  return {
    microUsd,
    rateKnown: true,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
  };
};

/**
 * Modeled container-compute cost: `(vCPU-s × vCPU-rate) + (GiB-s × GiB-rate)`.
 * GiB-seconds derive from the instance's allotted memory × active seconds. This
 * is ALWAYS modeled — Cloudflare meters container vCPU-s at the account level
 * only, never per-execution.
 */
export const containerCostMicroUsd = (opts: {
  readonly instance: InstanceType;
  /** Seconds the container was active (boot → destroy, or summed exec time). */
  readonly activeSeconds: number;
}): number => {
  const spec = INSTANCE_SPECS[opts.instance];
  const vcpuSeconds = spec.vcpu * opts.activeSeconds;
  const gibSeconds = spec.gib * opts.activeSeconds;
  return Math.round(
    vcpuSeconds * CONTAINER_VCPU_MICRO_USD_PER_SEC +
      gibSeconds * CONTAINER_GIB_MICRO_USD_PER_SEC,
  );
};

// --- Whole-execution estimate ---------------------------------------------------

/** How a total was arrived at — drives the honesty label on every surface.
 *
 *   `metered`   — every contributing component is metered (real model tokens,
 *                 negligible/absent container compute).
 *   `mixed`     — metered model tokens + modeled container compute.
 *   `modeled`   — no metered component (container-only, or estimated tokens).
 *   `unmetered` — a model ran but its tokens aren't observable (catalog) and
 *                 there's no container compute to model either.
 */
export type CostBasis = "metered" | "mixed" | "modeled" | "unmetered";

export type ExecutionCost = {
  /** Sum of the known component costs, in micro-USD. */
  readonly totalMicroUsd: number;
  /** Modeled container component (µ$), or `null` if no container ran. */
  readonly containerMicroUsd: number | null;
  /** Model component (µ$), or `null` if no model ran or it was unmetered. */
  readonly modelMicroUsd: number | null;
  readonly basis: CostBasis;
};

/**
 * Combine the components into a per-execution rollup with an honest overall
 * `basis`. `modelTokensMetered` tells us whether the model token counts are real
 * (from a gateway usage block) or estimated (docs benchmark) — it only affects
 * the `basis` label, never the arithmetic.
 *
 * Negligible-container rule: when a metered-model execution also ran a tiny
 * container (e.g. `pr-review`'s clone+diff), the overall basis stays `mixed`
 * rather than collapsing to `metered` — the container line, however small, is
 * still modeled. A pure metered result (`basis: "metered"`) only arises when no
 * container component is present at all.
 */
export const estimateExecutionCost = (opts: {
  readonly container?: { readonly instance: InstanceType; readonly activeSeconds: number };
  readonly model?: {
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Real tokens from a gateway usage block (true) vs estimated (false). */
    readonly metered: boolean;
  };
}): ExecutionCost => {
  const containerMicroUsd =
    opts.container !== undefined ? containerCostMicroUsd(opts.container) : null;

  const mc = opts.model !== undefined ? modelCost(opts.model) : null;
  const modelMicroUsd = mc?.microUsd ?? null;

  const total = (containerMicroUsd ?? 0) + (modelMicroUsd ?? 0);

  // Decide the honesty label.
  const hasMeteredModel =
    mc !== null && mc.rateKnown && opts.model?.metered === true && modelMicroUsd !== null;
  const hasModeledModel =
    mc !== null && mc.rateKnown && opts.model?.metered === false && modelMicroUsd !== null;
  const hasUnmeteredModel = mc !== null && !mc.rateKnown;
  const hasContainer = containerMicroUsd !== null;

  let basis: CostBasis;
  if (hasMeteredModel && hasContainer) basis = "mixed";
  else if (hasMeteredModel) basis = "metered";
  else if (hasContainer || hasModeledModel) basis = "modeled";
  else if (hasUnmeteredModel) basis = "unmetered";
  else basis = "modeled";

  return { totalMicroUsd: total, containerMicroUsd, modelMicroUsd, basis };
};

// --- Display helpers ------------------------------------------------------------

/** Micro-USD → USD (number). */
export const microUsdToUsd = (microUsd: number): number => microUsd / MICRO_USD_PER_USD;

/**
 * Format a micro-USD figure as a short USD string for tables. Picks a precision
 * that keeps sub-cent execution costs legible: 4 decimals under $1, 2 at/above.
 * `null` (unmetered) renders as the supplied placeholder.
 */
export const formatMicroUsd = (
  microUsd: number | null,
  placeholder = "—",
): string => {
  if (microUsd === null) return placeholder;
  const usd = microUsdToUsd(microUsd);
  if (usd === 0) return "$0";
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
};
