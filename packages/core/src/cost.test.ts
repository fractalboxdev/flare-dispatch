// Cost-engine unit tests — pins the rate card to specs/06-cost.md's worked
// numbers and exercises the metered-vs-modeled basis logic.
//
// These constant pins are also the drift latch the docs benchmark generator is
// held to: `scripts/emit-benchmarks.mjs` restates the rate card in plain JS to
// stay bare-node runnable, and the generator's `--check` mode + the rate-card
// assertion in the docs build keep that restatement honest (the same shape as
// `signals.ts` ↔ `emit-signals-schema.mjs`). If a number here changes, the
// committed `apps/docs/src/data/benchmarks.json` must be regenerated.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTAINER_GIB_MICRO_USD_PER_SEC,
  CONTAINER_VCPU_MICRO_USD_PER_SEC,
  INSTANCE_SPECS,
  MICRO_USD_PER_USD,
  containerCostMicroUsd,
  estimateExecutionCost,
  formatMicroUsd,
  microUsdToUsd,
  modelCost,
  modelRate,
} from "./cost.js";

describe("rate card (pinned to specs/06-cost.md)", () => {
  it("standard-2 is 1 vCPU / 6 GiB", () => {
    expect(INSTANCE_SPECS["standard-2"]).toEqual({ vcpu: 1, gib: 6 });
  });

  it("basic is 1/4 vCPU / 1 GiB and standard-3 is 2 vCPU / 8 GiB", () => {
    expect(INSTANCE_SPECS.basic).toEqual({ vcpu: 1 / 4, gib: 1 });
    expect(INSTANCE_SPECS["standard-3"]).toEqual({ vcpu: 2, gib: 8 });
  });

  it("container rates are $0.000020/vCPU-s and $0.0000025/GiB-s in micro-USD", () => {
    expect(CONTAINER_VCPU_MICRO_USD_PER_SEC).toBe(20);
    expect(CONTAINER_GIB_MICRO_USD_PER_SEC).toBe(2.5);
    expect(MICRO_USD_PER_USD).toBe(1_000_000);
  });
});

describe("containerCostMicroUsd — spec-06 per-execution anatomy", () => {
  it("standard-2 for an 8-minute run ≈ $0.0168 (the spec's ~$0.017 example)", () => {
    // specs/06-cost.md § Per-execution cost anatomy: a standard-2 (1 vCPU,
    // 6 GiB) running 8 min (480 s) = ~$0.0096 vCPU + ~$0.0072 mem ≈ $0.0168.
    const micro = containerCostMicroUsd({ instance: "standard-2", activeSeconds: 480 });
    expect(micro).toBe(16_800);
    expect(microUsdToUsd(micro)).toBeCloseTo(0.0168, 6);
  });

  it("scales linearly with active seconds", () => {
    const a = containerCostMicroUsd({ instance: "standard-2", activeSeconds: 60 });
    const b = containerCostMicroUsd({ instance: "standard-2", activeSeconds: 120 });
    expect(b).toBe(a * 2);
  });

  it("a basic lint container is far cheaper than standard-2", () => {
    const basic = containerCostMicroUsd({ instance: "basic", activeSeconds: 25 });
    const std = containerCostMicroUsd({ instance: "standard-2", activeSeconds: 25 });
    expect(basic).toBeLessThan(std);
  });
});

