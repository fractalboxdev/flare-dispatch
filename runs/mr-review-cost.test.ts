// Unit tests for the PURE mr-review cost accounting (pricing table, CONFIG_KV
// override parsing, USD → neuron math, and the footer's honest degradation).

import { describe, expect, it } from "vitest";
import {
  costFooter,
  costFooterForUsage,
  costOf,
  DEFAULT_PRICING,
  formatUsd,
  parsePricingOverride,
  pricingKey,
  resolvePricing,
} from "./mr-review-cost";

describe("parsePricingOverride", () => {
  it("parses a well-formed `<in>,<out>` pair (with surrounding whitespace)", () => {
    expect(parsePricingOverride("0.66,1.0")).toEqual([0.66, 1.0]);
    expect(parsePricingOverride(" 0.045 , 0.38 ")).toEqual([0.045, 0.38]);
  });

  it("rejects malformed values → undefined (falls back to the built-in table)", () => {
    expect(parsePricingOverride(undefined)).toBeUndefined();
    expect(parsePricingOverride("")).toBeUndefined();
    expect(parsePricingOverride("0.66")).toBeUndefined(); // wrong arity
    expect(parsePricingOverride("0.66,1.0,extra")).toBeUndefined();
    expect(parsePricingOverride("cheap,dear")).toBeUndefined(); // non-numeric
    expect(parsePricingOverride("-1,2")).toBeUndefined(); // negative
  });

  it("a blank component means unset, never zero", () => {
    expect(parsePricingOverride("0.66,")).toBeUndefined();
    expect(parsePricingOverride(",1.0")).toBeUndefined();
    expect(parsePricingOverride(" , ")).toBeUndefined();
  });
});

describe("resolvePricing", () => {
  it("prefers the operator override over the built-in table", () => {
    expect(resolvePricing("@cf/qwen/qwen2.5-coder-32b-instruct", [9, 9])).toEqual([9, 9]);
  });
  it("falls back to the built-in table when no override", () => {
    expect(resolvePricing("@cf/qwen/qwen2.5-coder-32b-instruct", undefined)).toEqual(
      DEFAULT_PRICING["@cf/qwen/qwen2.5-coder-32b-instruct"],
    );
  });
  it("returns undefined for an unknown model with no override", () => {
    expect(resolvePricing("@cf/unknown/model", undefined)).toBeUndefined();
  });

  it("prices the gpt-oss bake-off candidates from the built-in table", () => {
    expect(resolvePricing("@cf/openai/gpt-oss-120b", undefined)).toEqual([0.35, 0.75]);
    expect(resolvePricing("@cf/openai/gpt-oss-20b", undefined)).toEqual([0.2, 0.3]);
  });
});

describe("costOf", () => {
  it("USD = tokens/1e6 · rate; neurons = usd / 0.000011 (rounded)", () => {
    // 14230 in @ $0.66/M + 1872 out @ $1.00/M = 0.0112638
    const { usd, neurons } = costOf({ inputTokens: 14230, outputTokens: 1872 }, [0.66, 1.0]);
    expect(usd).toBeCloseTo(0.0112638, 7);
    expect(neurons).toBe(1024); // 0.0112638 / 0.000011 ≈ 1023.98
  });
});

describe("pricingKey", () => {
  it("namespaces under pr-review.pricing.<model> (shared pr-review config)", () => {
    expect(pricingKey("@cf/qwen/qwen2.5-coder-32b-instruct")).toBe(
      "pr-review.pricing.@cf/qwen/qwen2.5-coder-32b-instruct",
    );
  });
});

