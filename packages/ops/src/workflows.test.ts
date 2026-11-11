import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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

/** A GitHub Actions path filter or a vitest glob as a regular expression over a repo-relative path. */
const GLOB_TOKENS: Record<string, string> = {
  "**/": "(?:.*/)?",
  "**": ".*",
  "*": "[^/]*",
  "?": "[^/]",
};
const globRegExp = (glob: string) =>
  new RegExp(
    `^${glob
      .split(/(\*\*\/|\*\*|\*|\?)/)
      .map((part) => GLOB_TOKENS[part] ?? part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
      .join("")}$`,
  );
const matchesAny = (globs: readonly string[], path: string) =>
  globs.some((g) => globRegExp(g).test(path));

type PackageJson = {
  name: string;
  exports?: Record<string, string>;
  scripts?: Record<string, string>;
};
const readJson = (path: string) =>
  JSON.parse(readFileSync(join(ROOT, path), "utf8")) as PackageJson;
const workspacePackages = new Map(
  readdirSync(join(ROOT, "packages"))
    .filter((d) => existsSync(join(ROOT, "packages", d, "package.json")))
    .map((d) => [readJson(`packages/${d}/package.json`).name, `packages/${d}`] as const),
);

/**
 * Every repo file the dispatch action runs: its `action.yml`, the lockfile its install step reads, and the transitive
 * closure of `main.ts` over relative and workspace-package imports, with each reached package's `package.json`.
 */
const dispatchActionFiles = () => {
  const files = new Set(["packages/fd/action/action.yml", "pnpm-lock.yaml"]);
  const queue = ["packages/fd/src/action/main.ts"];
  const resolve = (from: string, spec: string): string | undefined => {
    if (spec.startsWith(".")) return relative(ROOT, join(ROOT, dirname(from), spec));
    const pkg = [...workspacePackages.keys()].find((n) => spec === n || spec.startsWith(`${n}/`));
    if (pkg === undefined) return undefined;
    const dir = workspacePackages.get(pkg)!;
    files.add(`${dir}/package.json`);
    const target = readJson(`${dir}/package.json`).exports?.[`.${spec.slice(pkg.length)}`];
    if (target === undefined) throw new Error(`${spec} is not an export of ${pkg}`);
    return join(dir, target);
  };
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const [, spec] of source.matchAll(/\b(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
      const target = resolve(file, spec!);
      if (target !== undefined) queue.push(target);
    }
  }
  return [...files].sort();
};
const vitestInclude = async (dir: string) =>
  (
    (await import(join(ROOT, dir, "vitest.config.ts"))) as {
      default: { test: { include: string[] } };
    }
  ).default.test.include;

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
    for (const check of MERGE_GATE_CHECKS) expect(Object.keys(ci.jobs)).toContain(check);
    expect(ci.on).toHaveProperty("pull_request");
    const fallback = ci.jobs["fallback-ci"]!;
    expect(new Set(fallback.needs)).toEqual(
      new Set(Object.keys(ci.jobs).filter((j) => j !== "fallback-ci" && j !== "phase-gate")),
    );
    expect(MERGE_GATE_CHECKS as readonly string[]).not.toContain("fallback-ci");
  });

  it("[FD-VER-028] [FD-VER-029] the phase-gate job fetches the control plane's records into the file the gate reads", () => {
    const job = ci.jobs["phase-gate"]!;
    const fetchAt = stepIndex(job, (s) => (s.run ?? "").includes("--fetch"));
    const gateAt = stepIndex(job, (s) => s.name === "phase-gate");
    expect(fetchAt).toBeGreaterThanOrEqual(0);
    expect(fetchAt).toBeLessThan(gateAt);
    const fetchStep = job.steps![fetchAt]!;
    expect(fetchStep.run).toContain(
      'phase-gate.ts --base "$BASE" --fetch --records .tmp/phase-gate-records.json',
    );
    expect(Object.keys(fetchStep.env ?? {}).sort()).toEqual([
      "BASE",
      "FD_ACCESS_CLIENT_ID",
      "FD_ACCESS_CLIENT_SECRET",
      "FD_OPERATOR_OVERLAY",
    ]);
    // The overlay is the one the deploy reads, so the records come from the control plane it targets.
    expect(fetchStep.env!["FD_OPERATOR_OVERLAY"]).toBe("${{ secrets.FD_OPERATOR_OVERLAY }}");
    expect(job.steps![gateAt]!.run).toContain("--records .tmp/phase-gate-records.json");
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

  it("the e2e-local job runs every suite under the control plane's test/e2e-local on every pull request", async () => {
    const job = ci.jobs["e2e-local"]!;
    expect(job.if).toBeUndefined();
    expect(job.steps!.at(-1)!.run).toContain(
      "pnpm --filter @fractalboxdev/flare-dispatch-control-plane run test:e2e-local",
    );
    const app = readJson("apps/control-plane/package.json");
    expect(app.scripts?.["test:e2e-local"]).toBe("vitest run --config vitest.e2e.config.ts");
    const e2e = (
      (await import(join(ROOT, "apps/control-plane/vitest.e2e.config.ts"))) as {
        default: { test: { include: string[] } };
      }
    ).default.test.include;
    expect(matchesAny(e2e, "test/e2e-local/api.test.ts")).toBe(true);
    // `pnpm test` leaves the stack to this job.
    const unit = (
      (await import(join(ROOT, "apps/control-plane/vitest.config.ts"))) as {
        default: { test: { exclude: string[] } };
      }
    ).default.test.exclude;
    expect(matchesAny(unit, "test/e2e-local/api.test.ts")).toBe(true);
  });

  it("[FD-VER-032] the conf job runs mameko's suite on the composed control plane", () => {
    expect(ci.jobs["conf"]!.steps!.at(-1)!.run).toBe(
      "pnpm --filter @fractalboxdev/flare-dispatch-conformance test",
    );
  });
});

