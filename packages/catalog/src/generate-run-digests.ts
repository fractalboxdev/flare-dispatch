// Writes `run-digests.json`: each catalogue run's run-definition digest, the `run_digest` a lease names and the runner
// checks against the run it holds (MAMEKO-EXEC-148). The control plane reads the file, since the run modules import the
// runner's process code, which a Worker cannot load. `pnpm --filter @fractalboxdev/flare-dispatch-catalog
// gen:run-digests` runs it; `run-digests.test.ts` fails when the committed file differs.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runDefinitionDigest } from "@fractalboxdev/mameko-run";
import { registry } from "./runs.ts";

export const RUN_DIGESTS_PATH = fileURLToPath(new URL("./run-digests.json", import.meta.url));

/** Each catalogue run's name and run-definition digest, sorted by name, as the committed file holds them. */
export const runDigestsText = async (): Promise<string> => {
  const entries = await Promise.all(
    registry.map(async (run) => [run.spec.name, await runDefinitionDigest(run.definition)] as const),
  );
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
};

if (import.meta.url === `file://${process.argv[1]}`) writeFileSync(RUN_DIGESTS_PATH, await runDigestsText());
