// The failure summary source under the repository's confidentiality mode (FD-IFC-045): a `confidential-compute`
// repository's pack names the failing step without reading its log, and the route reads the mode it strips by.
import { FailureSummaries, type ExecutionRecord } from "@fractalboxdev/flare-dispatch-api";
import { logObjectName, stepKey } from "@fractalboxdev/flare-dispatch-cache";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { CacheEnv } from "../src/cache.ts";
import type { ControlPlaneEnv } from "../src/config.ts";
import { failureSummaries } from "../src/failure-summary.ts";

const REPO = "Acme/App";

const execution: ExecutionRecord = {
  execution_id: "e-failed",
  run: "check",
  repository: REPO,
  class: "batch",
  status: "done",
  verdict: "failure",
  reason: "exit 1",
  conclusion: "failure",
  advisory: false,
  placement: "accepted",
  executor_id: "dev-7",
  executor_kind: "device",
  epoch: 1,
  accepted_epoch: 1,
  reserved_micro_usd: 0,
  settled_micro_usd: 0,
  enqueued_at: 1,
  finished_at: 2,
  dispatchedBy: null,
};

/** A bucket holding one log segment of `step:build`, counting the object bodies it serves. */
const bucketWithLog = async () => {
  const name = await logObjectName({
    executionId: execution.execution_id,
    epoch: 1,
    journalName: "step:build",
    stream: "stdout",
    start: 0,
    end: 1,
  });
  const body = `${JSON.stringify({ line: "the build's private output in src/secret.ts" })}\n`;
  const reads: string[] = [];
  return {
    reads,
    bucket: {
      list: async ({ prefix }: { prefix?: string }) => ({
        objects: name!.startsWith(prefix ?? "") ? [{ key: name!, uploaded: new Date(1) }] : [],
        truncated: false,
      }),
      get: async (key: string) => {
        reads.push(key);
        return key === name ? { text: async () => body } : null;
      },
    },
  };
};

/** A development deployment whose captured repository, `Acme/App`, has the given confidentiality mode. */
const envOf = (confidentiality: string, bucket: unknown) =>
  ({
    DEPLOYMENT: "development",
    FD_DEV_REPOSITORY: JSON.stringify({
      repository: REPO,
      installation: 1,
      default_branch: "main",
      head: "a".repeat(40),
      files: {},
      confidentiality,
    }),
    CACHE: bucket,
  }) as unknown as ControlPlaneEnv & CacheEnv;

const summaryUnder = async (confidentiality: string) => {
  const { bucket, reads } = await bucketWithLog();
  const { mode, pack } = await Effect.runPromise(
    FailureSummaries.use((s) =>
      Effect.all({ mode: s.confidentiality(REPO), pack: s.pack(execution) }),
    ).pipe(Effect.provide(failureSummaries(envOf(confidentiality, bucket)))),
  );
  return { mode, pack, reads };
};

describe("the failure summary under the repository's confidentiality mode", () => {
  it("[FD-IFC-045] a confidential-compute repository's pack names the failing step and reason, reads no log content, and reports the mode", async () => {
    const { mode, pack, reads } = await summaryUnder("confidential-compute");
    expect(mode).toBe("confidential-compute");
    expect(reads).toEqual([]);
    expect(pack).toEqual({
      contractVersion: "v1",
      incidentId: execution.execution_id,
      class: "ci",
      repo: REPO,
      ciFailures: [
        { kind: "run-step", name: `check/${await stepKey("step:build")}`, conclusion: "exit 1" },
      ],
    });
    // A repository of any other mode carries the failing step's log tail.
    for (const other of ["non-confidential", "unclassified", "confidential-model"]) {
      const open = await summaryUnder(other);
      expect(open.mode).toBe(other);
      expect(open.pack.ciFailures?.[0]?.logTail).toContain("private output");
    }
  });
});
