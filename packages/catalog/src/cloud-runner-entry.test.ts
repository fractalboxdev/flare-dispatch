// The run catalogue a Container pool's device executor serves: the cloud gate runs, with the Container as the job
// sandbox and the deploy ledger the control plane holds.
import { Readable, Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerMain } from "@fractalboxdev/mameko-runner";
import { describe, expect, it } from "vitest";
import { cloudRuns, runs } from "./cloud-runner-entry.ts";
import RUN_DIGESTS from "./run-digests.json" with { type: "json" };
import { registry } from "./runs.ts";
import { lookupRun } from "./spec.ts";

const names = (served: readonly { readonly spec: { readonly name: string } }[]) =>
  served.map((r) => r.spec.name);

describe("the Container pool's run catalogue", () => {
  it("serves worker-deploy and sandbox-image, the cloud runs that need only the gate services, under both deployments", () => {
    expect(names(cloudRuns("production"))).toEqual(["worker-deploy", "sandbox-image"]);
    expect(names(cloudRuns("development"))).toEqual(["worker-deploy", "sandbox-image"]);
    expect(names(runs)).toEqual(["worker-deploy", "sandbox-image"]);
    for (const run of runs) {
      const found = lookupRun("production", run.spec.name);
      expect(found._tag === "Available" && found.entry.executors, run.spec.name).toContain("cloud");
      // Each run carries the cloud gate Layers, not the registry's unprovided Layer.
      expect(run.layer).not.toBe(registry.find((r) => r.spec.name === run.spec.name)?.layer);
    }
  });

  it("serves no agentic recipe, no scan run and no host execution, so a lease for one answers RunNotInCatalog", async () => {
    const cloudOnly = registry
      .map((r) => r.spec.name)
      .filter((name) => {
        const found = lookupRun("production", name);
        return found._tag === "Available" && found.entry.executors.includes("cloud");
      });
    const absent = cloudOnly.filter((name) => !names(runs).includes(name));
    expect(absent).toContain("pr-review");
    expect(absent).toContain("security-gate");
    expect(absent).toContain("security-rescan");
    for (const name of ["check", "oxlint", "gate-job"])
      expect(names(cloudRuns("development"))).not.toContain(name);

    const journal = mkdtempSync(join(tmpdir(), "fd-cloud-entry-"));
    try {
      for (const run of ["pr-review", "security-gate"]) {
        const lines: string[] = [];
        const code = await runnerMain({
          runs,
          argv: ["--journal", join(journal, `${run}.sqlite`)],
          stdin: Readable.from([
            `${JSON.stringify({
              execution_id: "01J",
              epoch: 1,
              run,
              run_digest: (RUN_DIGESTS as Record<string, string>)[run],
              scope_id: "acme/app",
            })}\n`,
          ]),
          stdout: new Writable({
            write: (chunk, _encoding, done) => (lines.push(String(chunk)), done()),
          }),
        });
        expect(code, run).toBe(2);
        expect(JSON.parse(lines.join("")), run).toEqual({
          type: "runner.refused",
          reason: "RunNotInCatalog",
        });
      }
    } finally {
      rmSync(journal, { recursive: true, force: true });
    }
  });
});
