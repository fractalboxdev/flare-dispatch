// The deploy paths of FD-OPS-007 (specs/operability.md § Template and overlay): the deploy workflow, `fd deploy` on a
// workstation and the published deploy action. The workflow job and the composite action run step by step in bash,
// with `node`, `pnpm`, `git`, `wrangler` and `npx` replaced by recorders on `PATH` and each `uses:` step played by a
// stand-in, so a suite sees every command a path runs and every file it writes. The `fd deploy` argument a path passes
// then runs through the Operability service on a recording `DeployTarget`, which keeps what each Worker deploy received.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  APP_PERMISSIONS,
  DeployTarget,
  MERGE_GATE_CHECKS,
  placeholderOverlay,
  renderTemplate,
  type OverlayValues,
} from "../../src/index.ts";
import { makeOperability, repositoryRoot, V2_WORKERS } from "../../src/cli/index.ts";
import { accessStore } from "../../src/access-application.test-support.ts";

const ROOT = repositoryRoot(import.meta.dirname);
const SCRIPT = "packages/ops/scripts/fd-operability.ts";
const FD_DEPLOY = ["--experimental-strip-types", "--no-warnings", SCRIPT, "deploy", "--overlay"];
const SHA = "0123456789abcdef0123456789abcdef01234567";
const CONTROL_PLANE = V2_WORKERS.find((w) => w.worker === "control-plane")!;

/** An operator's overlay whose values differ from the placeholder overlay, so a render shows which overlay it read. */
const OVERLAY: OverlayValues = {
  ...placeholderOverlay,
  accountId: "a".repeat(32),
  hostnames: { dispatcher: "dispatch.acme.test", docs: "docs.acme.test" },
  alerts: { sink: "https://alerts.acme.test/hook" },
};
const OVERLAY_TEXT = JSON.stringify(OVERLAY, null, 2);

