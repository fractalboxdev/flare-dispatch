// The deploy suite of `V-DEPLOY` (specs/verification.md § Harness catalog) for the container floor canary
// (specs/operability.md FD-OPS-050): `fd deploy` over the committed control-plane template, on the live target over the
// fake account, runs the canary once the Workers are deployed and reports success only when the canary passes.
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { makeOperability } from "../../src/cli/index.ts";
import { DeployTarget, type CanaryResult, type RenderedWorker } from "../../src/index.ts";
import {
  CONTROL_PLANE,
  deploy,
  OVERLAY,
  RECORD,
  ROOT,
  targetOn,
  world,
  type World,
} from "./support.ts";

/** The live target on the fake account, with a floor canary that answers `answer` and records what it was given. */
const withCanary = (w: World, answer: CanaryResult, seen: (readonly RenderedWorker[])[]) =>
  makeOperability({
    fail: (message) => new Error(message),
    root: ROOT,
    workers: [CONTROL_PLANE],
    target: (overlay) => {
      const service = Effect.runSync(
        Effect.provide(Effect.flatMap(DeployTarget, Effect.succeed), targetOn(w, "live")(overlay)),
      );
      return Layer.succeed(DeployTarget, {
        ...service,
        floorCanary: (rendered) =>
          Effect.sync(() => {
            w.calls.push("floor-canary");
            seen.push(rendered);
            return answer;
          }),
      });
    },
  });

describe("fd deploy and the container floor canary", () => {
  it("[FD-OPS-050] runs the canary once, after the Workers are deployed, on the rendered Container classes, and reports success only when it passes", async () => {
    const w = world();
    const seen: (readonly RenderedWorker[])[] = [];
    const report = await Effect.runPromise(
      withCanary(w, { status: "passed", digest: "sha256:1" }, seen).deploy({
        overlay: OVERLAY,
        dryRun: false,
      }),
    );
    expect(report.ok).toBe(true);
    expect(w.calls.filter((c) => c === "floor-canary")).toHaveLength(1);
    const deployedAt = w.calls.findIndex((c) => c.startsWith("wrangler deploy"));
    expect(deployedAt).toBeGreaterThanOrEqual(0);
    expect(w.calls.indexOf("floor-canary")).toBeGreaterThan(deployedAt);
    // The canary gets the rendered control plane, whose Container classes name the image it runs on.
    const containers = seen[0]!.find((r) => r.worker === "control-plane")!.config["containers"];
    expect(Array.isArray(containers) && containers.length > 0).toBe(true);
    expect(w.objects.has(RECORD)).toBe(true);

    // A canary that fails keeps the deploy from reporting success, pages and stores no record.
    const failing = world();
    const failed = await Effect.runPromise(
      withCanary(failing, { status: "failed", detail: "canary exited 1" }, []).deploy({
        overlay: OVERLAY,
        dryRun: false,
      }),
    );
    expect(failed.ok).toBe(false);
    expect(failed.stages.at(-1)).toMatchObject({ stage: "probes", ok: false });
    expect(failed.stages.at(-1)!.detail).toContain("floor-canary: canary exited 1");
    expect(failing.calls.filter((c) => c === "floor-canary")).toHaveLength(1);
    expect(failing.alarms).toEqual([
      expect.objectContaining({ alarm: "deploy-probe-failed", severity: "page", state: "raised" }),
    ]);
    expect(failing.objects.has(RECORD)).toBe(false);
  });

  it("[FD-OPS-050] the live target's canary does not pass while the coordinator exposes none, so a deploy with Container classes never reports success", async () => {
    const w = world();
    const report = await deploy(w, OVERLAY, { canary: "live" });
    expect(report.ok).toBe(false);
    expect(w.calls.some((c) => c.startsWith("wrangler deploy"))).toBe(true);
    expect(report.stages.at(-1)!.detail).toContain("floor-canary:");
    expect(w.objects.has(RECORD)).toBe(false);
  });
});
