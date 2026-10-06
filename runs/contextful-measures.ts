import { Effect, Schema } from "effect";
import {
  AcceptanceFailed,
  artifact,
  defineRun,
  github,
  sandbox,
  StepFailed,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import { workspace } from "@fractalboxdev/flare-dispatch-core/primitives";

const REPO = "fractalboxdev/contextful";
const BRANCH = "main";
const MEASURE_COMMAND = "cargo run --locked -q -p contextful-ci -- measure --tier all";
const REPORT_FILE = "measure-report.json";
const Input = Schema.Struct({
  repo: Schema.String,
  ref: Schema.String,
  firedAt: Schema.Number,
});
const Output = Schema.Struct({
  commit: Schema.String,
  exitCode: Schema.Number,
  reportUrl: Schema.String,
});

/** Build the JSON record in the container, preserving failed-tier results. */
const reportCommand = `node -e 'const fs=require("node:fs"); const path=require("node:path"); const dir="target/evaluate/records"; const records=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith(".json")).sort().map(n=>JSON.parse(fs.readFileSync(path.join(dir,n),"utf8"))):[]; fs.writeFileSync("${REPORT_FILE}",JSON.stringify({commit:process.env.MEASURE_COMMIT,run_id:process.env.MEASURE_RUN_ID,run_attempt:1,exit_code:Number(process.env.MEASURE_EXIT),records})+"\\n");'`;

export const contextfulMeasures = defineRun({
  name: "contextful-measures",
  version: "1.0.0",
  schedules: [
    {
      cron: "17 2 * * *",
      idempotencyKey: ({ firedAt }) =>
        `contextful-measures:${new Date(firedAt).toISOString().slice(0, 10)}`,
      inputs: ({ firedAt }) => ({ repo: REPO, ref: `refs/heads/${BRANCH}`, firedAt }),
    },
  ],
  serialize: (input) => ({
    group: `${input.repo}:measures-history`,
    revision: String(input.firedAt),
  }),
  inputs: Input,
  outputs: Output,
  limits: { maxDurationSec: 7200 },
  run: (input) =>
    Effect.gen(function* () {
      if (input.repo !== REPO || input.ref !== `refs/heads/${BRANCH}`) {
        return yield* Effect.fail(
          new StepFailed({
            step: "scope",
            cause: "measures target must be the Contextful default branch",
          }),
        );
      }
      // Resolve HEAD at execution time; a cron tick has no GitHub event SHA.
      const commit = yield* step("resolve-head", () =>
        github.branchHead({ repo: REPO, branch: BRANCH }),
      );
      const ws = yield* step("checkout", () => workspace({ repo: REPO, sha: commit }));
      const measured = yield* step(
        "measure",
        () =>
          sandbox.exec({
            container: ws.container,
            cwd: ws.dir,
            command: MEASURE_COMMAND,
            timeoutSec: 6000,
          }),
        { timeoutSec: 6100, retries: 0 },
      );
      // A red tier still gets a note. Only report construction or note writing
      // prevents history from being attached.
      const report = yield* step("build-report", () =>
        sandbox.exec({
          container: ws.container,
          cwd: ws.dir,
          command: reportCommand,
          env: {
            MEASURE_COMMIT: commit,
            MEASURE_RUN_ID: `contextful-measures:${input.firedAt}`,
            MEASURE_EXIT: String(measured.exitCode),
          },
          timeoutSec: 60,
        }),
      );
      if (report.exitCode !== 0) {
        return yield* Effect.fail(new StepFailed({ step: "build-report", cause: report.stderr }));
      }
      const reportPath = `${ws.dir}/${REPORT_FILE}`;
      const reportUrl = yield* step("upload-report", () =>
        artifact.upload({
          name: REPORT_FILE,
          path: reportPath,
          container: ws.container,
          contentType: "application/json",
          signedUrlTTL: "30 days",
        }),
      );
      const reportText = yield* step("read-report", () =>
        sandbox
          .readFile({ path: reportPath, container: ws.container })
          .pipe(
            Effect.catchTag("ReadFileFailed", (error) =>
              Effect.fail(new StepFailed({ step: "read-report", cause: error.message })),
            ),
          ),
      );
      yield* step("append-note", () =>
        github.appendMeasureNote({
          repo: REPO,
          commit,
          text: reportText.trim(),
        }),
      );
      if (measured.exitCode !== 0) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: measured.exitCode,
            summaryMd: `Measures exited ${measured.exitCode}; the report is attached to ${commit} under refs/notes/measures.`,
          }),
        );
      }
      return { commit, exitCode: measured.exitCode, reportUrl };
    }),
});