type Step = {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  shell?: string;
  "working-directory"?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
type Action = {
  inputs: Record<string, { required?: boolean; default?: string }>;
  runs: { using: string; steps: Step[] };
};
type Workflow = { jobs: Record<string, { steps: Step[] }> };

const action = parse(
  readFileSync(join(ROOT, "actions/deploy-dispatcher-action/action.yml"), "utf8"),
) as Action;
const deployWorkflow = parse(
  readFileSync(join(ROOT, ".github/workflows/v2-deploy.yml"), "utf8"),
) as Workflow;

/** A command a recorder on `PATH` ran: its name, the physical directory it ran in and its arguments. */
interface Ran {
  readonly command: string;
  readonly cwd: string;
  readonly args: readonly string[];
}

const RECORDED = ["node", "pnpm", "git", "wrangler", "npx"] as const;

let scratch: string;
beforeAll(() => {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  scratch = realpathSync(mkdtempSync(join(ROOT, ".tmp", "deploy-paths-")));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A fresh runner: a workspace, a temp dir, a home and the recorders, under the suite's scratch directory. */
const runner = (name: string) => {
  const base = join(scratch, name);
  const dirs = {
    workspace: join(base, "workspace"),
    temp: join(base, "temp"),
    home: join(base, "home"),
    bin: join(base, "bin"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const log = join(base, "commands.log");
  writeFileSync(log, "");
  for (const command of RECORDED) {
    const path = join(dirs.bin, command);
    writeFileSync(
      path,
      `#!/bin/sh\n{ printf '%s\\t%s' "${command}" "$(pwd -P)"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "${log}"\n`,
    );
    chmodSync(path, 0o755);
  }
  const ran = (): Ran[] =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => {
        const [command, cwd, ...args] = l.split("\t");
        return { command: command!, cwd: cwd!, args };
      });
  return { ...dirs, ran };
};
type Runner = ReturnType<typeof runner>;

/** Replaces each `${{ <expression> }}` with its value in `context`; an expression it does not hold is a test error. */
const evaluate = (text: string, context: ReadonlyMap<string, string>) =>
  text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_m, expression: string) => {
    const value = context.get(expression);
    if (value === undefined) throw new Error(`no value for \${{ ${expression} }}`);
    return value;
  });

/**
 * Runs the steps the way a GitHub-hosted runner does: in order, each `run:` in bash with its `env:` and
 * `working-directory`, `$GITHUB_OUTPUT` read back into `steps.<id>.outputs`, stopping at the first failure; a step under
 * `if: success()` runs only when every step before it passed. `uses` plays each `uses:` step.
 */
const runSteps = (
  steps: readonly Step[],
  r: Runner,
  values: Readonly<Record<string, string>>,
  uses: (step: Step, context: ReadonlyMap<string, string>) => void,
) => {
  const context = new Map(Object.entries(values));
  context.set("github.workspace", r.workspace);
  const results: { name: string; ok: boolean; stderr: string }[] = [];
  for (const [n, step] of steps.entries()) {
    const name = step.name ?? step.uses ?? `step ${n}`;
    const failedBefore = results.some((s) => !s.ok);
    if (step.if !== undefined && step.if !== "success()")
      throw new Error(`${name}: no evaluator for if: ${step.if}`);
    if (failedBefore) break;
    if (step.uses !== undefined) {
      uses(step, context);
      results.push({ name, ok: true, stderr: "" });
      continue;
    }
    const output = join(r.temp, `output-${n}`);
    writeFileSync(output, "");
    const env: Record<string, string> = {
      PATH: `${r.bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      HOME: r.home,
      RUNNER_TEMP: r.temp,
      GITHUB_WORKSPACE: r.workspace,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(r.temp, "summary.md"),
    };
    for (const [k, v] of Object.entries(step.env ?? {})) env[k] = evaluate(String(v), context);
    const cwd = join(r.workspace, evaluate(step["working-directory"] ?? ".", context));
    const run = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", evaluate(step.run ?? "", context)],
      { cwd, env, encoding: "utf8" },
    );
    results.push({ name, ok: run.status === 0, stderr: run.stderr });
    for (const line of readFileSync(output, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (step.id !== undefined && eq > 0)
        context.set(`steps.${step.id}.outputs.${line.slice(0, eq)}`, line.slice(eq + 1));
    }
  }
  return results;
};

/** A checkout of the repository at `dir`: every Worker template the deploy renders, and the root `wrangler.jsonc`. */
const checkout = (dir: string) => {
  for (const path of [...V2_WORKERS.map((w) => w.templatePath), "wrangler.jsonc"]) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    copyFileSync(join(ROOT, path), join(dir, path));
  }
};

/** Every file under `dir`, relative, with its bytes. */
const tree = (dir: string): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path);
      else out.set(path, readFileSync(join(dir, path), "utf8"));
    }
  };
  if (existsSync(dir)) walk("");
  return out;
};

/**
 * What each Worker deploy receives when `fd deploy` runs with `overlay`, on a target that records it. The deploy carries
 * the control plane alone: the committed documentation template still fails the template invariants of the drift check.
 */
const deployedBy = async (overlay: string) => {
  const values = JSON.parse(overlay) as OverlayValues;
  const received = new Map<string, string>();
  const target = () =>
    Layer.succeed(DeployTarget, {
      deployedSettings: () => Effect.succeed(null),
      lastRecord: () => Effect.succeed(null),
      appRegistration: Effect.succeed(APP_PERMISSIONS),
      requiredChecks: Effect.succeed([...MERGE_GATE_CHECKS, "flare-dispatch/check:ci"]),
      applyD1Migrations: () => Effect.succeed([]),
      deployWorker: (w) =>
        Effect.sync(() => {
          received.set(w.worker, w.text);
          return {
            worker: w.worker,
            version: "00000001",
            previousVersion: null,
            durableObjectMigrations: [],
          };
        }),
      probe: () => Effect.succeed(true),
      floorCanary: () => Effect.succeed({ status: "passed" as const, digest: "sha256:0" }),
      writeRecord: () => Effect.void,
      raiseAlarm: () => Effect.void,
      // The hostname application exists with the overlay's AUD tag, as on an account set up before its first deploy.
      ...accessStore([
        { id: "hostname", domain: values.hostnames["dispatcher"]!, aud: values.access.aud },
      ]),
    });
  const report = await Effect.runPromise(
    makeOperability({
      fail: (m) => new Error(m),
      root: ROOT,
      workers: [CONTROL_PLANE],
      target,
    }).deploy({
      overlay,
      dryRun: false,
    }),
  );
  return { report, received };
};

/** Each Worker's configuration as the one renderer produces it from its committed template and `overlay`. */
const rendered = (overlay: OverlayValues) =>
  new Map(
    [CONTROL_PLANE].map((w) => [
      w.worker,
      Effect.runSync(
        renderTemplate(w.worker, readFileSync(join(ROOT, w.templatePath), "utf8"), overlay),
      ),
    ]),
  );

/** The one `fd deploy` a path ran, with the overlay text its `@file` argument named. */
const fdDeployOf = (ran: readonly Ran[]) => {
  const deploys = ran.filter((c) => c.command === "node" && c.args.includes(SCRIPT));
  expect(deploys).toHaveLength(1);
  const [call] = deploys;
  expect(call!.args.slice(0, FD_DEPLOY.length)).toEqual(FD_DEPLOY);
  const file = call!.args[FD_DEPLOY.length]!;
  expect(file.startsWith("@")).toBe(true);
  return { call: call!, overlay: readFileSync(file.slice(1), "utf8") };
};

const writesConfig = /\bwrangler(?:\.[\w-]+)?\.(?:jsonc?|toml)\b/;

describe("every deploy path renders through the one renderer", () => {
  it("[FD-OPS-007] the published deploy action runs fd deploy with the operator's overlay and writes no Worker configuration of its own", async () => {
    const r = runner("action");
    const upstream = join(r.workspace, action.inputs["upstream-checkout-path"]!.default!);
    mkdirSync(join(r.workspace, "infra/flare-dispatch"), { recursive: true });
    writeFileSync(join(r.workspace, "infra/flare-dispatch/overlay.json"), OVERLAY_TEXT);
    // An operator's leftover whole-file overlay sits beside it; nothing may copy it over a template.
    writeFileSync(join(r.workspace, "infra/flare-dispatch/wrangler.jsonc"), '{ "name": "rogue" }');

    const inputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(action.inputs))
      if (v.default !== undefined) inputs[`inputs.${k}`] = v.default;
    Object.assign(inputs, {
      "inputs.upstream-ref": SHA,
      "inputs.overlay": "infra/flare-dispatch/overlay.json",
      "inputs.cloudflare-api-token": "cf-token",
      "inputs.github-app-private-key": "pem",
      "inputs.mameko-deploy-key": "deploy-key",
    });
    const played: string[] = [];
    let checkedOut = new Map<string, string>();
    const results = runSteps(action.runs.steps, r, inputs, (step, context) => {
      played.push(step.uses!);
      if (step.uses!.startsWith("actions/checkout@")) {
        expect(evaluate(step.with!["ref"]!, context)).toBe(SHA);
        checkout(join(r.workspace, evaluate(step.with!["path"]!, context)));
        checkedOut = tree(upstream);
      }
    });
    expect(results.filter((s) => !s.ok)).toEqual([]);
    expect(played.some((u) => u.startsWith("cloudflare/wrangler-action@"))).toBe(false);

    const ran = r.ran();
    // No path around `fd deploy`: no wrangler run of the action's own.
    expect(ran.filter((c) => c.command === "wrangler" || c.command === "npx")).toEqual([]);
    const { call, overlay } = fdDeployOf(ran);
    expect(call.cwd).toBe(upstream);
    expect(call.args.slice(FD_DEPLOY.length)).toEqual([
      `@${join(r.workspace, "infra/flare-dispatch/overlay.json")}`,
    ]);
    expect(overlay).toBe(OVERLAY_TEXT);
    // The checkout's templates are byte-identical after the action, and it gained no configuration file.
    const after = tree(upstream);
    expect([...after.keys()].filter((p) => writesConfig.test(p)).sort()).toEqual(
      [...checkedOut.keys()].filter((p) => writesConfig.test(p)).sort(),
    );
    for (const [path, bytes] of checkedOut) expect(after.get(path)).toBe(bytes);

    // What the action hands fd deploy reaches each Worker deploy as the renderer's output for the operator's overlay.
    const { report, received } = await deployedBy(overlay);
    expect(report.ok).toBe(true);
    expect(received).toEqual(rendered(OVERLAY));
    expect(received.get("control-plane")).toContain('"pattern": "dispatch.acme.test"');

    // `dry-run: true` runs the same command with `--dry-run`: decode, render and the drift check only.
    const dry = runner("action-dry");
    mkdirSync(join(dry.workspace, "infra"), { recursive: true });
    writeFileSync(join(dry.workspace, "infra/overlay.json"), OVERLAY_TEXT);
    const dryResults = runSteps(
      action.runs.steps,
      dry,
      {
        ...inputs,
        "inputs.overlay": "infra/overlay.json",
        "inputs.dry-run": "true",
      },
      (step, context) => {
        if (step.uses!.startsWith("actions/checkout@"))
          checkout(join(dry.workspace, evaluate(step.with!["path"]!, context)));
      },
    );
    expect(dryResults.filter((s) => !s.ok)).toEqual([]);
    expect(fdDeployOf(dry.ran()).call.args.slice(FD_DEPLOY.length)).toEqual([
      `@${join(dry.workspace, "infra/overlay.json")}`,
      "--dry-run",
    ]);
  }, 30_000);

  it("the published deploy action fails before checkout when the overlay file is missing", () => {
    const r = runner("action-missing");
    const inputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(action.inputs))
      if (v.default !== undefined) inputs[`inputs.${k}`] = v.default;
    Object.assign(inputs, {
      "inputs.upstream-ref": SHA,
      "inputs.overlay": "infra/flare-dispatch/overlay.json",
      "inputs.cloudflare-api-token": "cf-token",
      "inputs.github-app-private-key": "pem",
      "inputs.mameko-deploy-key": "deploy-key",
    });
    const played: string[] = [];
    const results = runSteps(action.runs.steps, r, inputs, (step) => void played.push(step.uses!));
    expect(results.at(-1)).toMatchObject({ ok: false });
    expect(results.at(-1)!.stderr).toContain("overlay missing");
    expect(played).toEqual([]);
    expect(r.ran()).toEqual([]);
  });

  it("[FD-OPS-007] the deploy workflow runs fd deploy with the overlay its secret holds, and nothing else deploys", async () => {
    const r = runner("workflow");
    checkout(r.workspace);
    const before = tree(r.workspace);
    const played: string[] = [];
    const results = runSteps(
      deployWorkflow.jobs["deploy"]!.steps,
      r,
      {
        "secrets.FD_OPERATOR_OVERLAY": OVERLAY_TEXT,
        "secrets.CLOUDFLARE_API_TOKEN": "cf-token",
        "secrets.GITHUB_APP_PRIVATE_KEY": "pem",
        "secrets.MAMEKO_DEPLOY_KEY": "deploy-key",
      },
      (step) => void played.push(step.uses!),
    );
    expect(results.filter((s) => !s.ok)).toEqual([]);
    expect(played.some((u) => u.startsWith("cloudflare/wrangler-action@"))).toBe(false);

    const ran = r.ran();
    expect(ran.filter((c) => c.command === "wrangler" || c.command === "npx")).toEqual([]);
    const { call, overlay } = fdDeployOf(ran);
    expect(call.cwd).toBe(r.workspace);
    expect(overlay).toBe(OVERLAY_TEXT);
    expect(tree(r.workspace)).toEqual(before);

    const { report, received } = await deployedBy(overlay);
    expect(report.ok).toBe(true);
    expect(received).toEqual(rendered(OVERLAY));
  }, 30_000);

  it("[FD-OPS-007] fd deploy on a workstation and the workflow's script build the same Operability service", () => {
    // `fd-deploy` on a workstation runs `fd`'s live layer; the workflow and the action run the ops script. Both build
    // the service from `makeOperability` with no target of their own, so both reach the live target and the renderer.
    const fdMain = readFileSync(join(ROOT, "packages/fd/src/main.ts"), "utf8");
    expect(fdMain).toMatch(
      /import \{ makeOperability \} from "@fractalboxdev\/flare-dispatch-ops\/cli";/,
    );
    expect(fdMain).toMatch(
      /Layer\.succeed\(Operability\)\(\s*makeOperability\(\{ fail: \(message\) => new OperabilityFailed\(\{ message \}\) \}\),?\s*\)/,
    );
    const script = readFileSync(join(ROOT, SCRIPT), "utf8");
    expect(script).toMatch(
      /const service = makeOperability\(\{ fail: \(message\) => new Error\(message\) \}\);/,
    );
    expect(script).toMatch(/service\.deploy\(\{ overlay, dryRun: opts\.has\("dry-run"\) \}\)/);
    const bin = readFileSync(join(ROOT, "packages/fd/bin/fd-deploy.mjs"), "utf8");
    expect(bin).toContain('import { main } from "../src/main.ts";');
    expect(bin).toContain('main("deploy");');
  });
});