describe("modelRate — backend-prefixed id resolution", () => {
  it("resolves Claude families from prefixed ids", () => {
    expect(modelRate("anthropic/claude-sonnet-4-6")).toMatchObject({
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 15,
    });
    expect(modelRate("bedrock/us.anthropic.claude-opus-4-6-v1")).toMatchObject({
      inputPerMTokUsd: 5,
      outputPerMTokUsd: 25,
    });
    expect(modelRate("anthropic/claude-haiku-4-5")).toMatchObject({
      inputPerMTokUsd: 1,
      outputPerMTokUsd: 5,
    });
  });

  it("hosted DeepSeek gets the approximate reasoner rate", () => {
    expect(modelRate("deepseek/deepseek-reasoner")).toMatchObject({
      inputPerMTokUsd: 0.55,
      outputPerMTokUsd: 2.19,
    });
  });

  it("Workers AI catalog (@cf/…) is UNMETERED — even a catalog distill named deepseek", () => {
    expect(modelRate("@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBeNull();
    // The @cf check MUST precede the deepseek substring match.
    expect(modelRate("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b")).toBeNull();
  });
});

describe("modelCost — tokens × rate", () => {
  it("opus: 1000 in + 500 out = 17500 µ$ ($0.0175)", () => {
    // 1000 × $5/1M + 500 × $25/1M = $0.005 + $0.0125 = $0.0175.
    const mc = modelCost({
      model: "anthropic/claude-opus-4-6",
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(mc.rateKnown).toBe(true);
    expect(mc.microUsd).toBe(17_500);
  });

  it("catalog model: microUsd is null but tokens are retained", () => {
    const mc = modelCost({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      inputTokens: 4000,
      outputTokens: 800,
    });
    expect(mc.microUsd).toBeNull();
    expect(mc.rateKnown).toBe(false);
    expect(mc.inputTokens).toBe(4000);
    expect(mc.outputTokens).toBe(800);
  });
});

describe("estimateExecutionCost — honesty basis", () => {
  it("metered model tokens + modeled container → mixed (the pr-review shape)", () => {
    const cost = estimateExecutionCost({
      container: { instance: "standard-2", activeSeconds: 10 },
      model: {
        model: "anthropic/claude-sonnet-4-6",
        inputTokens: 20_000,
        outputTokens: 2_000,
        metered: true,
      },
    });
    expect(cost.basis).toBe("mixed");
    expect(cost.modelMicroUsd).toBe(20_000 * 3 + 2_000 * 15); // 90_000
    expect(cost.containerMicroUsd).toBeGreaterThan(0);
    expect(cost.totalMicroUsd).toBe(
      (cost.modelMicroUsd ?? 0) + (cost.containerMicroUsd ?? 0),
    );
  });

  it("container only → modeled (the offload-test shape)", () => {
    const cost = estimateExecutionCost({
      container: { instance: "standard-2", activeSeconds: 480 },
    });
    expect(cost.basis).toBe("modeled");
    expect(cost.modelMicroUsd).toBeNull();
    expect(cost.totalMicroUsd).toBe(16_800);
  });

  it("metered model with no container → metered", () => {
    const cost = estimateExecutionCost({
      model: {
        model: "anthropic/claude-opus-4-6",
        inputTokens: 1000,
        outputTokens: 0,
        metered: true,
      },
    });
    expect(cost.basis).toBe("metered");
  });

  it("estimated tokens (docs benchmark) → modeled, not metered", () => {
    const cost = estimateExecutionCost({
      model: {
        model: "anthropic/claude-sonnet-4-6",
        inputTokens: 30_000,
        outputTokens: 3_000,
        metered: false,
      },
    });
    expect(cost.basis).toBe("modeled");
    expect(cost.modelMicroUsd).toBe(30_000 * 3 + 3_000 * 15);
  });

  it("a catalog model with no container → unmetered", () => {
    const cost = estimateExecutionCost({
      model: {
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        inputTokens: 5000,
        outputTokens: 900,
        metered: true,
      },
    });
    expect(cost.basis).toBe("unmetered");
    expect(cost.modelMicroUsd).toBeNull();
    expect(cost.totalMicroUsd).toBe(0);
  });
});

describe("docs benchmark rate-card mirror (drift latch)", () => {
  // scripts/emit-benchmarks.mjs hand-mirrors the rate card to stay bare-node
  // runnable; this latch fails CI if the committed JSON's `rateCard` diverges
  // from the exported TS constants (the signals.ts ↔ emit-signals-schema.mjs
  // pattern). On failure: re-run `node scripts/emit-benchmarks.mjs`.
  const HERE = dirname(fileURLToPath(import.meta.url));
  const benchmarks = JSON.parse(
    readFileSync(
      resolve(HERE, "../../../apps/docs/src/data/benchmarks.json"),
      "utf8",
    ),
  ) as {
    rateCard: {
      vcpuMicroUsdPerSec: number;
      gibMicroUsdPerSec: number;
      instances: Record<string, { vcpu: number; gib: number }>;
      models: Record<string, { inputPerMTokUsd: number; outputPerMTokUsd: number }>;
    };
  };

  it("container rates match the exported constants", () => {
    expect(benchmarks.rateCard.vcpuMicroUsdPerSec).toBe(CONTAINER_VCPU_MICRO_USD_PER_SEC);
    expect(benchmarks.rateCard.gibMicroUsdPerSec).toBe(CONTAINER_GIB_MICRO_USD_PER_SEC);
  });

  it("instance specs match INSTANCE_SPECS", () => {
    expect(benchmarks.rateCard.instances).toEqual(INSTANCE_SPECS);
  });

  it("model rates match modelRate() for each family", () => {
    // Compare only the per-token rates (the JSON omits the `source` footnote).
    const rate = (id: string) => {
      const r = modelRate(id)!;
      return { inputPerMTokUsd: r.inputPerMTokUsd, outputPerMTokUsd: r.outputPerMTokUsd };
    };
    const { opus, sonnet, haiku, deepseek } = benchmarks.rateCard.models;
    expect(opus).toEqual(rate("anthropic/claude-opus-4-6"));
    expect(sonnet).toEqual(rate("anthropic/claude-sonnet-4-6"));
    expect(haiku).toEqual(rate("anthropic/claude-haiku-4-5"));
    expect(deepseek).toEqual(rate("deepseek/deepseek-reasoner"));
  });
});

describe("formatMicroUsd", () => {
  it("renders sub-cent figures at 4 decimals, dollars at 2", () => {
    expect(formatMicroUsd(16_800)).toBe("$0.0168");
    expect(formatMicroUsd(1_500_000)).toBe("$1.50");
    expect(formatMicroUsd(0)).toBe("$0");
  });

  it("renders null (unmetered) as the placeholder", () => {
    expect(formatMicroUsd(null)).toBe("—");
    expect(formatMicroUsd(null, "n/a")).toBe("n/a");
  });
});
