// The drift check's read of the GitHub Actions launcher's runner workflow (specs/executors.md § The GitHub Actions
// launcher): for a deploy whose overlay carries the `gha` kind, the workflow file `gha.workflow` in the runner
// repository `gha.runnerRepo` must grant each job's `GITHUB_TOKEN` no permission except `id-token: write`
// (FD-EXEC-091), and must set each job's `timeout-minutes` from the `deadline_minutes` input, the minutes until the
// lease's `deadline_at` that the launcher dispatches it with (FD-EXEC-087). The check is a function of the file's text alone; `fd deploy` and `fd doctor` read it through
// `DeployTarget.runnerWorkflow`. The YAML parser loads on the check's first call, so a bundle that imports the ops
// root without running the drift check (the control-plane Worker) carries no parser.
import type { Finding } from "./drift.ts";

const CHECK = "gha-runner";
const PATH = "gha.workflow";

/** The one permission the runner job's token may hold: the Actions OIDC token it claims its lease with. */
const ALLOWED = "id-token";

/** The `workflow_dispatch` input that carries the minutes until `deadline_at` (packages/github `dispatchInputs`). */
const DEADLINE_INPUT = "deadline_minutes";

/**
 * A `timeout-minutes` expression that takes its value from the `deadline_minutes` input alone, through `fromJSON`,
 * read from `inputs` or `github.event.inputs`. `timeout-minutes` takes a number and the launcher dispatches the input
 * as a string, so the bare input is not accepted. Expression function and context names are case-insensitive in
 * GitHub Actions.
 */
const FROM_DEADLINE =
  /^\$\{\{\s*fromJSON\(\s*(?:github\.event\.)?inputs\.deadline_minutes\s*\)\s*\}\}$/i;

const fail = (path: string, detail: string): Finding => ({
  check: CHECK,
  path,
  detail,
  severity: "failure",
});

/** Where the runner workflow sits in its repository. */
export const runnerWorkflowPath = (workflow: string) => `.github/workflows/${workflow}`;

/** The failure of a deploy that carries the `gha` kind and names no runner repository or workflow; nothing is read. */
export const ghaRunnerUnset: Finding = fail(
  PATH,
  "the overlay carries the gha kind and sets no gha.runnerRepo or gha.workflow, so the runner workflow's permissions and timeout-minutes cannot be checked",
);

/**
 * The failure of a `gha.runnerRepo` that names no `<owner>/<repo>`, or `undefined` when it does; the drift check reads
 * nothing from a repository it cannot name.
 */
export const runnerRepoInvalid = (runnerRepo: string): Finding | undefined =>
  /^[^/]+\/[^/]+$/.test(runnerRepo)
    ? undefined
    : fail("gha.runnerRepo", `gha.runnerRepo ${runnerRepo} names no <owner>/<repo>`);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What a `permissions` value grants beyond `id-token: write`, one entry per scope; `undefined` when the value is
 * absent, which leaves the token at the repository's default permissions.
 */
const excessOf = (permissions: unknown): readonly string[] | undefined => {
  if (permissions === undefined || permissions === null) return undefined;
  if (!isRecord(permissions)) return [String(permissions)];
  return Object.entries(permissions).flatMap(([scope, level]) =>
    level === "none" || (scope === ALLOWED && level === "write")
      ? []
      : [`${scope}: ${String(level)}`],
  );
};

/** Whether the workflow's `workflow_dispatch` trigger declares the `deadline_minutes` input. */
const declaresDeadlineInput = (on: unknown): boolean => {
  if (!isRecord(on)) return false;
  const dispatch = on["workflow_dispatch"];
  const inputs = isRecord(dispatch) ? dispatch["inputs"] : undefined;
  return isRecord(inputs) && DEADLINE_INPUT in inputs;
};

/** Why a job's `timeout-minutes` value is not taken from the `deadline_minutes` input, or `undefined` when it is. */
const timeoutProblem = (timeout: unknown): string | undefined => {
  if (timeout === undefined || timeout === null)
    return "sets no timeout-minutes, so it runs to GitHub's 360-minute default past deadline_at";
  if (typeof timeout === "string" && FROM_DEADLINE.test(timeout.trim())) return undefined;
  return `sets timeout-minutes ${typeof timeout === "string" ? timeout : JSON.stringify(timeout)}, which does not read the ${DEADLINE_INPUT} input through fromJSON`;
};

/**
 * The runner workflow's findings. FD-EXEC-091: one failure per job whose `GITHUB_TOKEN` may hold any permission but
 * `id-token: write`; a job's permissions are its own `permissions`, else the workflow's, and a job with neither runs at
 * the repository's default permissions and fails. FD-EXEC-087: one failure when the `workflow_dispatch` trigger
 * declares no `deadline_minutes` input, and one per job whose `timeout-minutes` is not
 * `${{ fromJSON(inputs.deadline_minutes) }}` or `${{ fromJSON(github.event.inputs.deadline_minutes) }}`. `text` is
 * `null` when the runner repository holds no such file.
 */
export const runnerWorkflowCheck = async (
  runnerRepo: string,
  workflow: string,
  text: string | null,
): Promise<readonly Finding[]> => {
  const where = `${runnerRepo}/${runnerWorkflowPath(workflow)}`;
  if (text === null) return [fail(PATH, `${where} does not exist`)];
  const { parseDocument } = await import("yaml");
  const document = parseDocument(text);
  if (document.errors.length > 0)
    return [fail(PATH, `${where} is not valid YAML: ${document.errors[0]!.message}`)];
  const parsed: unknown = document.toJS();
  const jobs = isRecord(parsed) ? parsed["jobs"] : undefined;
  if (!isRecord(jobs) || Object.keys(jobs).length === 0)
    return [fail(PATH, `${where} declares no jobs`)];
  const root = parsed as Record<string, unknown>;
  const workflowPermissions = root["permissions"];
  const input = declaresDeadlineInput(root["on"])
    ? []
    : [
        fail(
          `${PATH}.on.workflow_dispatch.inputs.${DEADLINE_INPUT}`,
          `${where}: the workflow_dispatch trigger declares no ${DEADLINE_INPUT} input, which carries the minutes until deadline_at`,
        ),
      ];
  return [
    ...input,
    ...Object.entries(jobs).flatMap(([name, job]) => {
      const own = isRecord(job) ? job["permissions"] : undefined;
      const excess = excessOf(own ?? workflowPermissions);
      const path = `${PATH}.jobs.${name}.permissions`;
      const permissions =
        excess === undefined
          ? [
              fail(
                path,
                `${where}: job ${name} sets no permissions, so its GITHUB_TOKEN holds the repository's default permissions; grant it only id-token: write`,
              ),
            ]
          : excess.length === 0
            ? []
            : [
                fail(
                  path,
                  `${where}: job ${name} grants its GITHUB_TOKEN ${excess.join(", ")}; grant it only id-token: write`,
                ),
              ];
      const problem = timeoutProblem(isRecord(job) ? job["timeout-minutes"] : undefined);
      const timeout =
        problem === undefined
          ? []
          : [
              fail(
                `${PATH}.jobs.${name}.timeout-minutes`,
                `${where}: job ${name} ${problem}; set it to \${{ fromJSON(inputs.${DEADLINE_INPUT}) }}`,
              ),
            ];
      return [...permissions, ...timeout];
    }),
  ];
};
