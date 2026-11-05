import {
  cacheNamespaces,
  executionNamespace,
  protectedCloud,
  pullRequestNamespace,
} from "@fractalboxdev/flare-dispatch-cache";
import type { IntakeRecord } from "@fractalboxdev/flare-dispatch-intake";
import { describe, expect, it } from "vitest";
import { cacheExecutionOf } from "../src/cache-execution.ts";

const record = (cacheTrigger: IntakeRecord["cacheTrigger"]): IntakeRecord => ({
  executionId: "e-1",
  trigger: "webhook",
  run: "check",
  label: null,
  repo: "Acme/App",
  sha: "a".repeat(40),
  ref: "refs/heads/main",
  inputs: {},
  deadlineAtMs: 0,
  className: "required",
  labels: [],
  attempt: 1,
  familyRoot: "e-1",
  installation: null,
  caller: null,
  notBefore: null,
  spendLine: null,
  placementConstraint: null,
  cacheTrigger,
  eligibleKinds: null,
  createdAt: 0,
});

describe("the cache execution of an intake record", () => {
  it("[FD-CACHE-019] a pull request's execution writes its own pr/<repo>/<number> namespace", () => {
    const pr = cacheExecutionOf(record({ _tag: "PullRequest", number: 41 }));
    for (const kind of ["cloudflare", "aws", "device"] as const)
      expect(cacheNamespaces(pr, kind).write).toBe(pullRequestNamespace("acme/app", 41));
    // FD-CACHE-021: on `gha` the execution writes its own execution namespace.
    expect(cacheNamespaces(pr, "gha").write).toBe(executionNamespace("acme/app", "e-1"));
  });

  it("[FD-CACHE-017] a push to the default branch writes the protected-cloud tier on a cloud executor", () => {
    const push = cacheExecutionOf(
      record({ _tag: "Push", ref: "refs/heads/main", protected: true }),
    );
    expect(cacheNamespaces(push, "cloudflare").write).toBe(protectedCloud("acme/app"));
    const other = cacheExecutionOf(record({ _tag: "Other" }));
    expect(cacheNamespaces(other, "cloudflare").write).toBeNull();
  });
});
