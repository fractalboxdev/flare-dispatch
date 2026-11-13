// The deploy suite of `V-DEPLOY` for the GitHub Actions launcher's runner workflow (specs/executors.md § The GitHub
// Actions launcher): `fd deploy` and `fd doctor` on the fakes of `support.ts`, whose runner repository `acme/runner`
// serves its workflow files only to a contents-scoped token of the App's installation there.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { placeholderOverlay, type OverlayValues } from "../../src/index.ts";
import { deploy, fd, isWrite, SCRIPT, world, type World } from "./support.ts";

const WORKFLOW = "fd-runner.yml";
const WHERE = `acme/runner/.github/workflows/${WORKFLOW}`;
const READ = `GET api.github.com/repos/acme/runner/contents/.github/workflows/${WORKFLOW}`;

const overlayWith = (gha: OverlayValues["gha"]) => JSON.stringify({ ...placeholderOverlay, gha });
const GHA_OVERLAY = overlayWith({
  runnerRepo: "acme/runner",
  workflow: WORKFLOW,
  concurrencyCap: 4,
});

/** A runner workflow whose header and job carry the given `permissions` lines (none where `undefined`). */
const runnerWorkflow = (top: string | undefined, job: string | undefined) =>
  [
    "name: fd-runner",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      execution_id: { required: true, type: string }",
    "      epoch: { required: true, type: string }",
    "      deadline_minutes: { required: true, type: string }",
    ...(top === undefined ? [] : [top]),
    "jobs:",
    "  runner:",
    "    runs-on: macos-15",
    "    timeout-minutes: ${{ fromJSON(inputs.deadline_minutes) }}",
    ...(job === undefined ? [] : [job.replace(/^/gm, "    ")]),
    "    steps:",
    "      - run: echo runner",
  ].join("\n");

const ID_TOKEN_ONLY = "permissions:\n  id-token: write";

const worldWith = (text: string) => {
  const w = world();
  w.state.runnerWorkflows = { [WORKFLOW]: text };
  return w;
};

const driftStage = (report: {
  readonly stages: readonly { stage: string; ok: boolean; detail: string }[];
}) => report.stages.find((s) => s.stage === "drift");

const doctor = (w: World, overlay = GHA_OVERLAY) => Effect.runPromise(fd(w).doctor(overlay));

/** `fd deploy` stops at the drift stage with `line` before any Cloudflare write, and `fd doctor` reports it. */
const refused = async (w: World, line: string) => {
  const report = await deploy(w, GHA_OVERLAY);
  expect(report.ok).toBe(false);
  expect(report.stages.at(-1)).toEqual({ stage: "drift", ok: false, detail: line });
  expect(w.calls.filter(isWrite)).toEqual([]);
  expect(w.calls).not.toContain(`wrangler deploy ${SCRIPT}`);
  const checked = await doctor(w);
  expect(checked.ok).toBe(false);
  expect(driftStage(checked)).toEqual({
    stage: "drift",
    ok: false,
    detail: line
      .split("\n")
      .map((l) => `failure ${l}`)
      .join("\n"),
  });
};

describe("the runner workflow check of the drift check", () => {
  it("[FD-EXEC-091] fd doctor reads the runner workflow from gha.runnerRepo where the overlay carries the gha kind, and passes when every job's GITHUB_TOKEN holds only id-token: write", async () => {
    for (const [top, job] of [
      [ID_TOKEN_ONLY, undefined],
      [undefined, ID_TOKEN_ONLY],
      ["permissions: read-all", ID_TOKEN_ONLY],
      [ID_TOKEN_ONLY, "permissions:\n  id-token: write\n  contents: none"],
    ] as const) {
      const w = worldWith(runnerWorkflow(top, job));
      const report = await doctor(w);
      expect(report.ok).toBe(true);
      expect(driftStage(report)).toEqual({ stage: "drift", ok: true, detail: "" });
      expect(w.calls).toContain(READ);
    }
    // A deploy without the gha kind reads no runner repository.
    const w = world();
    const report = await Effect.runPromise(fd(w).doctor(JSON.stringify(placeholderOverlay)));
    expect(report.ok).toBe(true);
    expect(w.calls.filter((c) => c.includes("acme/runner"))).toEqual([]);
  });

  it("[FD-EXEC-091] fd deploy and fd doctor fail the drift check when the runner workflow grants its GITHUB_TOKEN any permission but id-token: write, before any Cloudflare write", async () => {
    const grant = (excess: string) =>
      `gha.workflow.jobs.runner.permissions: ${WHERE}: job runner grants its GITHUB_TOKEN ${excess}; grant it only id-token: write`;
    for (const [top, job, excess] of [
      ["permissions:\n  id-token: write\n  contents: read", undefined, "contents: read"],
      [ID_TOKEN_ONLY, "permissions:\n  id-token: write\n  actions: write", "actions: write"],
      ["permissions: write-all", undefined, "write-all"],
      [undefined, "permissions: read-all", "read-all"],
      [ID_TOKEN_ONLY, "permissions:\n  id-token: read", "id-token: read"],
    ] as const) {
      const w = worldWith(runnerWorkflow(top, job));
      await refused(w, grant(excess));
      // The same deploy goes out once the job's token holds only id-token: write.
      w.state.runnerWorkflows = { [WORKFLOW]: runnerWorkflow(undefined, ID_TOKEN_ONLY) };
      const fixed = await deploy(w, GHA_OVERLAY);
      expect(fixed.ok).toBe(true);
      expect(w.calls).toContain(`wrangler deploy ${SCRIPT}`);
    }
  });

  it("[FD-EXEC-091] fails a job that sets no permissions, so its GITHUB_TOKEN holds the repository's defaults, naming each such job", async () => {
    const text = `${runnerWorkflow(undefined, ID_TOKEN_ONLY)}\n  notify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo done`;
    await refused(
      worldWith(text),
      `gha.workflow.jobs.notify.permissions: ${WHERE}: job notify sets no permissions, so its GITHUB_TOKEN holds the repository's default permissions; grant it only id-token: write`,
    );
  });

  it("[FD-EXEC-091] fails when the runner repository holds no runner workflow, or the overlay carries the gha kind without naming one", async () => {
    await refused(world(), `gha.workflow: ${WHERE} does not exist`);

    const w = world();
    const unset = overlayWith({ concurrencyCap: 4 });
    const report = await deploy(w, unset);
    expect(report.stages.at(-1)).toEqual({
      stage: "drift",
      ok: false,
      detail:
        "gha.workflow: the overlay carries the gha kind and sets no gha.runnerRepo or gha.workflow, so the runner workflow's permissions cannot be checked",
    });
    expect(w.calls.filter((c) => c.includes("acme/runner"))).toEqual([]);
    expect(w.calls.filter(isWrite)).toEqual([]);
  });

  it("[FD-EXEC-091] fails a gha.runnerRepo that names no <owner>/<repo> before reading any repository", async () => {
    for (const runnerRepo of ["runner", "acme/runner/extra", "/runner"]) {
      const w = world();
      const report = await deploy(w, overlayWith({ runnerRepo, workflow: WORKFLOW }));
      expect(report.stages.at(-1)).toEqual({
        stage: "drift",
        ok: false,
        detail: `gha.runnerRepo: gha.runnerRepo ${runnerRepo} names no <owner>/<repo>`,
      });
      expect(w.calls.filter((c) => c.includes(`/repos/${runnerRepo}`))).toEqual([]);
      expect(w.calls.filter(isWrite)).toEqual([]);
    }
  });
});
