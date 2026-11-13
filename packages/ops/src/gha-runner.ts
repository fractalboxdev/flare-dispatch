// The drift check's read of the GitHub Actions launcher's runner workflow (specs/executors.md § The GitHub Actions
// launcher): for a deploy whose overlay carries the `gha` kind, the workflow file `gha.workflow` in the runner
// repository `gha.runnerRepo` must grant each job's `GITHUB_TOKEN` no permission except `id-token: write`
// (FD-EXEC-091). The check is a function of the file's text alone; `fd deploy` and `fd doctor` read it through
// `DeployTarget.runnerWorkflow`. The YAML parser loads on the check's first call, so a bundle that imports the ops
// root without running the drift check (the control-plane Worker) carries no parser.
import type { Finding } from "./drift.ts";

const CHECK = "gha-runner";
const PATH = "gha.workflow";

/** The one permission the runner job's token may hold: the Actions OIDC token it claims its lease with. */
const ALLOWED = "id-token";

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
  "the overlay carries the gha kind and sets no gha.runnerRepo or gha.workflow, so the runner workflow's permissions cannot be checked",
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

/**
 * The runner workflow's findings (FD-EXEC-091): one failure per job whose `GITHUB_TOKEN` may hold any permission but
 * `id-token: write`. A job's permissions are its own `permissions`, else the workflow's; a job with neither runs at the
 * repository's default permissions and fails. `text` is `null` when the runner repository holds no such file.
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
  const workflowPermissions = (parsed as Record<string, unknown>)["permissions"];
  return Object.entries(jobs).flatMap(([name, job]) => {
    const own = isRecord(job) ? job["permissions"] : undefined;
    const excess = excessOf(own ?? workflowPermissions);
    const path = `${PATH}.jobs.${name}.permissions`;
    if (excess === undefined)
      return [
        fail(
          path,
          `${where}: job ${name} sets no permissions, so its GITHUB_TOKEN holds the repository's default permissions; grant it only id-token: write`,
        ),
      ];
    return excess.length === 0
      ? []
      : [
          fail(
            path,
            `${where}: job ${name} grants its GITHUB_TOKEN ${excess.join(", ")}; grant it only id-token: write`,
          ),
        ];
  });
};
