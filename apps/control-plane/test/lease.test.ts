// The image a lease names, from the run's catalogue entry and the claiming executor's kind, the deadline a gate run's
// input carries, the fields that name the execution, and the nonce bound to the execution and epoch.
import { CheckInput, lookupRun, type CatalogEntry } from "@fractalboxdev/flare-dispatch-catalog";
import type { IntakeRecord } from "@fractalboxdev/flare-dispatch-intake";
import { sqliteD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  gateInputs,
  imageDigestOf,
  invalidateLeaseNonce,
  issuedLeaseNonce,
  leaseNonce,
  NO_IMAGE,
  requestLeaseFields,
} from "../src/lease.ts";

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
    const webhook = {
      ...record,
      trigger: "webhook" as const,
      caller: null,
      ref: "refs/heads/main",
    };
    expect(requestLeaseFields(entry("check"), webhook, execution).request_context).toEqual({
      trigger: "webhook",
      ref: "refs/heads/main",
      installation: 4242,
      caller: null,
    });
  });
});

describe("a lease's nonce", () => {
  const T = Date.UTC(2026, 10, 12);

  it("[FD-PROV-010] issues 128 random bits bound to the execution_id and the epoch", async () => {
    const db = sqliteD1();
    const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
    const nonce = await run(leaseNonce(db, "e-1", 3, T));
    // 16 bytes as hex: exactly 128 bits.
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    // The nonce is stored against the pair, and only that pair answers it.
    expect(await run(issuedLeaseNonce(db, "e-1", 3))).toBe(nonce);
    expect(await run(issuedLeaseNonce(db, "e-1", 4))).toBeNull();
    expect(await run(issuedLeaseNonce(db, "e-2", 3))).toBeNull();
    expect(db.sqlite.prepare("select execution_id, epoch, nonce from lease_nonces").all()).toEqual([
      { execution_id: "e-1", epoch: 3, nonce },
    ]);
    // A repeated grant at the same epoch carries the nonce already issued for it.
    expect(await run(leaseNonce(db, "e-1", 3, T + 1))).toBe(nonce);
    // Every other (execution, epoch) draws its own.
    const drawn = new Set([nonce]);
    for (let i = 0; i < 64; i++) drawn.add(await run(leaseNonce(db, `e-${i + 10}`, 1, T)));
    expect(drawn.size).toBe(65);
  });

  it("[FD-PROV-011] a reclaim invalidates the previous epoch's nonce and the next epoch's grant issues a fresh one", async () => {
    const db = sqliteD1();
    const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
    const first = await run(leaseNonce(db, "e-1", 1, T));
    await run(invalidateLeaseNonce(db, "e-1", 1, T + 1));
    expect(await run(issuedLeaseNonce(db, "e-1", 1))).toBeNull();
    // The reclaimed epoch's lease is never granted again with its nonce.
    expect(
      await Effect.runPromise(
        leaseNonce(db, "e-1", 1, T + 2).pipe(
          Effect.map(() => "granted"),
          Effect.catchTag("LeaseNonceInvalidated", () => Effect.succeed("refused")),
        ),
      ),
    ).toBe("refused");
    const second = await run(leaseNonce(db, "e-1", 2, T + 3));
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
    expect(await run(issuedLeaseNonce(db, "e-1", 2))).toBe(second);
    // Another execution's nonce is untouched by this one's reclaim.
    const other = await run(leaseNonce(db, "e-2", 1, T));
    await run(invalidateLeaseNonce(db, "e-1", 2, T + 4));
    expect(await run(issuedLeaseNonce(db, "e-2", 1))).toBe(other);
  });

  it("[FD-PROV-011] a grant at a later epoch invalidates every earlier epoch's nonce of the execution", async () => {
    const db = sqliteD1();
    const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
    await run(leaseNonce(db, "e-1", 1, T));
    await run(leaseNonce(db, "e-1", 2, T + 1));
    const third = await run(leaseNonce(db, "e-1", 5, T + 2));
    expect(await run(issuedLeaseNonce(db, "e-1", 1))).toBeNull();
    expect(await run(issuedLeaseNonce(db, "e-1", 2))).toBeNull();
    expect(await run(issuedLeaseNonce(db, "e-1", 5))).toBe(third);
  });
});
