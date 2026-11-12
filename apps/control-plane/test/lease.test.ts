// The image a lease names, from the run's catalogue entry and the claiming executor's kind, the deadline a gate run's
// input carries, and the fields that name the execution.
import { CheckInput, lookupRun, type CatalogEntry } from "@fractalboxdev/flare-dispatch-catalog";
import type { IntakeRecord } from "@fractalboxdev/flare-dispatch-intake";
import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { gateInputs, imageDigestOf, NO_IMAGE, requestLeaseFields } from "../src/lease.ts";

const entry = (run: string): CatalogEntry => {
  const found = lookupRun("development", run);
  if (found._tag !== "Available") throw new Error(run);
  return found.entry;
};

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("a lease's image digest", () => {
  it("MAMEKO-EXEC-031 names no image for a host execution on a device", () => {
    expect(Effect.runSync(imageDigestOf(entry("check"), "device", undefined))).toBe(NO_IMAGE);
  });

  it("MAMEKO-EXEC-031 names the gate image by digest for a cloud lease", () => {
    expect(Effect.runSync(imageDigestOf(entry("check"), "cloudflare", DIGEST))).toBe(DIGEST);
    expect(Effect.runSync(imageDigestOf(entry("worker-deploy"), "device", DIGEST))).toBe(DIGEST);
  });

  it("MAMEKO-EXEC-031 fails a lease that needs the gate image on a deploy that pins none", () => {
    const exit = Effect.runSyncExit(imageDigestOf(entry("worker-deploy"), "cloudflare", "latest"));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("a lease's input", () => {
  const recorded = {
    repo: "https://github.com/o/r.git",
    sha: "a".repeat(40),
    ref: "refs/heads/main",
    steps: [{ label: "test", command: "pnpm test" }],
  };
  const deadlineAt = Date.UTC(2026, 10, 4, 13);

  it("[FD-GATE-007] carries the execution's deadline_at as a gate run's GateContext.deadlineAt", () => {
    const input = gateInputs(entry("check"), recorded, deadlineAt);
    expect(input).toEqual({ ...recorded, deadlineAt });
    expect(Schema.decodeUnknownSync(CheckInput)(input).deadlineAt).toBe(deadlineAt);
    expect(recorded).not.toHaveProperty("deadlineAt");
  });

  it("leaves an agentic run's input and a run outside the catalogue as recorded", () => {
    const agentic = lookupRun("development", "pr-review");
    if (agentic._tag !== "Available") throw new Error("pr-review");
    const input = { pr: 7 };
    expect(gateInputs(agentic.entry, input, deadlineAt)).toBe(input);
    expect(gateInputs(null, recorded, deadlineAt)).toBe(recorded);
  });
});

describe("the lease fields that name the execution", () => {
  const sha = "b".repeat(40);
  const record: IntakeRecord = {
    executionId: "e-1",
    trigger: "dispatch",
    run: "check",
    label: null,
    repo: "acme/app",
    sha,
    ref: "refs/pull/7/head",
    inputs: {
      repo: "https://github.com/acme/app.git",
      sha,
      ref: "refs/pull/7/head",
      steps: [{ label: "test", command: "pnpm test" }],
    },
    className: "required",
    labels: [],
    attempt: 1,
    familyRoot: "e-1",
    installation: 4242,
    caller: "operator@example.com",
    notBefore: null,
    spendLine: null,
    placementConstraint: null,
    cacheTrigger: { _tag: "PullRequest", number: 7 },
    eligibleKinds: null,
    repositoryPublic: null,
    inputAssociations: [],
    createdAt: 0,
  };
  const execution = { scope_id: "acme/app", deadline_at: Date.UTC(2026, 10, 4, 13) };

  it("[FD-PROF-063] names the repository as the scope id and carries the commit SHA among the inputs", () => {
    const fields = requestLeaseFields(entry("check"), record, execution);
    expect(fields.scope_id).toBe("acme/app");
    expect(fields.scope_id).toMatch(/^[^/]+\/[^/]+$/);
    expect(Schema.decodeUnknownSync(CheckInput)(fields.inputs).sha).toBe(sha);
  });

  it("[FD-PROF-063] carries the run registry's run version and workflow version", () => {
    const check = entry("check");
    const bumped: CatalogEntry = { ...check, workflowVersion: 3 };
    expect(requestLeaseFields(check, record, execution)).toMatchObject({
      run_version: check.spec.version,
      workflow_version: check.workflowVersion,
    });
    expect(requestLeaseFields(bumped, record, execution).workflow_version).toBe(3);
  });

  it("[FD-PROF-063] carries the request context intake recorded before admission", () => {
    expect(requestLeaseFields(entry("check"), record, execution).request_context).toEqual({
      trigger: "dispatch",
      ref: "refs/pull/7/head",
      installation: 4242,
      caller: "operator@example.com",
    });
    const webhook = { ...record, trigger: "webhook" as const, caller: null, ref: "refs/heads/main" };
    expect(requestLeaseFields(entry("check"), webhook, execution).request_context).toEqual({
      trigger: "webhook",
      ref: "refs/heads/main",
      installation: 4242,
      caller: null,
    });
  });
});
