import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ACCESS_BYPASS, accessApplications, bypassed } from "./access-application.ts";
import { MERGE_GATE_CHECKS } from "./drift.ts";

const ROOT = join(import.meta.dirname, "../../..");
type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string> };
type Job = { needs?: string | string[]; if?: string; steps?: Step[]; uses?: string };
type Workflow = {
  on: Record<string, unknown>;
  concurrency?: { group: string; "cancel-in-progress": unknown };
  jobs: Record<string, Job>;
};
const workflow = (name: string) =>
  parse(readFileSync(join(ROOT, ".github/workflows", name), "utf8")) as Workflow;
const deploy = workflow("v2-deploy.yml");
const ci = workflow("v2-ci.yml");
const nightly = workflow("v2-nightly.yml");
const stepIndex = (job: Job, match: (s: Step) => boolean) => (job.steps ?? []).findIndex(match);

describe("deploy workflow", () => {
  it("[FD-OPS-008] reads the overlay from one repository secret and fails before its first deploy step without it", () => {
    const job = deploy.jobs["deploy"]!;
    const read = stepIndex(job, (s) => s.name === "Read the operator overlay");
    const run = stepIndex(job, (s) => s.name === "fd deploy");
    expect(read).toBe(0);
    expect(run).toBeGreaterThan(read);
    const step = job.steps![read]!;
    expect(step.env).toEqual({ FD_OPERATOR_OVERLAY: "${{ secrets.FD_OPERATOR_OVERLAY }}" });
    expect(step.run).toContain('if [ -z "$FD_OPERATOR_OVERLAY" ]');
    expect(step.run).toContain("exit 1");
  });

  it("[FD-OPS-011] runs at most one deploy at a time and never cancels a started one", () => {
    expect(deploy.concurrency).toEqual({
      group: "flare-dispatch-v2-deploy",
      "cancel-in-progress": false,
    });
  });

  it("[FD-OPS-030] [FD-OPS-007] a push to the default branch runs the CI commands first, then fd deploy through the one renderer", () => {
    expect(deploy.on["push"]).toEqual({ branches: ["main"] });
    expect(deploy.jobs["ci"]!.uses).toBe("./.github/workflows/v2-ci.yml");
    expect(deploy.jobs["deploy"]!.needs).toBe("ci");
    expect(ci.on).toHaveProperty("workflow_call");
    const run = deploy.jobs["deploy"]!.steps!.find((s) => s.name === "fd deploy")!.run!;
    expect(run).toContain("packages/ops/scripts/fd-operability.ts deploy");
  });

  it("[FD-OPS-025] runs fd doctor every 24 h and raises drift when a check fails", () => {
    expect(deploy.on["schedule"]).toEqual([{ cron: "17 6 * * *" }]);
    const doctor = deploy.jobs["doctor"]!;
    expect(doctor.if).toBe("github.event_name == 'schedule'");
    expect(doctor.steps!.at(-1)!.run).toContain("doctor --overlay");
    expect(doctor.steps!.at(-1)!.run).toContain("--alarm-on-drift");
  });
});

describe("merge gate and nightly", () => {
  it("[FD-OPS-026] [FD-OPS-027] [FD-VER-023] CI runs a job per merge-gate check and a not-required fallback over all of them", () => {
    // The e2e-local cloud path needs the workerd stack and a fixture server, which no package ships yet.
    for (const check of MERGE_GATE_CHECKS.filter((c) => c !== "e2e-local"))
      expect(Object.keys(ci.jobs)).toContain(check);
    expect(ci.on).toHaveProperty("pull_request");
    const fallback = ci.jobs["fallback-ci"]!;
    expect(new Set(fallback.needs)).toEqual(
      new Set(Object.keys(ci.jobs).filter((j) => j !== "fallback-ci" && j !== "phase-gate")),
    );
    expect(MERGE_GATE_CHECKS as readonly string[]).not.toContain("fallback-ci");
  });

  it("[FD-OPS-031] CI renders every spec diagram and builds the documentation site", () => {
    const runs = ci.jobs["docs"]!.steps!.map((s) => s.run ?? "");
    expect(runs).toContain(
      "shopt -s globstar && node apps/docs/scripts/check-diagrams.mjs specs/**/*.md",
    );
    expect(runs).toContain("pnpm --filter @fractalboxdev/flare-dispatch-docs run build");
  });

  it("[FD-VER-020] [FD-VER-021] [FD-VER-024] nightly runs 1,000,000 traces and 10,000 seeds and proposes what fails", () => {
    const diff = nightly.jobs["diff"]!.steps!.map((s) => s.run ?? "").join("\n");
    expect(diff).toContain("harness.ts diff --traces 1000000");
    expect(diff).toContain(">> formal/regressions.jsonl");
    expect(diff).toContain("gh pr create");
    const sim = nightly.jobs["sim"]!.steps!.map((s) => s.run ?? "").join("\n");
    expect(sim).toContain("harness.ts sim --seeds 10000");
    expect(sim).toContain(">> test/sim/seeds.jsonl");
    expect(ci.jobs["diff"]!.steps!.at(-1)!.run).toContain("harness.ts diff --traces 10000");
    expect(ci.jobs["sim"]!.steps!.at(-1)!.run).toContain("harness.ts sim");
    expect(ci.jobs["replay"]!.steps!.at(-1)!.run).toContain("harness.ts replay");
  });

  it("[FD-VER-032] the conf job runs mameko's suite on the composed control plane", () => {
    expect(ci.jobs["conf"]!.steps!.at(-1)!.run).toBe(
      "pnpm --filter @fractalboxdev/flare-dispatch-conformance test",
    );
  });
});

describe("Access configuration", () => {
  it("[FD-OPS-088] bypasses Access on every surface whose identity is not the Access JWT alone", () => {
    expect(ACCESS_BYPASS.map((b) => b.surface)).toEqual([
      "webhook",
      "dispatch",
      "executor connect",
      "health",
      "well-known",
      "log",
      "artifact",
      "compile-cache",
      "model-gateway",
      "provenance",
    ]);
    for (const path of [
      "/v1/webhooks/github",
      "/v1/dispatch/check",
      "/v1/executors/connect",
      "/health",
      "/.well-known/openid-configuration",
      "/v1/executions/e1/logs/run.log",
      "/v1/artifacts/a1",
      "/v1/compile-cache/obj/abc",
      "/v1/model/completions",
      "/v1/provenance/statements/s1",
    ])
      expect(bypassed(path)).toBe(true);
    for (const path of [
      "/",
      "/v1/executions",
      "/v1/executions/e1",
      "/v1/ops/health",
      "/v1/spend",
      "/v1/github/install/new",
      "/mcp",
    ])
      expect(bypassed(path)).toBe(false);
  });

  it("[FD-OPS-088] the hostname sits behind Access for the overlay's identities, each bypass path with a bypass policy", () => {
    const apps = accessApplications("dispatch.example.com", ["ops@acme.com"]);
    expect(apps[0]).toMatchObject({
      domain: "dispatch.example.com",
      policies: [{ decision: "allow" }],
    });
    expect(apps.slice(1).every((a) => a.policies[0]!.decision === "bypass")).toBe(true);
    expect(apps.slice(1).map((a) => a.domain)).toContain("dispatch.example.com/v1/webhooks/github");
  });
});
