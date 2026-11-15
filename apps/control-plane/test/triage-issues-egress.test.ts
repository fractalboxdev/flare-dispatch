// `triage-issues` on a Container (specs/runs/agentic.md FD-AGT-005, FD-AGT-094): the run's per-lease Layers read the
// open issues while the setup grants hold, write them to a workspace file and end the setup phase; the run body then
// classifies them under the agent grants. Every request the job sends leaves through the Container pools' outbound
// handler, `egressOutbound`, over the grants the control plane launches `triage-issues` with, in the phase the device
// executor holds when the request is sent.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTriageIssues, TRIAGE_LABELS } from "@fractalboxdev/flare-dispatch-agentic";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { launchGrants } from "@fractalboxdev/mameko-host-cloudflare";
import { egressOutbound } from "@fractalboxdev/mameko-host-cloudflare/containers";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  containerAgenticLayers,
  ISSUES_FILE,
} from "../../../packages/catalog/src/container-layers.ts";
import { ExecutionLease } from "../../../packages/catalog/src/execution-lease.ts";
import { intentList } from "../../../vendor/mameko/packages/run/src/index.ts";
import { jobServices } from "../../../vendor/mameko/packages/runner/src/job-services.ts";
import type { ControlPlaneEnv } from "../src/config.ts";
import { poolSettings } from "../src/pools.ts";

const ORIGIN = "https://ci.example.com";
const MODEL_ROUTE = `${ORIGIN}/v1/model/completions`;
const EXECUTION = "01JTRIAGEEGRESS00000000000";
const REPO = { owner: "acme", name: "app" };

/** The grants the pool controller launches `triage-issues`' Container with, per egress phase. */
const grants = launchGrants(
  poolSettings({ PUBLIC_ORIGIN: ORIGIN } as unknown as ControlPlaneEnv, buildProfile("production")),
  "triage-issues",
);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The lease's checkout, as the device executor placed it in the workspace. */
const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-triage-ws-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "readme\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return dir;
};

const issue = (number: number, title: string) => ({
  number,
  title,
  body: "How do I configure the cache?",
  user: { login: "reporter" },
  author_association: "NONE",
  labels: [],
  state_reason: null,
});

/**
 * One execution's egress: the device executor's phase, switched to `agent` by `job.egress`, and the job's `fetch`,
 * which sends each request through `egressOutbound` over that phase's grants to GitHub's issue list and the model
 * route. `events` records the phase switch and each request with its phase and answer, in order.
 */
const container = (dir: string, github: () => Response) => {
  const events: string[] = [];
  let phase: "setup" | "agent" = "setup";
  const upstream = async (request: Request) => {
    const url = new URL(request.url);
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/app/issues")
      return github();
    if (url.href === MODEL_ROUTE) return Response.json({ text: '{"verdict":"question"}' });
    return new Response("no such upstream", { status: 404 });
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const answer = await egressOutbound(
      request,
      { grants: grants[phase], objectStoreHost: null },
      upstream,
    );
    const url = new URL(request.url);
    events.push(`${phase} ${request.method} ${url.hostname}${url.pathname} ${answer.status}`);
    return answer;
  }) as typeof globalThis.fetch;
  const client = {
    request: async (m: Record<string, unknown>): Promise<Record<string, unknown>> => {
      switch (m["type"]) {
        case "workspace.read":
          return {
            type: "workspace.read.ok",
            bytes: readFileSync(join(dir, String(m["path"]))).toString("base64"),
          };
        case "job.exec": {
          const argv = m["argv"] as string[];
          const stdout = execFileSync(argv[0]!, argv.slice(1), { cwd: dir });
          return {
            type: "job.exec.ok",
            exit_code: 0,
            stdout: stdout.toString("base64"),
            stderr: "",
          };
        }
        case "job.egress":
          events.push(`egress:${String(m["phase"])}`);
          phase = "agent";
          return { type: "job.egress.ok" };
        default:
          return { type: "socket.error", code: "Unsupported", message: String(m["type"]) };
      }
    },
  };
  return { events, fetch, client };
};