describe("costFooter", () => {
  const usage = { inputTokens: 14230, outputTokens: 1872 };

  it("full line — model · tokens · neurons · USD (matches the spec example)", () => {
    expect(
      costFooter({
        model: "@cf/qwen/qwen2.5-coder-32b-instruct",
        usage,
        pricing: [0.66, 1.0],
      }),
    ).toBe(
      "⚙️ @cf/qwen/qwen2.5-coder-32b-instruct · 14,230 in + 1,872 out tokens · ~1,024 neurons · ≈$0.0113",
    );
  });

  it("known usage but NO price → token counts only (never invents a cost)", () => {
    expect(costFooter({ model: "@cf/unknown/model", usage, pricing: undefined })).toBe(
      "⚙️ @cf/unknown/model · 14,230 in + 1,872 out tokens",
    );
  });

  it("no usage at all → null (omit the footer entirely, never guess)", () => {
    expect(
      costFooter({ model: "@cf/any/model", usage: { inputTokens: 0, outputTokens: 0 }, pricing: [1, 1] }),
    ).toBeNull();
  });

  it("non-finite or negative token counts render `?` tokens, never a dollar figure", () => {
    expect(
      costFooter({ model: "m", usage: { inputTokens: Number.NaN, outputTokens: 10 }, pricing: [1, 1] }),
    ).toBe("⚙️ m · ? in + ? out tokens");
    expect(
      costFooter({ model: "m", usage: { inputTokens: 10, outputTokens: -1 }, pricing: [1, 1] }),
    ).toBe("⚙️ m · ? in + ? out tokens");
    expect(
      costFooter({ model: "m", usage: { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 0 }, pricing: undefined }),
    ).toBe("⚙️ m · ? in + ? out tokens");
  });

  it("an explicit `unknown: true` bucket renders `?` tokens even with clean numbers", () => {
    expect(
      costFooter({ model: "m", usage: { inputTokens: 10, outputTokens: 10, unknown: true }, pricing: [1, 1] }),
    ).toBe("⚙️ m · ? in + ? out tokens");
  });

  it("a sub-millidollar total renders `< $0.001` instead of `≈$0.0000`", () => {
    const line = costFooter({ model: "m", usage: { inputTokens: 10, outputTokens: 10 }, pricing: [0.045, 0.38] });
    expect(line).toContain("< $0.001");
    expect(line).not.toContain("$0.0000");
  });

  it("a side flagged individually missing renders `?` for just that side, no dollar figure", () => {
    expect(
      costFooter({
        model: "m",
        usage: { inputTokens: 0, outputTokens: 1872, inputUnknown: true },
        pricing: [1, 1],
      }),
    ).toBe("⚙️ m · ? in + 1,872 out tokens");
    expect(
      costFooter({
        model: "m",
        usage: { inputTokens: 14230, outputTokens: 0, outputUnknown: true },
        pricing: [1, 1],
      }),
    ).toBe("⚙️ m · 14,230 in + ? out tokens");
  });

  it("a missing side never invents a dollar figure, even with a known price", () => {
    const line = costFooter({
      model: "m",
      usage: { inputTokens: 1000, outputTokens: 0, outputUnknown: true },
      pricing: [1, 1],
    });
    expect(line).not.toContain("$");
    expect(line).not.toContain("neurons");
  });
});

describe("formatUsd", () => {
  it("renders a computed cost with the leading ≈", () => {
    expect(formatUsd(0.0112638)).toBe("≈$0.0113");
  });
  it("renders `$0` for an exact zero cost (genuinely free, not just tiny)", () => {
    expect(formatUsd(0)).toBe("$0");
  });
  it("renders `< $0.001` for a real but sub-millidollar cost", () => {
    expect(formatUsd(0.0000001)).toBe("< $0.001");
    expect(formatUsd(0.0009999)).toBe("< $0.001");
  });
  it("$0.001 itself is not sub-millidollar", () => {
    expect(formatUsd(0.001)).toBe("≈$0.0010");
  });
});

describe("costFooterForUsage", () => {
  it("prices each model's tokens at its own rate — a naive-seat model differs from the persona model", () => {
    const usage = {
      inputTokens: 20000,
      outputTokens: 3000,
      byModel: {
        "@cf/qwen/qwen2.5-coder-32b-instruct": { inputTokens: 14230, outputTokens: 1872, calls: 1 },
        "@cf/meta/llama-3.1-8b-instruct-fast": { inputTokens: 5770, outputTokens: 1128, calls: 3 },
      },
    };
    const out = costFooterForUsage(usage, (model) => resolvePricing(model, undefined));
    expect(out).toContain("⚙️ @cf/qwen/qwen2.5-coder-32b-instruct · 14,230 in + 1,872 out tokens");
    expect(out).toContain("⚙️ @cf/meta/llama-3.1-8b-instruct-fast · 5,770 in + 1,128 out tokens");
    // Two distinct lines, not one blended total.
    expect(out?.split("\n")).toHaveLength(2);
  });

  it("no metered models → null", () => {
    expect(costFooterForUsage({ inputTokens: 0, outputTokens: 0 }, () => undefined)).toBeNull();
  });

  it("every model's line degrading to null → null overall", () => {
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      byModel: { "m": { inputTokens: 0, outputTokens: 0, calls: 1 } },
    };
    expect(costFooterForUsage(usage, () => undefined)).toBeNull();
  });

  it("aggregate-only usage (no byModel breakdown) still renders a footer from the totals", () => {
    const out = costFooterForUsage({ inputTokens: 14230, outputTokens: 1872 }, () => undefined);
    expect(out).toBe("⚙️ 14,230 in + 1,872 out tokens");
  });

  it("aggregate-only usage marked unknown renders `?` tokens, no byModel needed", () => {
    const out = costFooterForUsage({ inputTokens: 0, outputTokens: 0, unknown: true }, () => undefined);
    expect(out).toBe("⚙️ ? in + ? out tokens");
  });

  it("aggregate-only usage with a missing input side renders `?` for that side only", () => {
    const out = costFooterForUsage({ inputTokens: 10, outputTokens: 1872, inputUnknown: true }, () => undefined);
    expect(out).toBe("⚙️ ? in + 1,872 out tokens");
  });

  it("aggregate-only usage with a missing output side renders `?` for that side only", () => {
    const out = costFooterForUsage({ inputTokens: 14230, outputTokens: 0, outputUnknown: true }, () => undefined);
    expect(out).toBe("⚙️ 14,230 in + ? out tokens");
  });
});
