// The runner workflow check over the workflow file's text (specs/executors.md § The GitHub Actions launcher): each
// job's `timeout-minutes` comes from the `deadline_minutes` input the launcher dispatches it with (FD-EXEC-087).
import { describe, expect, it } from "vitest";
import { runnerWorkflowCheck } from "./gha-runner.ts";

const REPO = "acme/runner";
const WORKFLOW = "fd-runner.yml";
const WHERE = `${REPO}/.github/workflows/${WORKFLOW}`;
const FIX = "set it to ${{ fromJSON(inputs.deadline_minutes) }}";

const INPUTS = [
  "      execution_id: { required: true, type: string }",
  "      epoch: { required: true, type: string }",
  "      deadline_minutes: { required: true, type: string }",
];

/** A runner workflow whose one `runner` job carries the given `timeout-minutes` line (none where `undefined`). */
const runnerWorkflow = (timeout: string | undefined, inputs: readonly string[] = INPUTS) =>
  [
    "name: fd-runner",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    ...inputs,
    "permissions:",
    "  id-token: write",
    "jobs:",
    "  runner:",
    "    runs-on: macos-15",
    ...(timeout === undefined ? [] : [`    timeout-minutes: ${timeout}`]),
    "    steps:",
    "      - run: echo runner",
  ].join("\n");

const check = (text: string) => runnerWorkflowCheck(REPO, WORKFLOW, text);

const timeoutFailure = (job: string, problem: string) => ({
  check: "gha-runner",
  path: `gha.workflow.jobs.${job}.timeout-minutes`,
  detail: `${WHERE}: job ${job} ${problem}; ${FIX}`,
  severity: "failure",
});

describe("the runner workflow's timeout-minutes", () => {
  it("[FD-EXEC-087] passes a runner job whose timeout-minutes is the deadline_minutes input, as given or through fromJSON", async () => {
    for (const timeout of [
      "${{ fromJSON(inputs.deadline_minutes) }}",
      "${{ inputs.deadline_minutes }}",
      "${{fromJSON(inputs.deadline_minutes)}}",
      "${{ fromJson( github.event.inputs.deadline_minutes ) }}",
      "${{ github.event.inputs.deadline_minutes }}",
      "'${{ fromJSON(inputs.deadline_minutes) }}'",
    ])
      expect(await check(runnerWorkflow(timeout))).toEqual([]);
  });

  it("[FD-EXEC-087] fails a runner job that sets no timeout-minutes, so it runs to GitHub's default past deadline_at", async () => {
    expect(await check(runnerWorkflow(undefined))).toEqual([
      timeoutFailure(
        "runner",
        "sets no timeout-minutes, so it runs to GitHub's 360-minute default past deadline_at",
      ),
    ]);
  });

  it("[FD-EXEC-087] fails a runner job whose timeout-minutes is a literal or an expression not taken from the deadline_minutes input", async () => {
    for (const [timeout, shown] of [
      ["60", "60"],
      ["${{ 60 }}", "${{ 60 }}"],
      ["${{ fromJSON(inputs.epoch) }}", "${{ fromJSON(inputs.epoch) }}"],
      ["${{ fromJSON(inputs.deadline_minutes) + 30 }}", "${{ fromJSON(inputs.deadline_minutes) + 30 }}"],
      ["${{ inputs.deadline_minutes || 360 }}", "${{ inputs.deadline_minutes || 360 }}"],
      ["${{ vars.deadline_minutes }}", "${{ vars.deadline_minutes }}"],
    ] as const)
      expect(await check(runnerWorkflow(timeout))).toEqual([
        timeoutFailure("runner", `sets timeout-minutes ${shown}, which is not the deadline_minutes input`),
      ]);
  });

  it("[FD-EXEC-087] checks every job of the runner workflow and names each one whose timeout-minutes does not derive from deadline_minutes", async () => {
    const text = [
      runnerWorkflow("${{ fromJSON(inputs.deadline_minutes) }}"),
      "  setup:",
      "    runs-on: ubuntu-latest",
      "    timeout-minutes: 10",
      "    steps:",
      "      - run: echo setup",
      "  notify:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo notify",
    ].join("\n");
    expect(await check(text)).toEqual([
      timeoutFailure("setup", "sets timeout-minutes 10, which is not the deadline_minutes input"),
      timeoutFailure(
        "notify",
        "sets no timeout-minutes, so it runs to GitHub's 360-minute default past deadline_at",
      ),
    ]);
  });

  it("[FD-EXEC-087] fails a runner workflow whose workflow_dispatch trigger declares no deadline_minutes input", async () => {
    const missing = {
      check: "gha-runner",
      path: "gha.workflow.on.workflow_dispatch.inputs.deadline_minutes",
      detail: `${WHERE}: the workflow_dispatch trigger declares no deadline_minutes input, which carries the minutes until deadline_at`,
      severity: "failure",
    };
    expect(
      await check(runnerWorkflow("${{ fromJSON(inputs.deadline_minutes) }}", INPUTS.slice(0, 2))),
    ).toEqual([missing]);
    const noDispatch = runnerWorkflow("${{ fromJSON(inputs.deadline_minutes) }}").replace(
      /on:\n {2}workflow_dispatch:\n {4}inputs:\n(?: {6}.*\n){3}/,
      "on: push\n",
    );
    expect(await check(noDispatch)).toEqual([missing]);
  });
});
