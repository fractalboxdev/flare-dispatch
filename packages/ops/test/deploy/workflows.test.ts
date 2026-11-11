// The deploy paths of FD-OPS-007 (specs/operability.md § Template and overlay): the deploy workflow, `fd deploy` on a
// workstation and the published deploy action. The workflow job and the composite action run step by step in bash,
// with `node`, `pnpm`, `git`, `wrangler` and `npx` replaced by recorders on `PATH` and each `uses:` step played by a
// stand-in, so a suite sees every command a path runs and every file it writes. The `fd deploy` argument a path passes
// then runs through the Operability service on a recording `DeployTarget`, which keeps what each Worker deploy received.
//
// The deploy workflow's own requirements (FD-OPS-008, FD-OPS-011, FD-OPS-025, FD-OPS-030) and the CI jobs the deploy and
// the ruleset rest on (FD-OPS-027, FD-OPS-031, FD-VER-023, FD-VER-033) run the same way: GitHub's job selection,
// `needs` and concurrency rules over the committed workflows, the selected jobs' steps in bash, and a job whose real
// command is cheap enough (the diagram check, the documentation build, the reference-profile comparison) on a copy of
// the repository a suite can break.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildProfile,
  diffJson,
  projectForReference,
  referenceProfile,
} from "@fractalboxdev/flare-dispatch-profile";
import {
  APP_PERMISSIONS,
  DeployTarget,
  MERGE_GATE_CHECKS,
  placeholderOverlay,
  renderTemplate,
  rulesetCheck,
  type OverlayValues,
} from "../../src/index.ts";
import {
  makeOperability,
  operabilityCommand,
  repositoryRoot,
  V2_WORKERS,
  type WorkerSpec,
} from "../../src/cli/index.ts";
import { accessStore } from "../../src/access-application.test-support.ts";
import {
  deploy as deployOn,
  fd,
  isWrite,
  OVERLAY as PLACEHOLDER_OVERLAY,
  SCRIPT as CONTROL_PLANE_SCRIPT,
  since,
  world,
} from "./support.ts";

const ROOT = repositoryRoot(import.meta.dirname);
const SCRIPT = "packages/ops/scripts/fd-operability.ts";
const FD_DEPLOY = ["--experimental-strip-types", "--no-warnings", SCRIPT, "deploy", "--overlay"];
const SHA = "0123456789abcdef0123456789abcdef01234567";

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
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  uses?: string;
  steps?: Step[];
  concurrency?: unknown;
};
type Workflow = {
  name: string;
  on: Record<string, { branches?: string[] } | null>;
  env?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean | string };
  jobs: Record<string, Job>;
};