describe("dispatch action and upgrade gate", () => {
  const fdAction = workflow("fd-action.yml");

  it("[FD-IFC-062] runs the dispatch action's test suite on every pull request that changes a file the action runs", async () => {
    expect(Object.keys(fdAction.on)).toEqual(["pull_request"]);
    const trigger = fdAction.on["pull_request"] as Record<string, unknown>;
    expect(Object.keys(trigger)).toEqual(["paths"]);
    const paths = trigger["paths"] as string[];

    const files = dispatchActionFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        "packages/fd/src/action/run.ts",
        "packages/fd/src/client.ts",
        "packages/api/src/declaration.ts",
        "packages/api/package.json",
      ]),
    );
    expect(files.filter((f) => !matchesAny(paths, f))).toEqual([]);
    expect(matchesAny(paths, "packages/fd/src/action/run.test.ts")).toBe(true);
    expect(matchesAny(paths, ".github/workflows/fd-action.yml")).toBe(true);

    const job = fdAction.jobs["test"]!;
    expect(job.if).toBeUndefined();
    expect(job.steps!.at(-1)!.run).toBe("pnpm --filter @fractalboxdev/flare-dispatch-fd test");
    expect(workspacePackages.get("@fractalboxdev/flare-dispatch-fd")).toBe("packages/fd");
    expect(readJson("packages/fd/package.json").scripts?.["test"]).toBe("vitest run");
    expect(matchesAny(await vitestInclude("packages/fd"), "src/action/run.test.ts")).toBe(true);
  });

  it("[FD-IFC-082] every pull request, an effect version change among them, must pass the HTTP API, fd-<subcommand> and MCP suites over the real effect modules", async () => {
    expect(ci.on["pull_request"] ?? {}).toEqual({});
    const unit = ci.jobs["unit"]!;
    expect(unit.if).toBeUndefined();
    expect(unit.steps!.at(-1)!.run).toBe("pnpm test");
    expect(MERGE_GATE_CHECKS as readonly string[]).toContain("unit");
    expect(readJson("package.json").scripts?.["test"]).toMatch(/^vitest run\b/);

    const projects = ((await import(join(ROOT, "vitest.workspace.ts"))) as { default: string[] })
      .default;
    const suites = {
      "packages/api": ["src/router.test.ts", "src/worker.test.ts", "src/mcp/server.test.ts"],
      "packages/fd": ["src/commands.test.ts", "src/mcp-shim.test.ts"],
    };
    for (const [dir, tests] of Object.entries(suites)) {
      expect(matchesAny(projects, dir)).toBe(true);
      const include = await vitestInclude(dir);
      for (const test of tests) {
        expect(existsSync(join(ROOT, dir, test))).toBe(true);
        expect(matchesAny(include, test)).toBe(true);
      }
    }

    // Each surface is built on the unstable module it names, and no suite replaces an effect module with a mock.
    const imports = (path: string) => readFileSync(join(ROOT, path), "utf8");
    expect(imports("packages/api/src/declaration.ts")).toContain('from "effect/http-api"');
    expect(imports("packages/fd/src/commands.ts")).toContain('from "effect/cli"');
    expect(imports("packages/api/src/mcp/server.ts")).toContain('from "effect/ai"');
    const testFiles = Object.keys(suites).flatMap((dir) =>
      (readdirSync(join(ROOT, dir, "src"), { recursive: true }) as string[])
        .filter((f) => f.endsWith(".test.ts"))
        .map((f) => join(dir, "src", f)),
    );
    expect(testFiles.length).toBeGreaterThan(5);
    expect(testFiles.filter((f) => /vi\.(?:do)?[mM]ock\(\s*["']effect/.test(imports(f)))).toEqual(
      [],
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
      "log aggregate",
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
      "/v1/executions/e1/logs",
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
      policies: [
        { decision: "allow", include: [{ email: { email: "ops@acme.com" } }] },
        { decision: "non_identity", include: [{ any_valid_service_token: {} }] },
      ],
    });
    expect(apps.slice(1).every((a) => a.policies[0]!.decision === "bypass")).toBe(true);
    expect(apps.slice(1).map((a) => a.domain)).toContain("dispatch.example.com/v1/webhooks/github");
  });
});
