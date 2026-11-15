// One gate run through mameko's `defineRun`, with its body beside the definition. This module imports no process or
// file API, so the control plane's Worker defines the `control` pool's runs with it.
import { defineRun } from "@fractalboxdev/mameko-run";
import { Effect } from "effect";
import { toRunResult } from "./reasons.ts";
import { classRanks, type RunSpecFields } from "./spec.ts";

/**
 * One gate run through `defineRun`, with its body beside the definition, so an executor whose services depend on the
 * lease builds them inside each execution around the same body.
 */
export const defineGateRun = <I extends Parameters<typeof defineRun>[0]["input"], R>(
  spec: RunSpecFields,
  input: I,
  body: (input: I["Type"]) => Effect.Effect<Parameters<typeof toRunResult>[0], never, R>,
) => {
  const run = (i: I["Type"]) => body(i).pipe(Effect.map(toRunResult));
  return {
    ...defineRun(
      {
        ...spec,
        input,
        requires: [...spec.requires],
        labels: [...spec.labels],
        constraints: [...spec.constraints],
        grants: { setup: [...spec.grants.setup], agent: [...spec.grants.agent] },
        outputPaths: [...spec.outputPaths],
        intentKinds: [...spec.intentKinds],
      },
      run,
      { classRanks },
    ),
    body: run,
  };
};
