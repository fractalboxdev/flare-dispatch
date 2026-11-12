// The deploy suites of `V-DEPLOY` (specs/verification.md § Harness catalog) for the provider registry of
// specs/model-gateway.md: `fd deploy` and `fd doctor` over the committed templates, with the overlay's
// `models.registry` checked in the drift stage, on the fakes of `support.ts`.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  modelRegistryCheck,
  modelRegistryOf,
  placeholderOverlay,
  type OverlayValues,
} from "../../src/index.ts";
import { deploy, fd, isWrite, world } from "./support.ts";

type Entry = NonNullable<NonNullable<OverlayValues["models"]>["registry"]>[string];

const workersAi: Entry = {
  providerId: "workers-ai",
  routeKind: "workers-ai",
  serves: ["transform"],
  upstreamModel: "@cf/example/model",
  neuronsPerMTok: { input: 26_668, output: 204_805 },
  inputPriceMicroUsdPerMTok: 26_668 * 11,
  outputPriceMicroUsdPerMTok: 204_805 * 11,
};

const hosted = (routeKind: string): Entry => ({
  providerId: routeKind,
  routeKind,
  serves: ["judgment"],
  upstreamModel: `${routeKind}-model`,
  inputPriceMicroUsdPerMTok: 3_000_000,
  outputPriceMicroUsdPerMTok: 15_000_000,
});

const withRegistry = (registry: Record<string, Entry>) =>
  JSON.stringify({ ...placeholderOverlay, models: { registry } });

const doctor = (overlay: string) => Effect.runPromise(fd(world()).doctor(overlay));

describe("the deploy check over the overlay's provider registry", () => {
  it("[FD-MDL-020] accepts entries of workers-ai, bedrock and mameko's four built-in route kinds, and fails any other route kind before any write", async () => {
    const accepted = withRegistry({
      wa: workersAi,
      ...Object.fromEntries(
        [
          "bedrock",
          "openai-compatible",
          "anthropic-messages",
          "cloudflare-ai-gateway",
          "local",
        ].map((k) => [k, hosted(k)]),
      ),
    });
    const ok = await deploy(world(), accepted);
    expect(ok.ok).toBe(true);
    expect(ok.stages.find((s) => s.stage === "drift")).toMatchObject({ ok: true });

    const w = world();
    const refused = await deploy(w, withRegistry({ wa: workersAi, vertex: hosted("vertex") }));
    expect(refused.ok).toBe(false);
    expect(refused.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
    expect(refused.stages.at(-1)?.detail).toContain("models.registry.vertex");
    expect(refused.stages.at(-1)?.detail).toContain("route kind vertex is not registered");
    expect(refused.stages.at(-1)?.detail).not.toContain("models.registry.wa");
    expect(w.calls.filter(isWrite)).toEqual([]);

    const checked = await doctor(withRegistry({ vertex: hosted("vertex") }));
    expect(checked.ok).toBe(false);
    expect(checked.stages.at(-1)?.detail).toContain("models.registry.vertex");
  });

  it("[FD-MDL-020] the pull-request drift check passes the placeholder overlay's registry, one entry per registered route kind", () => {
    const entries = modelRegistryOf(placeholderOverlay);
    expect(entries.map((e) => e.routeKind).sort()).toEqual(["bedrock", "workers-ai"]);
    expect(modelRegistryCheck(entries)).toEqual([]);
  });

  it("[FD-MDL-022] fails a workers-ai entry that states no per-token rate derived from its Neurons price, before any write", async () => {
    const {
      inputPriceMicroUsdPerMTok: _i,
      outputPriceMicroUsdPerMTok: _o,
      ...unpriced
    } = workersAi;
    const { neuronsPerMTok: _n, ...noNeurons } = workersAi;
    const mispriced: Entry = { ...workersAi, inputPriceMicroUsdPerMTok: 1_000_000 };
    for (const [entry, reason] of [
      [unpriced, "no per-token rate derived from its Neurons price"],
      [noNeurons, "no per-token rate derived from its Neurons price"],
      [mispriced, "differs from its Neurons price"],
    ] as const) {
      const w = world();
      const report = await deploy(w, withRegistry({ wa: entry }));
      expect(report.ok).toBe(false);
      expect(report.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
      expect(report.stages.at(-1)?.detail).toContain("models.registry.wa");
      expect(report.stages.at(-1)?.detail).toContain(reason);
      expect(w.calls.filter(isWrite)).toEqual([]);
    }

    // A non-workers-ai entry with no price is the gateway's fallback rate, not a deploy failure.
    const {
      inputPriceMicroUsdPerMTok: _bi,
      outputPriceMicroUsdPerMTok: _bo,
      ...bedrock
    } = hosted("bedrock");
    expect((await deploy(world(), withRegistry({ wa: workersAi, b: bedrock }))).ok).toBe(true);

    const checked = await doctor(withRegistry({ wa: unpriced }));
    expect(checked.ok).toBe(false);
    expect(checked.stages.at(-1)?.detail).toContain("models.registry.wa");
  });
});
