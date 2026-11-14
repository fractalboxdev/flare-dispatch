// The committed run-definition digests (`run-digests.json`) are each catalogue run's, so a lease's `run_digest` names
// the run the device runner holds and the runner accepts it (MAMEKO-EXEC-147).
import { readFileSync } from "node:fs";
import { runDefinitionDigest } from "@fractalboxdev/mameko-run";
import { describe, expect, it } from "vitest";
import { RUN_DIGESTS_PATH, runDigestsText } from "./generate-run-digests.ts";
import { registry } from "./runs.ts";

describe("the committed run-definition digests", () => {
  it("hold each catalogue run's digest, as `gen:run-digests` writes them", async () => {
    expect(readFileSync(RUN_DIGESTS_PATH, "utf8")).toBe(await runDigestsText());
    const committed = JSON.parse(readFileSync(RUN_DIGESTS_PATH, "utf8")) as Record<string, string>;
    expect(Object.keys(committed).sort()).toEqual(registry.map((r) => r.spec.name).sort());
    for (const run of registry)
      expect(committed[run.spec.name], run.spec.name).toBe(await runDefinitionDigest(run.definition));
  });
});
