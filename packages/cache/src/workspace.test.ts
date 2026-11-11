// The control plane's side of the workspace rule, and the check the runner's own suite runs against its start
// record. The runner itself is mameko's and is not exercised here.
import { describe, expect, it } from "vitest";
import { leaseCacheFields } from "./lease.ts";
import { parseCacheObjectPath } from "./presign.ts";
import { checkWorkspaceStart, grantCarriesNoWorkspace, workspacePlan } from "./workspace.ts";

const execution = {
  repo: "acme/widgets",
  executionId: "e-1",
  class: "interactive",
  constraints: [],
  trigger: { _tag: "PullRequest" as const, number: 7 },
};

describe("workspace rule", () => {
  it("[FD-CACHE-002] nothing the control plane hands an executor can carry a checkout, workspace or build output", async () => {
    for (const executorKind of ["cloudflare", "aws", "device", "gha"]) {
      const { upload_grant } = await leaseCacheFields(execution, { epoch: 3, executorKind, deadlineAt: 10 }, { publicOrigin: "https://ci.example.com", tokenSecret: "s" });
      expect(grantCarriesNoWorkspace(upload_grant, "e-1", 3)).toBe(true);
      expect(JSON.stringify(upload_grant)).not.toMatch(/workspace|checkout|target\//);
    }
    // The presigner's object grammar admits no path outside a cache entry's writer directory.
    for (const key of ["workspace/e-1/src.tar", "cache/pr/acme/widgets/7", "checkout/e-1"])
      expect(parseCacheObjectPath(key)).toBeUndefined();
    expect(checkWorkspaceStart({ epoch: 1, entriesAtStart: 0, fetchedCommit: true, placed: [{ path: "/w/repo", source: "transfer" }] })).toEqual([
      "FD-CACHE-002: /w/repo was transferred from another executor",
    ]);
  });

  it("[FD-CACHE-003] an epoch above 1 starts from an empty workspace and fetches the commit again", () => {
    expect(workspacePlan()).toMatchObject({ emptyWorkspace: true, fetchCommit: true });
    expect(checkWorkspaceStart({ epoch: 2, entriesAtStart: 0, fetchedCommit: true, placed: [{ path: "~/.cache/uv", source: "dependency" }] })).toEqual([]);
    expect(checkWorkspaceStart({ epoch: 2, entriesAtStart: 4, fetchedCommit: false, placed: [] })).toEqual([
      "FD-CACHE-003: epoch 2 started with 4 workspace entries",
      "FD-CACHE-003: epoch 2 did not fetch the commit",
    ]);
  });
});
