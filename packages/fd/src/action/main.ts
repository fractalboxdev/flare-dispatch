// The action's entry: reads the step's inputs and the runner's environment, runs the dispatch, appends the outputs to
// `$GITHUB_OUTPUT`, and fails the step with the error code (FD-IFC-058, FD-IFC-060).
import { appendFileSync } from "node:fs";
import { Effect } from "effect";
import { inputsFrom, runAction } from "./run.ts";

const writeOutputs = (path: string | undefined, outputs: Readonly<Record<string, string>>) => {
  const lines = Object.entries(outputs)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("");
  if (path !== undefined && path !== "") appendFileSync(path, lines);
};

const env = process.env;
void Effect.runPromise(
  runAction(
    inputsFrom(env),
    { url: env["ACTIONS_ID_TOKEN_REQUEST_URL"], token: env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] },
    globalThis.fetch,
    (line) => Effect.sync(() => console.log(line)),
  ).pipe(
    Effect.match({
      onSuccess: ({ outputs }) => {
        writeOutputs(env["GITHUB_OUTPUT"], outputs);
        return 0;
      },
      onFailure: (failure) => {
        writeOutputs(env["GITHUB_OUTPUT"], failure.outputs ?? {});
        console.log(`::error::${failure.code}: ${failure.message}`);
        return 1;
      },
    }),
  ),
).then((code) => {
  process.exitCode = code;
});