const action = parse(
  readFileSync(join(ROOT, "actions/deploy-dispatcher-action/action.yml"), "utf8"),
) as Action;
const workflowFile = (path: string) =>
  parse(readFileSync(join(ROOT, path.replace(/^\.\//, "")), "utf8")) as Workflow;
const deployWorkflow = workflowFile(".github/workflows/v2-deploy.yml");
const ciWorkflow = workflowFile(".github/workflows/v2-ci.yml");

/** A command a recorder on `PATH` ran: its name, the physical directory it ran in and its arguments. */
interface Ran {
  readonly command: string;
  readonly cwd: string;
  readonly args: readonly string[];
}

const RECORDED = ["node", "pnpm", "git", "wrangler", "npx"] as const;

/** A bash that runs a `run:` step as the hosted runner's bash 5 does: `shopt -s globstar` needs bash 4 or later. */
const BASH =
  ["bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash"].find(
    (b) => spawnSync(b, ["-c", "shopt -s globstar"]).status === 0,
  ) ?? "bash";

let scratch: string;
beforeAll(() => {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  scratch = realpathSync(mkdtempSync(join(ROOT, ".tmp", "deploy-paths-")));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * A fresh runner: a workspace, a temp dir, a home and the recorders of `recorded`, under the suite's scratch directory.
 * A command left out of `recorded` runs for real.
 */
const runner = (name: string, recorded: readonly string[] = RECORDED) => {
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
  for (const command of recorded) {
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
  /**
   * Environment under each step's own `env:`: the workflow's `env:`, and what replaces the runner's own, such as the
   * real `HOME` a real `pnpm` reads its install from.
   */
  base: Readonly<Record<string, string>> = {},
) => {
  const context = new Map(Object.entries(values));
  context.set("github.workspace", r.workspace);
  const results: { name: string; ok: boolean; stderr: string; output: string }[] = [];
  for (const [n, step] of steps.entries()) {
    const name = step.name ?? step.uses ?? `step ${n}`;
    const failedBefore = results.some((s) => !s.ok);
    if (step.if !== undefined && step.if !== "success()")
      throw new Error(`${name}: no evaluator for if: ${step.if}`);
    if (failedBefore) break;
    if (step.uses !== undefined) {
      uses(step, context);
      results.push({ name, ok: true, stderr: "", output: "" });
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
      ...base,
    };
    for (const [k, v] of Object.entries(step.env ?? {})) env[k] = evaluate(String(v), context);
    const cwd = join(r.workspace, evaluate(step["working-directory"] ?? ".", context));
    const run = spawnSync(
      BASH,
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", evaluate(step.run ?? "", context)],
      { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    results.push({
      name,
      ok: run.status === 0,
      stderr: run.stderr,
      output: `${run.stdout}${run.stderr}${run.error === undefined ? "" : String(run.error)}`,
    });
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
 * What each Worker deploy receives when the ops script runs with `argv` (its arguments after the script path), on a
 * target that records it. The deploy carries the control plane alone: the committed documentation template still fails
 * the template invariants of the drift check.
 */
const deployedBy = async (argv: readonly string[]) => {
  const named = argv[argv.indexOf("--overlay") + 1] ?? "";
  const values = JSON.parse(
    named.startsWith("@") ? readFileSync(named.slice(1), "utf8") : named,
  ) as OverlayValues;
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
  const service = makeOperability({
    fail: (m) => new Error(m),
    root: ROOT,
    workers: builtWorkers(),
    target,
  });
  const report = await Effect.runPromise(operabilityCommand(service, argv, (m) => new Error(m)));
  return { report, received };
};

/**
 * The Workers of the deploy with the docs Worker's committed template copied beside a site build, as the deploy
 * workflow's build step leaves it: `fd deploy` stops at its drift stage without one.
 */
const builtWorkers = (): readonly WorkerSpec[] => {
  const app = join(scratch, "docs-built");
  mkdirSync(join(app, "dist"), { recursive: true });
  return V2_WORKERS.map((w) => {
    if (w.worker !== "docs") return w;
    copyFileSync(join(ROOT, w.templatePath), join(app, "wrangler.jsonc"));
    return { ...w, templatePath: relative(ROOT, join(app, "wrangler.jsonc")) };
  });
};

/** Each Worker's configuration as the one renderer produces it from its committed template and `overlay`. */
const rendered = (overlay: OverlayValues) =>
  new Map(
    V2_WORKERS.map((w) => [
      w.worker,
      Effect.runSync(
        renderTemplate(w.worker, readFileSync(join(ROOT, w.templatePath), "utf8"), overlay),
      ),
    ]),
  );

/** The arguments a recorded ops-script run passed after the script path. */
const scriptArgs = (call: Ran) => call.args.slice(call.args.indexOf(SCRIPT) + 1);

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
    const { report, received } = await deployedBy(scriptArgs(call));
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
      deployWorkflow.jobs["deploy"]!.steps!,
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

    const { report, received } = await deployedBy(scriptArgs(call));
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
    expect(script).toMatch(
      /operabilityCommand\(service, process\.argv\.slice\(2\), \(message\) => new Error\(message\)\)/,
    );
    const bin = readFileSync(join(ROOT, "packages/fd/bin/fd-deploy.mjs"), "utf8");
    expect(bin).toContain('import { main } from "../src/main.ts";');
    expect(bin).toContain('main("deploy");');
  });
});

// --- GitHub's rules over the committed workflows ----------------------------------------------------------------------

/** The event a run starts from: its name and `github.ref`. */
interface Event {
  readonly name: "push" | "pull_request" | "schedule" | "workflow_dispatch";
  readonly ref: string;
}
const PUSH_MAIN: Event = { name: "push", ref: "refs/heads/main" };
const PULL_REQUEST: Event = { name: "pull_request", ref: "refs/pull/7/merge" };
const SCHEDULE: Event = { name: "schedule", ref: "refs/heads/main" };

/** One `${{ }}` expression: a `github.*` value, or such a value compared with a string literal by `==` or `!=`. */
const expressionValue = (text: string, event: Event, workflowName: string): string => {
  const github: Record<string, string> = {
    "github.event_name": event.name,
    "github.ref": event.ref,
    "github.workflow": workflowName,
  };
  const comparison = /^\s*([\w.]+)\s*(==|!=)\s*'([^']*)'\s*$/.exec(text);
  if (comparison !== null) {
    const value = github[comparison[1]!];
    if (value === undefined) throw new Error(`no value for ${comparison[1]}`);
    return String(comparison[2] === "==" ? value === comparison[3] : value !== comparison[3]);
  }
  const value = github[text.trim()];
  if (value === undefined) throw new Error(`no evaluator for \${{ ${text} }}`);
  return value;
};
const interpolate = (text: string, event: Event, workflowName: string) =>
  text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_m, e: string) =>
    expressionValue(e, event, workflowName),
  );
/** A job's `if:`, which GitHub reads as an expression with or without `${{ }}`. */
const condition = (text: string, event: Event, workflowName: string) =>
  expressionValue(text.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, ""), event, workflowName) === "true";

/** Whether `event` starts a run of `wf`: its `on:` names the event, and a push matches a listed branch. */
const triggers = (wf: Workflow, event: Event) =>
  event.name in wf.on &&
  (event.name !== "push" ||
    (wf.on["push"]?.branches ?? []).some((b) => event.ref === `refs/heads/${b}`));

type Conclusion = "success" | "failure" | "skipped";

/**
 * The conclusion of every job of a run of `wf` from `event`, keyed by its path (`ci/lint` for a job of the workflow
 * `ci` calls), as GitHub decides them: a job runs only when every job it `needs` succeeded and its `if:` holds; a job
 * that calls a reusable workflow fails when any of the called workflow's jobs fails, and the called workflow sees the
 * caller's `github` context; a job that runs concludes as `outcome` says.
 */
const conclusions = (
  wf: Workflow,
  event: Event,
  outcome: (path: string) => "success" | "failure",
  caller: string = wf.name,
  prefix = "",
): Map<string, Conclusion> => {
  const all = new Map<string, Conclusion>();
  const own = new Map<string, Conclusion>();
  const visit = (key: string): Conclusion => {
    const known = own.get(key);
    if (known !== undefined) return known;
    const job = wf.jobs[key];
    if (job === undefined) throw new Error(`${prefix}${key}: no such job`);
    const needs = [job.needs ?? []].flat().map(visit);
    let c: Conclusion;
    if (
      needs.some((n) => n !== "success") ||
      (job.if !== undefined && !condition(job.if, event, caller))
    )
      c = "skipped";
    else if (job.uses?.startsWith("./.github/workflows/") === true) {
      const called = workflowFile(job.uses);
      expect(called.on).toHaveProperty("workflow_call");
      const inner = conclusions(called, event, outcome, caller, `${prefix}${key}/`);
      for (const [k, v] of inner) all.set(k, v);
      c = [...inner.values()].includes("failure") ? "failure" : "success";
    } else c = outcome(`${prefix}${key}`);
    own.set(key, c);
    all.set(`${prefix}${key}`, c);
    return c;
  };
  for (const key of Object.keys(wf.jobs)) visit(key);
  return all;
};
const allPass = () => "success" as const;
const failing = (job: string) => (path: string) => (path === job ? "failure" : "success");
const ran = (c: Map<string, Conclusion>) =>
  [...c].filter(([, v]) => v !== "skipped").map(([k]) => k);

/** The CI commands of FD-OPS-026, each as the `run:` line of the job that runs it. */
const CI_COMMANDS: Readonly<Record<string, RegExp>> = {
  lint: /^pnpm lint$/,
  typecheck: /^pnpm typecheck$/,
  "unit tests": /^pnpm test$/,
  "formal build gate": /packages\/ops\/scripts\/formal-gate\.ts/,
  "wrangler deploy --dry-run on the control plane's configuration rendered from the placeholder overlay":
    /^pnpm exec wrangler deploy --dry-run -c apps\/control-plane\/control-plane\.jsonc$/,
  "wrangler deploy --dry-run on the docs Worker's configuration rendered from the placeholder overlay":
    /^mkdir -p apps\/docs\/dist && pnpm exec wrangler deploy --dry-run -c apps\/docs\/docs\.jsonc$/,
  "the render, cron and drift checks": /packages\/ops\/scripts\/drift-check\.ts/,
  "documentation site build": /^pnpm --filter @fractalboxdev\/flare-dispatch-docs run build$/,
};
/** The `v2-ci` job that runs each CI command of FD-OPS-026. */
const ciCommandJobs = () =>
  new Map(
    Object.entries(CI_COMMANDS).map(([command, line]) => {
      const jobs = Object.entries(ciWorkflow.jobs)
        .filter(([, j]) => (j.steps ?? []).some((s) => line.test((s.run ?? "").trim())))
        .map(([k]) => k);
      expect(jobs, command).toHaveLength(1);
      return [command, jobs[0]!] as const;
    }),
  );

/**
 * GitHub's concurrency rules over the runs of one workflow: a run whose group has a run in progress waits, replacing
 * the group's waiting run, which is cancelled; with `cancel-in-progress` true the run in progress is cancelled instead.
 * A run of a workflow with no `concurrency` starts at once.
 */
const concurrencyQueue = (wf: Workflow) => {
  type Run = {
    id: string;
    group: string | null;
    state: "pending" | "running" | "done" | "cancelled";
  };
  const runs: Run[] = [];
  const startedThenCancelled: string[] = [];
  let mostRunning = 0;
  const settle = () => {
    for (const r of runs)
      if (r.state === "pending" && !runs.some((o) => o.group === r.group && o.state === "running"))
        r.state = "running";
    mostRunning = Math.max(mostRunning, runs.filter((r) => r.state === "running").length);
  };
  return {
    queue: (id: string, event: Event) => {
      const c = wf.concurrency;
      const group = c === undefined ? null : interpolate(c.group, event, wf.name);
      const cancel =
        c !== undefined && interpolate(String(c["cancel-in-progress"]), event, wf.name) === "true";
      for (const r of runs)
        if (group !== null && r.group === group) {
          if (r.state === "pending") r.state = "cancelled";
          if (r.state === "running" && cancel) {
            r.state = "cancelled";
            startedThenCancelled.push(r.id);
          }
        }
      runs.push({ id, group, state: group === null ? "running" : "pending" });
      settle();
    },
    finish: (id: string) => {
      const r = runs.find((x) => x.id === id && x.state === "running");
      if (r === undefined) throw new Error(`${id} is not running`);
      r.state = "done";
      settle();
    },
    state: (id: string) => runs.find((r) => r.id === id)?.state,
    mostRunning: () => mostRunning,
    startedThenCancelled: () => [...startedThenCancelled],
  };
};

/** The minutes of `[from, from + days)` a five-field cron expression fires at, in UTC. */
const cronFirings = (cron: string, from: Date, days: number): Date[] => {
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/);
  const field = (spec: string, value: number) =>
    spec.split(",").some((part) => {
      const [range, step] = part.split("/");
      const [lo, hi] =
        range === "*"
          ? [0, 59]
          : range!.includes("-")
            ? range!.split("-").map(Number)
            : [Number(range), Number(range)];
      return (
        value >= lo! &&
        value <= (step === undefined ? hi! : 59) &&
        (value - lo!) % Number(step ?? 1) === 0
      );
    });
  const out: Date[] = [];
  for (let t = from.getTime(); t < from.getTime() + days * 86_400_000; t += 60_000) {
    const d = new Date(t);
    if (
      field(minute!, d.getUTCMinutes()) &&
      field(hour!, d.getUTCHours()) &&
      field(dom!, d.getUTCDate()) &&
      field(month!, d.getUTCMonth() + 1) &&
      field(dow!, d.getUTCDay())
    )
      out.push(d);
  }
  return out;
};

/**
 * A copy of the repository's working tree a suite may change: every tracked and untracked file that git does not
 * ignore, with each workspace package's `node_modules` links copied as links, so a workspace import resolves inside
 * the copy, and the root `node_modules` and the mameko submodule linked to the checkout's.
 */
const mirror = (name: string) => {
  const dir = join(scratch, name, "repository");
  mkdirSync(dir, { recursive: true });
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter((f) => f !== "" && !f.startsWith(".tmp/"));
  for (const f of new Set(files)) {
    const from = join(ROOT, f);
    if (!existsSync(from)) continue;
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    if (statSync(from).isDirectory()) symlinkSync(from, join(dir, f));
    else copyFileSync(from, join(dir, f));
  }
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  for (const f of files.filter((f) => f.endsWith("package.json") && !f.startsWith("vendor/"))) {
    const modules = join(dirname(f), "node_modules");
    if (modules === "node_modules" || !existsSync(join(ROOT, modules))) continue;
    cpSync(join(ROOT, modules), join(dir, modules), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !/[/\\]node_modules[/\\]\.(?:astro|vite)(?:[/\\]|$)/.test(src),
    });
  }
  return dir;
};