/** Runs `triage-issues`' body over the per-lease Layers the Container pool's runner builds for it. */
const triage = async (c: ReturnType<typeof container>) => {
  const input = {
    repo: REPO,
    cloudLease: { modelGatewayUrl: MODEL_ROUTE, controlPlaneUrl: ORIGIN },
  };
  const intents = intentList();
  const layers = containerAgenticLayers({ fetch: c.fetch, env: {}, editLoop: ["true"] }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ExecutionLease, {
          executionId: EXECUTION,
          epoch: 1,
          run: "triage-issues",
          input,
        }),
        jobServices(c.client, { executionId: EXECUTION, epoch: 1, outputPaths: [] }),
        intents.layer,
      ),
    ),
  );
  const result = await Effect.runPromise(
    Effect.scoped(runTriageIssues(input).pipe(Effect.provide(layers))),
  );
  return { result, intents: intents.intents() };
};

describe("triage-issues on a Container", () => {
  it("[FD-AGT-005] [FD-AGT-094] [FD-AGT-074] [FD-AGT-075] reads its issues under the setup grants before the egress switch, and after it sends no request but to the model gateway", async () => {
    const dir = workspace();
    const c = container(dir, () => Response.json([issue(2, "Cache question"), issue(1, "Docs")]));
    const { result, intents } = await triage(c);
    expect(result).toEqual({ _tag: "success" });
    // Each issue the model answered `question` for is labelled not actionable (FD-AGT-075).
    expect(
      intents.map((i) => [i.kind, (i.payload as { issue_number: number }).issue_number]),
    ).toEqual([
      ["label", 2],
      ["label", 1],
    ]);
    for (const i of intents)
      expect((i.payload as { add: string[] }).add).toEqual([TRIAGE_LABELS.notActionable]);
    const egress = c.events.indexOf("egress:agent");
    expect(egress).toBeGreaterThan(0);
    // The issue read is the setup phase's one request, admitted by `github-api-read`.
    expect(c.events.slice(0, egress)).toEqual([
      "setup GET api.github.com/repos/acme/app/issues 200",
    ]);
    // After the switch, every request is a model call; one classification per untriaged issue.
    expect(c.events.slice(egress + 1)).toEqual([
      "agent POST ci.example.com/v1/model/completions 200",
      "agent POST ci.example.com/v1/model/completions 200",
    ]);
    // The workspace file the agent phase read holds the setup read.
    const file = JSON.parse(readFileSync(join(dir, ISSUES_FILE), "utf8")) as {
      repository: string;
      issues: { number: number }[];
    };
    expect(file.repository).toBe("acme/app");
    expect(file.issues.map((i) => i.number)).toEqual([2, 1]);
  });

  it("[FD-AGT-005] [FD-AGT-094] the agent grants deny GitHub: a request there after the switch is refused before it leaves", async () => {
    const dir = workspace();
    const c = container(dir, () => Response.json([]));
    expect((await triage(c)).result).toEqual({ _tag: "success" });
    const late = await c.fetch("https://api.github.com/repos/acme/app/issues?state=open");
    expect(late.status).toBe(403);
    expect(c.events.at(-1)).toBe("agent GET api.github.com/repos/acme/app/issues 403");
  });

  it("[FD-AGT-094] a setup read GitHub refuses fails the run's issue read with infra, never an empty list, and sends no model call", async () => {
    const dir = workspace();
    const c = container(dir, () => new Response("{}", { status: 502 }));
    expect((await triage(c)).result).toEqual({
      _tag: "failure",
      reason: expect.stringMatching(/^infra: read issues: .*502/),
    });
    expect(c.events.filter((e) => e.includes("/v1/model/"))).toEqual([]);
    expect(c.events).toContain("egress:agent");
  });
});