/**
 * The stand-in for `pnpm --filter <package> run <script>` in a copy of the repository: the package's script in its
 * directory with its `node_modules/.bin` on `PATH`, as pnpm runs it. It runs nothing else: a real pnpm checks the
 * install before a run and reinstalls the copy, whose root `node_modules` is the checkout's own.
 */
const pnpmStandIn = (repository: string) => {
  const packages = execFileSync("git", ["ls-files", "--", "package.json", "**/package.json"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f !== "" && !f.startsWith("vendor/") && existsSync(join(repository, f)))
    .map((f) => {
      const { name } = JSON.parse(readFileSync(join(repository, f), "utf8")) as { name?: string };
      return { name, dir: dirname(f) };
    })
    .filter((p): p is { name: string; dir: string } => p.name !== undefined);
  return [
    "#!/bin/sh",
    'if [ "$#" -ne 4 ] || [ "$1" != "--filter" ] || [ "$3" != "run" ]; then echo "pnpm stand-in: no $*" >&2; exit 2; fi',
    'case "$2" in',
    ...packages.map((p) => `  '${p.name}') dir='${p.dir}' ;;`),
    '  *) echo "pnpm stand-in: no package $2" >&2; exit 2 ;;',
    "esac",
    'cd "$GITHUB_WORKSPACE/$dir" || exit 2',
    `script=$(node -e 'const s = require("./package.json").scripts?.[process.argv[1]]; if (!s) process.exit(3); process.stdout.write(s)' "$4") || { echo "pnpm stand-in: $2 has no script $4" >&2; exit 2; }`,
    'PATH="$PWD/node_modules/.bin:$PATH" exec sh -c "$script"',
    "",
  ].join("\n");
};

/**
 * Runs `job` of `v2-ci` in `workspace`, which already holds the checkout and the install its `uses:` steps make: the
 * job's steps up to `until` (all by default), with `pnpm` played by `pnpm`'s text (`pnpmStandIn` by default).
 */
const runCiJob = (
  job: string,
  name: string,
  workspace: string,
  opts: { readonly until?: (step: Step) => boolean; readonly pnpm?: string } = {},
) => {
  const r = runner(name, []);
  rmSync(r.workspace, { recursive: true, force: true });
  symlinkSync(workspace, r.workspace);
  writeFileSync(join(r.bin, "pnpm"), opts.pnpm ?? pnpmStandIn(workspace));
  chmodSync(join(r.bin, "pnpm"), 0o755);
  const played: string[] = [];
  const steps = ciWorkflow.jobs[job]!.steps!;
  const until = opts.until ?? (() => true);
  const last = steps.reduce((at, step, i) => (until(step) ? i : at), -1);
  expect(last, `${job}: no step to run until`).toBeGreaterThanOrEqual(0);
  // `node` runs under the real home, as on the hosted runner.
  const results = runSteps(
    steps.slice(0, last + 1),
    r,
    {},
    (step) => {
      expect(
        step.uses === "actions/checkout@v4" || step.uses === "./.github/actions/v2-setup",
        step.uses,
      ).toBe(true);
      played.push(step.uses!);
    },
    { ...ciWorkflow.env, HOME: process.env["HOME"] ?? r.home },
  );
  return { results, played };
};

describe("the deploy workflow over GitHub's rules", () => {
  const secrets = (overlay: string) => ({
    "secrets.FD_OPERATOR_OVERLAY": overlay,
    "secrets.CLOUDFLARE_API_TOKEN": "cf-token",
    "secrets.GITHUB_APP_PRIVATE_KEY": "pem",
    "secrets.MAMEKO_DEPLOY_KEY": "deploy-key",
  });

  it("[FD-OPS-008] reads the overlay from the FD_OPERATOR_OVERLAY secret alone, and without it fails before its first deploy step", () => {
    for (const job of ["deploy", "doctor"]) {
      // GitHub passes an unset secret as the empty string.
      const missing = runner(`overlay-missing-${job}`);
      checkout(missing.workspace);
      const played: string[] = [];
      const results = runSteps(
        deployWorkflow.jobs[job]!.steps!,
        missing,
        secrets(""),
        (step) => void played.push(step.uses!),
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ name: "Read the operator overlay", ok: false });
      expect(results[0]!.output).toContain("the FD_OPERATOR_OVERLAY secret is not set");
      expect(played).toEqual([]);
      expect(missing.ran()).toEqual([]);

      // With the secret set, the overlay the ops script reads is the secret's text, byte for byte.
      const set = runner(`overlay-set-${job}`);
      checkout(set.workspace);
      const ok = runSteps(deployWorkflow.jobs[job]!.steps!, set, secrets(OVERLAY_TEXT), () => {});
      expect(ok.filter((s) => !s.ok)).toEqual([]);
      const scripts = set.ran().filter((c) => c.command === "node" && c.args.includes(SCRIPT));
      expect(scripts).toHaveLength(1);
      const argv = scriptArgs(scripts[0]!);
      const file = argv[argv.indexOf("--overlay") + 1]!;
      expect(readFileSync(file.slice(1), "utf8")).toBe(OVERLAY_TEXT);
    }
    // The overlay reaches each job through that one secret; no step reads another.
    const read = Object.values(deployWorkflow.jobs)
      .flatMap((j) => j.steps ?? [])
      .flatMap((s) => Object.values(s.env ?? {}))
      .filter((v) => /overlay/i.test(v));
    expect(new Set(read)).toEqual(new Set(["${{ secrets.FD_OPERATOR_OVERLAY }}"]));
  }, 30_000);

  it("[FD-OPS-011] runs one deploy at a time whatever starts it, and never cancels a started one", () => {
    const q = concurrencyQueue(deployWorkflow);
    q.queue("push-1", PUSH_MAIN);
    expect(q.state("push-1")).toBe("running");
    // A manual run from another branch, the daily doctor and a second push, all while the first deploy runs.
    q.queue("dispatch", { name: "workflow_dispatch", ref: "refs/heads/hotfix" });
    q.queue("doctor", SCHEDULE);
    q.queue("push-2", PUSH_MAIN);
    expect(q.state("push-1")).toBe("running");
    expect(q.state("push-2")).toBe("pending");
    q.finish("push-1");
    expect(q.state("push-2")).toBe("running");
    q.finish("push-2");
    expect(q.mostRunning()).toBe(1);
    expect(q.startedThenCancelled()).toEqual([]);

    // No job escapes the run's group, and the CI the deploy calls queues under a group of its own, so a deploy never
    // waits on itself.
    for (const job of Object.values(deployWorkflow.jobs)) expect(job.concurrency).toBeUndefined();
    const deployGroup = interpolate(
      deployWorkflow.concurrency!.group,
      PUSH_MAIN,
      deployWorkflow.name,
    );
    for (const event of [PUSH_MAIN, SCHEDULE])
      expect(interpolate(ciWorkflow.concurrency!.group, event, deployWorkflow.name)).not.toBe(
        deployGroup,
      );
  });

  it("[FD-OPS-030] a push to the default branch runs every CI command first, and no deploy step starts unless all pass", () => {
    expect(triggers(deployWorkflow, PUSH_MAIN)).toBe(true);
    expect(triggers(deployWorkflow, { name: "push", ref: "refs/heads/feature" })).toBe(false);

    const commandJobs = ciCommandJobs();
    const green = conclusions(deployWorkflow, PUSH_MAIN, allPass);
    for (const job of commandJobs.values()) expect(green.get(`ci/${job}`)).toBe("success");
    expect(green.get("deploy")).toBe("success");
    expect(green.get("doctor")).toBe("skipped");

    for (const [command, job] of commandJobs) {
      const red = conclusions(deployWorkflow, PUSH_MAIN, failing(`ci/${job}`));
      expect(red.get("ci"), command).toBe("failure");
      expect(red.get("deploy"), command).toBe("skipped");
    }

    // The deploy job's steps, run once CI passed: the deploy step is the ops script's `deploy`.
    const r = runner("push-deploy");
    checkout(r.workspace);
    const results = runSteps(
      deployWorkflow.jobs["deploy"]!.steps!,
      r,
      {
        "secrets.FD_OPERATOR_OVERLAY": OVERLAY_TEXT,
        "secrets.CLOUDFLARE_API_TOKEN": "cf-token",
        "secrets.GITHUB_APP_PRIVATE_KEY": "pem",
        "secrets.MAMEKO_DEPLOY_KEY": "deploy-key",
      },
      () => {},
    );
    expect(results.filter((s) => !s.ok)).toEqual([]);
    expect(fdDeployOf(r.ran()).call.args.slice(FD_DEPLOY.length)).toHaveLength(1);
  }, 30_000);

  it("[FD-OPS-025] runs fd doctor once every 24 h, and a failed check raises the notify alarm drift at the overlay's sink", async () => {
    const schedule = deployWorkflow.on["schedule"] as unknown as { cron: string }[];
    const firings = schedule.flatMap((s) =>
      cronFirings(s.cron, new Date("2026-03-01T00:00:00Z"), 3),
    );
    expect(firings).toHaveLength(3);
    for (const [i, t] of firings.entries())
      if (i > 0) expect(t.getTime() - firings[i - 1]!.getTime()).toBe(86_400_000);

    // A scheduled run runs the doctor alone: no CI, no deploy.
    expect(ran(conclusions(deployWorkflow, SCHEDULE, allPass))).toEqual(["doctor"]);

    const r = runner("doctor");
    checkout(r.workspace);
    const results = runSteps(
      deployWorkflow.jobs["doctor"]!.steps!,
      r,
      {
        "secrets.FD_OPERATOR_OVERLAY": PLACEHOLDER_OVERLAY,
        "secrets.CLOUDFLARE_API_TOKEN": "cf-token",
        "secrets.GITHUB_APP_PRIVATE_KEY": "pem",
        "secrets.MAMEKO_DEPLOY_KEY": "deploy-key",
      },
      () => {},
    );
    expect(results.filter((s) => !s.ok)).toEqual([]);
    const calls = r.ran().filter((c) => c.command === "node" && c.args.includes(SCRIPT));
    expect(calls).toHaveLength(1);
    const argv = scriptArgs(calls[0]!);
    expect(argv[0]).toBe("doctor");

    // The doctor's command line on an account the last deploy left in place: no alarm.
    const w = world();
    expect((await deployOn(w)).ok).toBe(true);
    const doctor = () => Effect.runPromise(operabilityCommand(fd(w), argv, (m) => new Error(m)));
    const clean = await doctor();
    expect(clean.ok).toBe(true);
    expect(w.alarms).toEqual([]);

    // A setting changed out of band fails the check and raises drift, as a notify alarm, and writes nothing.
    w.scripts.get(CONTROL_PLANE_SCRIPT)!.crons = ["*/5 * * * *"];
    const from = w.calls.length;
    const drifted = await doctor();
    expect(drifted.ok).toBe(false);
    expect(drifted.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
    expect(w.calls.slice(from)).toContain("POST alerts.example.com/hook");
    expect(since(w, from).filter(isWrite)).toEqual([]);
    expect(w.alarms).toHaveLength(1);
    expect(w.alarms[0]).toMatchObject({
      alarm: "drift",
      severity: "notify",
      state: "raised",
      dedupe_key: "drift",
      runbook: null,
    });
    expect(String(w.alarms[0]!["detail"])).toContain("control-plane.crons");

    // The same check without the flag reports the drift and raises nothing.
    const quiet = await Effect.runPromise(
      operabilityCommand(
        fd(w),
        argv.filter((a) => a !== "--alarm-on-drift"),
        (m) => new Error(m),
      ),
    );
    expect(quiet.ok).toBe(false);
    expect(w.alarms).toHaveLength(1);
  });
});

describe("the CI jobs the merge gate and the deploy rest on", () => {
  it("[FD-OPS-027] every pull request runs the CI commands under fallback-ci, which passes only when all pass and which the ruleset does not require", () => {
    expect(triggers(ciWorkflow, PULL_REQUEST)).toBe(true);
    const commandJobs = ciCommandJobs();
    const green = conclusions(ciWorkflow, PULL_REQUEST, allPass);
    for (const job of commandJobs.values()) expect(green.get(job)).toBe("success");
    expect(green.get("fallback-ci")).toBe("success");
    for (const [command, job] of commandJobs)
      expect(
        conclusions(ciWorkflow, PULL_REQUEST, failing(job)).get("fallback-ci"),
        command,
      ).not.toBe("success");

    // The check name is the job's name; the drift check accepts a ruleset that leaves it out as complete.
    const check = ciWorkflow.jobs["fallback-ci"]!.name ?? "fallback-ci";
    const required = [...MERGE_GATE_CHECKS, "flare-dispatch/check:ci"];
    expect(required).not.toContain(check);
    expect(rulesetCheck(required)).toEqual([]);
  });

  it("[FD-VER-023] the drift check fails a deploy when the default branch's ruleset does not require one of the merge-gate checks", async () => {
    expect([...MERGE_GATE_CHECKS].sort()).toEqual(
      [
        "lint",
        "typecheck",
        "spec-tags",
        "unit",
        "conf",
        "sim",
        "replay",
        "e2e-local",
        "deploy-dry-run",
        "profile-reference",
        "formal",
        "diff",
      ].sort(),
    );
    // Every required check is a job a pull request runs, so the ruleset blocks no pull request on a missing check.
    const pr = conclusions(ciWorkflow, PULL_REQUEST, allPass);
    for (const check of MERGE_GATE_CHECKS) expect(pr.get(check), check).toBe("success");

    for (const check of MERGE_GATE_CHECKS) {
      const w = world();
      w.state.required = w.state.required.filter((c) => c !== check);
      const report = await deployOn(w);
      expect(report.ok, check).toBe(false);
      const drift = report.stages.at(-1)!;
      expect(drift).toMatchObject({ stage: "drift", ok: false });
      expect(drift.detail).toContain(`required_status_checks.${check}`);
      expect(w.calls.filter(isWrite), check).toEqual([]);
    }
    const w = world();
    expect((await deployOn(w)).ok).toBe(true);
  }, 30_000);

  it("[FD-OPS-026] every pull request runs wrangler deploy --dry-run for every Worker on its configuration rendered from the placeholder overlay", () => {
    expect(conclusions(ciWorkflow, PULL_REQUEST, allPass).get("deploy-dry-run")).toBe("success");
    const isDryRun = (s: Step) => /wrangler deploy --dry-run/.test(s.run ?? "");
    /** A `pnpm` that records each `pnpm exec wrangler` with the configuration its `-c` names, as the call saw it. */
    const recorder = (name: string) => {
      const dir = join(scratch, name, "dry-runs");
      mkdirSync(dir, { recursive: true });
      const pnpm = [
        "#!/bin/sh",
        'if [ "$1" != "exec" ] || [ "$2" != "wrangler" ]; then echo "pnpm stand-in: no $*" >&2; exit 2; fi',
        'config=""; prev=""',
        'for a in "$@"; do if [ "$prev" = "-c" ]; then config="$a"; fi; prev="$a"; done',
        `n=$(ls "${dir}" | wc -l | tr -d ' ')`,
        `mkdir "${dir}/$n" && cp "$config" "${dir}/$n/config.jsonc" || exit 2`,
        `printf '%s' "$*" > "${dir}/$n/args"`,
        "",
      ].join("\n");
      const dryRuns = () =>
        readdirSync(dir)
          .sort((a, b) => Number(a) - Number(b))
          .map((n) => ({
            args: readFileSync(join(dir, n, "args"), "utf8"),
            config: readFileSync(join(dir, n, "config.jsonc"), "utf8"),
          }));
      return { pnpm, dryRuns };
    };

    // The drift check writes each Worker's rendered configuration beside its template, and each is dry-run.
    const repository = mirror("dry-run");
    const clean = recorder("dry-run");
    const ran = runCiJob("deploy-dry-run", "dry-run", repository, {
      until: isDryRun,
      pnpm: clean.pnpm,
    });
    expect(ran.results.filter((s) => !s.ok)).toEqual([]);
    expect(ran.results.map((s) => s.output).join("\n")).toContain(
      "drift-check: 0 failure(s), 0 warning(s)",
    );
    expect(clean.dryRuns()).toEqual(
      V2_WORKERS.map((w) => ({
        args: `exec wrangler deploy --dry-run -c ${dirname(w.templatePath)}/${w.worker}.jsonc`,
        config: Effect.runSync(
          renderTemplate(
            w.worker,
            readFileSync(join(ROOT, w.templatePath), "utf8"),
            placeholderOverlay,
          ),
        ),
      })),
    );
    // The docs Worker's rendered configuration passes wrangler's own dry-run where the job left it.
    const docsDryRun = spawnSync(
      join(ROOT, "node_modules/.bin/wrangler"),
      ["deploy", "--dry-run", "-c", "apps/docs/docs.jsonc"],
      {
        cwd: repository,
        encoding: "utf8",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
      },
    );
    expect(docsDryRun.status, `${docsDryRun.stdout}${docsDryRun.stderr}`).toBe(0);
    expect(docsDryRun.stdout).toContain("--dry-run: exiting now.");

    // A docs template that names its hostname fails the job at the drift check, before any dry-run.
    const hardCoded = mirror("dry-run-hostname");
    const template = join(hardCoded, "apps/docs/wrangler.jsonc");
    const text = readFileSync(template, "utf8");
    writeFileSync(template, text.replace('"{{hostnames.docs}}"', '"docs.acme.test"'));
    expect(readFileSync(template, "utf8")).not.toBe(text);
    const bad = recorder("dry-run-hostname");
    const failed = runCiJob("deploy-dry-run", "dry-run-hostname", hardCoded, {
      until: isDryRun,
      pnpm: bad.pnpm,
    });
    expect(failed.results.map((s) => s.ok)).toEqual([true, true, false]);
    expect(failed.results.at(-1)!.output).toContain("failure placeholder docs.routes[0].pattern");
    expect(bad.dryRuns()).toEqual([]);
  }, 120_000);

  it("[FD-OPS-031] the docs job builds the site from the Markdown under specs/, and fails on a broken local link or a diagram the check rejects", () => {
    expect(conclusions(ciWorkflow, PULL_REQUEST, allPass).get("docs")).toBe("success");

    // A broken diagram fails the job at the diagram check, before the build.
    const diagram = mirror("docs-diagram");
    appendFileSync(
      join(diagram, "specs/operability.md"),
      "\n```mermaid\nflowchart LR\n  A[unclosed --> B\n```\n",
    );
    const bad = runCiJob("docs", "docs-diagram", diagram);
    expect(bad.results.map((s) => s.ok)).toEqual([true, true, false]);
    expect(bad.results.at(-1)!.output).toMatch(/specs\/operability\.md:\d+: failed \(parse\)/);

    // A broken local link passes the diagram check and fails the build, which read it from specs/.
    const link = mirror("docs-link");
    appendFileSync(
      join(link, "specs/operability.md"),
      "\nSee [the retired page](retired-page.md).\n",
    );
    const broken = runCiJob("docs", "docs-link", link);
    expect(broken.results.map((s) => s.ok)).toEqual([true, true, true, false]);
    expect(broken.results[2]!.output).toMatch(/\d+ diagrams, 0 failed, 0 repairs/);
    const build = broken.results.at(-1)!.output;
    expect(build).toContain("specs/operability.md: broken link: retired-page.md");
    // The page the build made from specs/operability.md carries the link that has no page.
    expect(build).toContain("/specs/operability/: link retired-page.md has no page");
  }, 300_000);

  it("[FD-VER-033] every pull request runs profile-reference, which fails on a difference from the reference profile that profile.md does not list", () => {
    expect(conclusions(ciWorkflow, PULL_REQUEST, allPass).get("profile-reference")).toBe("success");
    // The committed profile differs from the reference only in listed rows, and the job passes.
    expect(
      diffJson(referenceProfile, projectForReference(buildProfile("production", 0))).length,
    ).toBeGreaterThan(0);
    const clean = runCiJob("profile-reference", "profile-clean", mirror("profile-clean"));
    expect(clean.results.map((s) => s.ok)).toEqual([true, true, true]);
    expect(clean.results.at(-1)!.output).toContain("profile-reference: 0 unlisted difference(s)");

    // A value the list does not cover fails the job.
    const drifted = mirror("profile-drifted");
    const reference = join(drifted, "packages/profile/src/reference.ts");
    const text = readFileSync(reference, "utf8");
    const changed = text.replace(/(interactive: \{\s*rank: )2,/, (_m, head: string) => `${head}9,`);
    expect(changed).not.toBe(text);
    writeFileSync(reference, changed);
    const bad = runCiJob("profile-reference", "profile-drifted", drifted);
    expect(bad.results.map((s) => s.ok)).toEqual([true, true, false]);
    expect(bad.results.at(-1)!.output).toMatch(
      /phase 0 classes\.interactive\.rank: reference 9, FlareDispatch 2/,
    );
  }, 60_000);
});
