import { type Actuator, Actuators, type IntentRow } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ANNOTATION_BATCH, CheckRunApplierLive } from "./applier.ts";
import { GithubHttpError, GithubNetworkError } from "./client.ts";
import {
  conclusionFactsOf,
  type ConclusionFacts,
  type ExecutionRecordFacts,
} from "./conclude-facts.ts";
import {
  checkConclusion,
  OUTPUT_LIMIT,
  PARENT_CLOSED,
  verdictOf,
  type Verdict,
} from "./conclusion.ts";
import { fakeGithub, fakeLayers, row, type FakeGithub } from "./fake.test-support.ts";

const ref = {
  name: "flare-dispatch/check",
  head_sha: "abc123",
  details_url: "https://logs.example/x",
};
const details = {
  class: "required",
  executor_kind: "cloudflare",
  placement_reason: "cloud entry won",
  queue_age_ms: 4000,
  reserved_micro_usd: 20_000,
  settled_micro_usd: 12_000,
};

const withApplier = <A>(gh: FakeGithub, f: (applier: Required<Actuator>) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        return yield* f((yield* Actuators).get("checkRun") as Required<Actuator>);
      }),
      CheckRunApplierLive.pipe(Layer.provide(fakeLayers(gh))),
    ),
  );
const apply = (gh: FakeGithub, r: IntentRow) => withApplier(gh, (a) => a.apply(r));
const lookup = (gh: FakeGithub, r: IntentRow) => withApplier(gh, (a) => a.lookup(r));
const reconcile = (gh: FakeGithub, r: IntentRow) => withApplier(gh, (a) => a.reconcile(r));

const opened = async () => {
  const gh = fakeGithub();
  await apply(gh, row("check.open", ref));
  gh.calls.length = 0;
  return gh;
};

describe("check.open", () => {
  it("[FD-GH-005] [FD-GH-009] creates the check run queued on the head SHA with external_id = execution id", async () => {
    const gh = fakeGithub();
    expect(await apply(gh, row("check.open", ref))).toEqual({
      _tag: "applied",
      externalRef: "1000",
    });
    expect(gh.runs).toMatchObject([{ name: ref.name, external_id: "exec-1", status: "queued" }]);
  });

  it("[FD-GH-010] MAMEKO-OUT-024 lookup adopts the check run an earlier attempt created", async () => {
    const gh = await opened();
    expect(await lookup(gh, row("check.open", ref))).toEqual({
      _tag: "found",
      externalRef: "1000",
    });
  });

  it("[FD-GH-010] a repeated apply finds the existing check run instead of creating a second", async () => {
    const gh = await opened();
    expect(await apply(gh, row("check.open", ref))).toEqual({
      _tag: "applied",
      externalRef: "1000",
    });
    expect(gh.runs).toHaveLength(1);
    expect(gh.calls).toEqual(["list"]);
  });

  it("[FD-GH-010] every apply searches by external_id before it creates", async () => {
    const gh = fakeGithub();
    await apply(gh, row("check.open", ref));
    expect(gh.calls).toEqual(["list", "create"]);
  });

  it("MAMEKO-OUT-024 lookup answers absent when no attempt reached GitHub", async () => {
    expect(await lookup(fakeGithub(), row("check.open", ref))).toEqual({
      _tag: "absent",
    });
  });

  it("MAMEKO-OUT-025 a lookup that cannot read answers undetermined, not absent", async () => {
    const gh = await opened();
    gh.failures.push(
      new GithubHttpError({ status: 502, message: "bad gateway", rateLimited: false }),
    );
    expect(await lookup(gh, row("check.open", ref))).toEqual({
      _tag: "undetermined",
      reason: "github 502: bad gateway",
    });
    expect(gh.calls).toEqual(["list"]);
    gh.failures.push(new GithubNetworkError({ sent: false, message: "dns" }));
    expect((await lookup(gh, row("check.open", ref)))._tag).toBe("undetermined");
  });

  it("MAMEKO-OUT-025 two check runs carrying the execution id answer undetermined", async () => {
    const gh = await opened();
    gh.runs.push({ ...gh.runs[0]!, id: 1001 });
    expect(await lookup(gh, row("check.open", ref))).toEqual({
      _tag: "undetermined",
      reason: "check run: 2 carry the execution id",
    });
  });

  it("MAMEKO-OUT-022, MAMEKO-OUT-024 a repeated apply searches by external_id first and works on the oldest check run", async () => {
    const gh = await opened();
    gh.runs.push({ ...gh.runs[0]!, id: 999 });
    expect(await apply(gh, row("check.open", ref))).toEqual({
      _tag: "applied",
      externalRef: "999",
    });
    expect(gh.calls).toEqual(["list"]);
    expect(gh.runs).toHaveLength(2);
  });
});

describe("check.start and check.progress", () => {
  const start = { ...ref, epoch: 2, executor_kind: "device", attempt: 1 };
  const progress = { ...ref, class: "interactive", bucket: "2–5", deadline_at: 0 } as const;

  it("[FD-GH-011] check.start sets in_progress and names the executor kind and the epoch", async () => {
    const gh = await opened();
    expect(await apply(gh, row("check.start", start))).toEqual({
      _tag: "applied",
      externalRef: "1000",
    });
    expect(gh.runs[0]).toMatchObject({
      status: "in_progress",
      output: { summary: "Executor kind `device`, epoch 2." },
    });
    expect(await lookup(gh, row("check.start", start))).toEqual({
      _tag: "found",
      externalRef: "1000",
    });
    expect(await lookup(gh, row("check.start", { ...start, epoch: 3 }))).toEqual({
      _tag: "absent",
    });
  });

  it("[FD-GH-012] check.progress states the class, the queue-position bucket and the deadline", async () => {
    const gh = await opened();
    await apply(gh, row("check.progress", progress));
    expect(gh.runs[0]?.output.title).toBe("Queued: position 2–5");
    expect(gh.runs[0]?.output.summary).toContain("Class `interactive`");
    expect(gh.runs[0]?.output.summary).toContain("1970-01-01T00:00:00.000Z");
  });

  it("MAMEKO-OUT-044, MAMEKO-OUT-059, MAMEKO-OUT-060 neither applies after the check run concludes", async () => {
    const gh = await opened();
    await apply(
      gh,
      row("check.conclude", { ...ref, verdict: { _tag: "success" }, attempt: 1, details }),
    );
    for (const r of [row("check.start", start), row("check.progress", progress)])
      expect((await apply(gh, r))._tag).toBe("refused");
    expect(gh.runs[0]).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("MAMEKO-OUT-044, MAMEKO-OUT-059, MAMEKO-OUT-060 check.start before check.open is applied waits instead of creating", async () => {
    expect(await apply(fakeGithub(), row("check.start", start))).toEqual({
      _tag: "retryable",
      reason: "check run not open yet",
    });
  });
});

describe("check.conclude", () => {
  const conclude = (verdict: unknown, attempt = 1, extra: object = {}) =>
    row("check.conclude", { ...ref, verdict, attempt, details: { ...details, ...extra } });

  it("[FD-GH-014] [FD-GH-023] concludes with the conclusion and the reason in the title", async () => {
    const gh = await opened();
    await apply(
      gh,
      conclude({
        _tag: "failure",
        category: "budget",
        reason: "budget: required reserve exhausted",
      }),
    );
    expect(gh.runs[0]).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { title: "budget: required reserve exhausted" },
    });
  });

  it("[FD-GH-052] creates the check run completed when no check.open was applied", async () => {
    const gh = fakeGithub();
    expect((await apply(gh, conclude({ _tag: "cancelled", cause: "pr-closed" })))._tag).toBe(
      "applied",
    );
    expect(gh.runs).toMatchObject([
      { external_id: "exec-1", status: "completed", conclusion: "cancelled" },
    ]);
  });

  it("[FD-GH-008] appends the attempt to the title only after the first attempt", async () => {
    const gh = await opened();
    await apply(gh, conclude({ _tag: "success" }, 3));
    expect(gh.runs[0]?.output.title).toBe("success (attempt 3)");
  });

  it("[FD-GH-015] [FD-GH-016] the summary leads with the failing step, then class, executor, queue age, cost and reason", async () => {
    const gh = await opened();
    await apply(
      gh,
      conclude({ _tag: "failure", category: "finding", reason: "lint: 3 errors" }, 1, {
        failing_step: "oxlint",
        error_tag: "LintFailed",
        markdown: "run notes",
      }),
    );
    const lines = gh.runs[0]?.output.summary?.split("\n") ?? [];
    expect(lines[0]).toBe("**Failed step:** `oxlint` (LintFailed)");
    expect(lines).toContain("- Class: required");
    expect(lines).toContain("- Executor: cloudflare (cloud entry won)");
    expect(lines).toContain("- Queue age: 4 s");
    expect(lines).toContain("- Cost: reserved 0.020000 USD, settled 0.012000 USD");
    expect(lines).toContain("- Reason: lint: 3 errors");
    expect(lines.at(-1)).toBe("run notes");
  });

  it("[FD-GH-017] cuts a long summary to 65535 characters ending in a log-viewer link", async () => {
    const gh = await opened();
    await apply(gh, conclude({ _tag: "success" }, 1, { markdown: "x".repeat(70_000) }));
    const summary = gh.runs[0]?.output.summary ?? "";
    expect(summary).toHaveLength(OUTPUT_LIMIT);
    expect(summary.endsWith(ref.details_url)).toBe(true);
  });

  it("MAMEKO-OUT-024 lookup finds a conclusion already on the check run", async () => {
    const gh = await opened();
    await apply(gh, conclude({ _tag: "success" }));
    expect(await lookup(gh, conclude({ _tag: "success" }))).toEqual({
      _tag: "found",
      externalRef: "1000",
    });
  });
});

describe("check.conclude from mameko's outcome row", () => {
  const LOG = "https://fd.example.com/v1/executions/exec-1/logs?t=token";
  const facts = (overrides: Partial<ConclusionFacts> = {}): ConclusionFacts => ({
    name: ref.name,
    headSha: ref.head_sha,
    attempt: 1,
    detailsUrl: LOG,
    details,
    recorded: null,
    ...overrides,
  });
  const withFacts = (overrides: Partial<ConclusionFacts> = {}, id = "exec-1") => {
    const gh = fakeGithub();
    gh.facts.set(id, facts(overrides));
    return gh;
  };
  /** The row mameko's terminal write inserts: intent key `outcome`, payload `{ outcome }`. */
  const outcomeRow = (outcome: unknown, overrides: Partial<IntentRow> = {}) =>
    row("check.conclude", { outcome }, { intentKey: "outcome", ...overrides });

  it("[FD-GH-014] concludes each outcome with the conclusion checkConclusion returns for verdictOf(outcome)", async () => {
    const outcomes = [
      { _tag: "Success", epoch: 1 },
      { _tag: "Failure", reason: "lint: 3 errors", epoch: 1 },
      { _tag: "Failure", reason: "capacity: no executor", epoch: null },
      { _tag: "Cancelled", cause: "superseded" },
      { _tag: "Skipped", detail: "draft-pr", epoch: 1 },
      { _tag: "Deferred" },
      { _tag: "Expired" },
    ] as const;
    for (const outcome of outcomes) {
      const gh = withFacts({ recorded: verdictOf(outcome) });
      expect(await apply(gh, outcomeRow(outcome))).toEqual({
        _tag: "applied",
        externalRef: "1000",
      });
      const expected = checkConclusion(verdictOf(outcome));
      expect(gh.runs).toMatchObject([
        {
          name: ref.name,
          external_id: "exec-1",
          status: "completed",
          conclusion: expected.conclusion,
          output: { title: expected.title },
        },
      ]);
    }
  });

  it("[FD-GH-014] a lookup of the outcome row finds the conclusion already on the check run", async () => {
    const gh = withFacts();
    const r = outcomeRow({ _tag: "Failure", reason: "lint: 3 errors" });
    expect(await lookup(gh, r)).toEqual({ _tag: "absent" });
    await apply(gh, r);
    expect(await lookup(gh, r)).toEqual({ _tag: "found", externalRef: "1000" });
  });

  it("[FD-GH-014] an outcome row of an execution with no record is refused; an unreadable record is retried", async () => {
    const r = outcomeRow({ _tag: "Success" });
    expect(await apply(fakeGithub(), r)).toEqual({
      _tag: "refused",
      reason: "conclude: no record of the execution",
    });
    const down = withFacts();
    down.factsDown = true;
    expect(await apply(down, r)).toEqual({ _tag: "retryable", reason: "records: D1 unavailable" });
    expect(await lookup(down, r)).toEqual({
      _tag: "undetermined",
      reason: "records: D1 unavailable",
    });
    expect(down.calls).toEqual([]);
  });

  it("[FD-GH-008] every attempt concludes under the family's one name; only a later attempt's title names it", async () => {
    const gh = fakeGithub();
    gh.facts.set("exec-1", facts({ attempt: 1 }));
    gh.facts.set("exec-2", facts({ attempt: 2 }));
    await apply(gh, outcomeRow({ _tag: "Failure", reason: "lint: 3 errors" }));
    await apply(gh, outcomeRow({ _tag: "Success" }, { executionId: "exec-2" }));
    expect(gh.runs.map((r) => [r.name, r.external_id, r.output.title])).toEqual([
      [ref.name, "exec-1", "lint: 3 errors"],
      [ref.name, "exec-2", "success (attempt 2)"],
    ]);
  });

  it("[FD-GH-013] sets the details URL to the execution's tokened log link when it creates or concludes the check run", async () => {
    const created = withFacts();
    await apply(created, outcomeRow({ _tag: "Success" }));
    expect(created.detailsUrls.get(1000)).toBe(LOG);

    const updated = withFacts();
    await apply(updated, row("check.open", { name: ref.name, head_sha: ref.head_sha }));
    expect(updated.detailsUrls.get(1000)).toBeUndefined();
    await apply(updated, outcomeRow({ _tag: "Success" }));
    expect(updated.detailsUrls.get(1000)).toBe(LOG);
  });

  it("[FD-GH-015] the summary states the execution's class, executor, placement, queue age, costs and reason", async () => {
    const record: ExecutionRecordFacts = {
      name: ref.name,
      headSha: ref.head_sha,
      attempt: 1,
      className: "required",
      status: "failure",
      reason: "lint: 3 errors",
      enqueuedAt: 1_000,
      finishedAt: 90_000,
      placement: {
        admittedAt: 1_000,
        claimLatencyMs: 4_000,
        leasedKind: "cloudflare",
        acceptedKind: "cloudflare",
        executorId: "cf-pool-3",
        cloudWon: true,
      },
      reservation: { holdMicroUsd: 20_000, state: "settled", meteredMicroUsd: 12_000 },
    };
    const gh = fakeGithub();
    gh.facts.set("exec-1", conclusionFactsOf(record, LOG));
    await apply(gh, outcomeRow({ _tag: "Failure", reason: "lint: 3 errors" }));
    const lines = gh.runs[0]?.output.summary?.split("\n") ?? [];
    expect(lines).toEqual([
      "- Class: required",
      "- Executor: cloudflare (cloud entry won)",
      "- Queue age: 4 s",
      "- Cost: reserved 0.020000 USD, settled 0.012000 USD",
      "- Reason: lint: 3 errors",
    ]);
  });

  it("[FD-GH-015] an execution concluded before any lease states no executor and its whole wait", async () => {
    const base: ExecutionRecordFacts = {
      name: ref.name,
      headSha: ref.head_sha,
      attempt: 1,
      className: "batch",
      status: "deferred",
      reason: null,
      enqueuedAt: 1_000,
      finishedAt: 61_000,
      placement: null,
      reservation: null,
    };
    expect(conclusionFactsOf(base, undefined).details).toMatchObject({
      executor_kind: null,
      placement_reason: "not placed",
      queue_age_ms: 60_000,
      reserved_micro_usd: 0,
      settled_micro_usd: 0,
    });
    const queued = {
      ...base,
      placement: {
        admittedAt: 11_000,
        claimLatencyMs: null,
        leasedKind: null,
        acceptedKind: null,
        executorId: null,
        cloudWon: null,
      },
      reservation: { holdMicroUsd: 5_000, state: "held", meteredMicroUsd: null },
    };
    expect(conclusionFactsOf(queued, undefined).details).toMatchObject({
      placement_reason: "no lease granted",
      queue_age_ms: 50_000,
      reserved_micro_usd: 5_000,
      settled_micro_usd: 0,
    });
  });

  it("[FD-GH-031] a neutral conclusion over an execution that records another outcome pages neutral-invariant", async () => {
    const skip = { _tag: "Skipped", detail: "draft-pr", epoch: 1 } as const;
    const holds = withFacts({ recorded: verdictOf(skip) });
    await apply(holds, outcomeRow(skip));
    expect(holds.runs[0]?.conclusion).toBe("neutral");
    expect(holds.alarms).toEqual([]);

    const broken = withFacts({
      recorded: { _tag: "failure", category: "capacity", reason: "capacity: model unavailable" },
    });
    await apply(broken, outcomeRow(skip));
    expect(broken.runs[0]?.conclusion).toBe("neutral");
    expect(broken.alarms.map((a) => [a.name, a.severity, a.dedupeKey])).toEqual([
      ["neutral-invariant", "page", "neutral-invariant:exec-1"],
    ]);
  });

  it("[FD-GH-020] a child's cp:check:conclude row concludes with its verdict under the execution's own name", async () => {
    const failed: Verdict = { _tag: "failure", category: "infra", reason: "lint: 3 errors" };
    for (const verdict of [{ _tag: "success" } as const, failed, PARENT_CLOSED]) {
      const gh = withFacts({ name: "flare-dispatch/offload-test:j1" });
      const r = row("check.conclude", { verdict }, { intentKey: "cp:check:conclude" });
      expect(await apply(gh, r)).toEqual({ _tag: "applied", externalRef: "1000" });
      const expected = checkConclusion(verdict);
      expect(gh.runs).toMatchObject([
        {
          name: "flare-dispatch/offload-test:j1",
          external_id: "exec-1",
          status: "completed",
          conclusion: expected.conclusion,
          output: { title: expected.title },
        },
      ]);
    }
  });

  it("[FD-GH-020] the parent-ended cascade's outcome row concludes parent closed, not cancelled; another cancel stays cancelled", async () => {
    const cascade = withFacts({ recorded: { _tag: "cancelled", cause: "parent-ended" } });
    await apply(cascade, outcomeRow({ _tag: "Cancelled", cause: "parent-ended" }));
    expect(cascade.runs).toMatchObject([
      {
        status: "completed",
        conclusion: "failure",
        output: { title: "parent closed before this part settled" },
      },
    ]);

    const superseded = withFacts();
    await apply(superseded, outcomeRow({ _tag: "Cancelled", cause: "superseded" }));
    expect(superseded.runs).toMatchObject([
      { conclusion: "cancelled", output: { title: "superseded" } },
    ]);
  });

  const DIGEST = "sha256:feed";
  const statement = (status: "logged" | "log-pending") => ({
    envelope_digest: DIGEST,
    status,
    statement_url: `https://fd.example.com/v1/provenance/statements/${DIGEST}`,
    inclusion_proof_url:
      status === "logged" ? `https://fd.example.com/v1/provenance/proofs/${DIGEST}` : null,
    subjects: [],
  });
  const withStatement = (status: "logged" | "log-pending") => ({
    ...details,
    provenance: [statement(status)],
  });
  /** The `cp:check:provenance:<digest>` row of a statement logged after the conclusion. */
  const refreshRow = row(
    "check.conclude",
    { provenance_logged: DIGEST },
    { intentKey: `cp:check:provenance:${DIGEST}` },
  );

  it("[FD-GH-020] a provenance update of a child the parent-ended cascade cancelled keeps parent closed, not cancelled", async () => {
    const gh = withFacts({
      recorded: { _tag: "cancelled", cause: "parent-ended" },
      details: withStatement("log-pending"),
    });
    await apply(gh, outcomeRow({ _tag: "Cancelled", cause: "parent-ended" }));
    gh.facts.set(
      "exec-1",
      facts({
        recorded: { _tag: "cancelled", cause: "parent-ended" },
        details: withStatement("logged"),
      }),
    );
    expect(await apply(gh, refreshRow)).toEqual({ _tag: "applied", externalRef: "1000" });
    expect(gh.runs).toMatchObject([
      {
        status: "completed",
        conclusion: "failure",
        output: { title: "parent closed before this part settled" },
      },
    ]);
    expect(gh.runs[0]?.output.summary).toContain("logged, [inclusion proof]");
  });

  it("[FD-PROV-042] a provenance update whose write was lost is found only once the summary links the logged statement", async () => {
    const failed = { _tag: "Failure", reason: "lint: 3 errors" } as const;
    const gh = withFacts({ recorded: verdictOf(failed), details: withStatement("log-pending") });
    await apply(gh, outcomeRow(failed));
    expect(gh.runs[0]?.output.summary).toContain(": log-pending");
    gh.facts.set(
      "exec-1",
      facts({ recorded: verdictOf(failed), details: withStatement("logged") }),
    );

    // The list answers, then the update fails after it was sent: whether it reached GitHub is unknown.
    gh.failures.push(null, new GithubNetworkError({ sent: true, message: "reset" }));
    expect((await apply(gh, refreshRow))._tag).toBe("unknown");
    expect(gh.runs[0]?.output.summary).toContain(": log-pending");
    expect(await lookup(gh, refreshRow)).toEqual({ _tag: "absent" });
    expect(await reconcile(gh, refreshRow)).toEqual({ _tag: "absent" });

    expect(await apply(gh, refreshRow)).toEqual({ _tag: "applied", externalRef: "1000" });
    expect(gh.runs[0]?.output.summary).toContain("logged, [inclusion proof]");
    expect(await lookup(gh, refreshRow)).toEqual({ _tag: "found", externalRef: "1000" });
  });
});

describe("check.summary and check.annotations", () => {
  const annotation = (i: number) => ({
    path: "src/a.ts",
    start_line: i,
    end_line: i,
    annotation_level: "warning" as const,
    message: `issue ${i}`,
  });
  const annotations = (n: number) =>
    row("check.annotations", {
      ...ref,
      title: "lint",
      summary: "findings",
      annotations: Array.from({ length: n }, (_, i) => annotation(i + 1)),
    });

  it("check.summary sets the check run's title and markdown", async () => {
    const gh = await opened();
    await apply(gh, row("check.summary", { ...ref, title: "Review", markdown: "looks fine" }));
    expect(gh.runs[0]?.output).toEqual({ title: "Review", summary: "looks fine" });
  });

  it("[FD-GH-018] sends annotations in batches of at most 50", async () => {
    const gh = await opened();
    await apply(gh, annotations(120));
    expect(gh.calls.filter((c) => c === "update")).toHaveLength(Math.ceil(120 / ANNOTATION_BATCH));
    expect(gh.annotations.get(1000)).toHaveLength(120);
  });

  it("[FD-GH-018] a repeat reads annotations back and sends only the missing ones", async () => {
    const gh = await opened();
    // list, read-back, two batches, then the third batch loses its answer.
    gh.failures.push(
      null,
      null,
      null,
      null,
      new GithubNetworkError({ sent: true, message: "reset" }),
    );
    expect((await apply(gh, annotations(120)))._tag).toBe("unknown");
    expect(gh.annotations.get(1000)).toHaveLength(100);
    expect(await lookup(gh, annotations(120))).toEqual({ _tag: "absent" });
    await apply(gh, annotations(120));
    expect(gh.annotations.get(1000)).toHaveLength(120);
    expect(await lookup(gh, annotations(120))).toEqual({ _tag: "found", externalRef: "1000" });
  });
});

describe("a confidential-compute repository's check run", () => {
  const LOG = "https://fd.example.com/v1/executions/exec-1/logs?t=token";
  /** What the run produced: none of it may reach GitHub. */
  const SECRETS = [
    "const apiKey = readSecret()",
    "diff --git a/src/secret.ts",
    "ERROR at line 12: token mismatch",
    "The model suggests renaming",
    "secret.spec.ts",
    "src/secret.ts",
  ];
  const confidentialDetails = {
    ...details,
    executor_id: "mac-mini-7",
    failing_step: "unit-tests",
    error_tag: "TestFailed",
    markdown: `${SECRETS[0]}\n${SECRETS[1]}\n${SECRETS[2]}\n${SECRETS[3]}`,
    quarantined: [{ test: SECRETS[4]!, path: SECRETS[5]!, line: 12, message: SECRETS[2]! }],
  };
  const confidential = async () => {
    const gh = fakeGithub();
    gh.confidential.add("acme/app");
    await apply(gh, row("check.open", { ...ref, details_url: LOG }));
    return gh;
  };
  const sent = (gh: FakeGithub) => JSON.stringify(gh.bodies);
  const failure = {
    _tag: "failure",
    category: "finding",
    reason: "tests: 2 failed",
  } as const;

  it("[FD-GH-019] the conclusion states only the outcome, the reason, the class, the executor id and the log pointer", async () => {
    const gh = await confidential();
    const conclude = row("check.conclude", {
      ...ref,
      details_url: LOG,
      verdict: failure,
      attempt: 1,
      details: confidentialDetails,
    });
    expect(await apply(gh, conclude)).toEqual({
      _tag: "applied",
      externalRef: "1000",
    });
    expect(gh.runs[0]).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: {
        title: "tests: 2 failed",
        summary: [
          "- Outcome: failure",
          "- Reason: tests: 2 failed",
          "- Class: required",
          "- Executor: mac-mini-7",
          `- Logs: kept on executor mac-mini-7; pointer: ${LOG}`,
        ].join("\n"),
      },
    });
    expect(gh.detailsUrls.get(1000)).toBe(LOG);
    expect(gh.annotations.get(1000)).toBeUndefined();
    for (const secret of [...SECRETS, "unit-tests", "TestFailed", "USD", "cloud entry won"])
      expect(sent(gh)).not.toContain(secret);
    expect(await lookup(gh, conclude)).toEqual({
      _tag: "found",
      externalRef: "1000",
    });
  });

  it("[FD-GH-019] the conclusion built from mameko's outcome row reads the executor id from the execution's records", async () => {
    const gh = fakeGithub();
    gh.confidential.add("acme/app");
    gh.facts.set(
      "exec-1",
      conclusionFactsOf(
        {
          name: ref.name,
          headSha: ref.head_sha,
          attempt: 2,
          className: "required",
          status: "failure",
          reason: "tests: 2 failed",
          enqueuedAt: 1_000,
          finishedAt: 90_000,
          placement: {
            admittedAt: 1_000,
            claimLatencyMs: 4_000,
            leasedKind: "device",
            acceptedKind: "device",
            executorId: "mac-mini-7",
            cloudWon: false,
          },
          reservation: {
            holdMicroUsd: 20_000,
            state: "settled",
            meteredMicroUsd: 12_000,
          },
        },
        LOG,
      ),
    );
    await apply(
      gh,
      row(
        "check.conclude",
        { outcome: { _tag: "Failure", reason: "tests: 2 failed" } },
        { intentKey: "outcome" },
      ),
    );
    expect(gh.runs[0]?.output).toEqual({
      title: "tests: 2 failed (attempt 2)",
      summary: [
        "- Outcome: failure",
        "- Reason: tests: 2 failed",
        "- Class: required",
        "- Executor: mac-mini-7",
        `- Logs: kept on executor mac-mini-7; pointer: ${LOG}`,
      ].join("\n"),
    });
  });

  it("[FD-GH-019] check.start and check.progress state no executor kind, epoch, queue position or deadline", async () => {
    const gh = await confidential();
    await apply(
      gh,
      row("check.start", {
        ...ref,
        epoch: 4,
        executor_kind: "device",
        attempt: 1,
      }),
    );
    expect(gh.runs[0]).toMatchObject({
      status: "in_progress",
      output: {
        title: "Running",
        summary: "Running; the logs stay on the executor.",
      },
    });
    await apply(
      gh,
      row("check.progress", {
        ...ref,
        class: "required",
        bucket: "6–20",
        deadline_at: 0,
      }),
    );
    expect(gh.runs[0]?.output).toEqual({
      title: "Queued",
      summary: "Class `required`.",
    });
    for (const fact of ["device", "epoch", "6–20", "1970-01-01"])
      expect(sent(gh)).not.toContain(fact);
  });

  it("[FD-GH-019] run-authored markdown and annotations are refused and never sent", async () => {
    const gh = await confidential();
    gh.calls.length = 0;
    const refused = {
      _tag: "refused",
      reason: "confidential-compute: run-authored check-run output stays on the executor",
    };
    expect(
      await apply(gh, row("check.summary", { ...ref, title: "Review", markdown: SECRETS[3] })),
    ).toEqual(refused);
    expect(
      await apply(
        gh,
        row("check.annotations", {
          ...ref,
          title: "lint",
          summary: SECRETS[2],
          annotations: [
            {
              path: SECRETS[5],
              start_line: 1,
              end_line: 1,
              annotation_level: "failure",
              message: SECRETS[0],
            },
          ],
        }),
      ),
    ).toEqual(refused);
    expect(gh.calls.filter((c) => c !== "list")).toEqual([]);
    for (const secret of SECRETS) expect(sent(gh)).not.toContain(secret);
  });

  it("a repository outside confidential-compute keeps its check run's full output", async () => {
    const gh = fakeGithub();
    gh.confidential.add("acme/secret");
    await apply(gh, row("check.open", ref));
    await apply(
      gh,
      row("check.conclude", {
        ...ref,
        verdict: failure,
        attempt: 1,
        details: confidentialDetails,
      }),
    );
    expect(gh.runs[0]?.output.summary).toContain("**Failed step:** `unit-tests` (TestFailed)");
    expect(gh.runs[0]?.output.summary).toContain(SECRETS[3]);
    expect(gh.annotations.get(1000)).toHaveLength(1);
  });
});

describe("answers", () => {
  const open = row("check.open", ref);
  const http = (status: number, rateLimited = false) =>
    new GithubHttpError({ status, message: "m", rateLimited });

  it("[FD-GH-045] MAMEKO-OUT-017 404 and 422 are refused", async () => {
    for (const status of [404, 422]) {
      const gh = fakeGithub();
      gh.failures.push(null, http(status));
      expect(await apply(gh, open)).toEqual({ _tag: "refused", reason: `github ${status}: m` });
    }
  });

  it("[FD-GH-046] MAMEKO-OUT-018 5xx, 429 and a secondary-rate-limit 403 are retryable; a plain 403 is refused", async () => {
    for (const e of [http(500), http(503), http(429, true), http(403, true)]) {
      const gh = fakeGithub();
      gh.failures.push(null, e);
      expect((await apply(gh, open))._tag).toBe("retryable");
    }
    const gh = fakeGithub();
    gh.failures.push(null, http(403));
    expect((await apply(gh, open))._tag).toBe("refused");
  });

  it("MAMEKO-OUT-022 a request sent without an answer is unknown; one never sent is retryable", async () => {
    const lost = fakeGithub();
    lost.failures.push(null, new GithubNetworkError({ sent: true, message: "reset" }));
    expect((await apply(lost, open))._tag).toBe("unknown");
    const unsent = fakeGithub();
    unsent.failures.push(null, new GithubNetworkError({ sent: false, message: "dns" }));
    expect((await apply(unsent, open))._tag).toBe("retryable");
  });

  it("[FD-GH-047] a 401 mints a new token and retries once", async () => {
    const gh = fakeGithub();
    gh.failures.push(http(401));
    expect((await apply(gh, open))._tag).toBe("applied");
    expect(gh.tokenRefreshes).toBe(1);
  });

  it("[FD-GH-048] a second 401 is refused installation: unauthorized and raises installation-lost", async () => {
    const gh = fakeGithub();
    gh.failures.push(http(401), null, http(401));
    expect(await apply(gh, open)).toEqual({
      _tag: "refused",
      reason: "installation: unauthorized",
    });
    expect(gh.alarms.map((a) => [a.name, a.severity])).toEqual([["installation-lost", "page"]]);
  });

  it("[FD-GH-004] no installation for the repository is refused installation: not found with a page", async () => {
    const gh = fakeGithub();
    expect(await apply(gh, row("check.open", ref, { scopeId: "acme/other" }))).toEqual({
      _tag: "refused",
      reason: "installation: not found",
    });
    expect(gh.alarms[0]).toMatchObject({ name: "installation-lost", severity: "page" });
    expect(gh.calls).toEqual([]);
  });

  it("MAMEKO-OUT-025 MAMEKO-OUT-064 lookup and reconcile without an installation answer undetermined", async () => {
    const lost = row("check.open", ref, { scopeId: "acme/other" });
    const undetermined = { _tag: "undetermined", reason: "installation: not found" };
    expect(await lookup(fakeGithub(), lost)).toEqual(undetermined);
    expect(await reconcile(fakeGithub(), lost)).toEqual(undetermined);
  });

  it("refuses a kind it does not serve and a payload its kind does not decode", async () => {
    expect((await apply(fakeGithub(), row("comment", {})))._tag).toBe("refused");
    expect((await apply(fakeGithub(), row("check.start", ref)))._tag).toBe("refused");
  });

  it("MAMEKO-OUT-064 reconcile answers undetermined when GitHub cannot be read", async () => {
    const gh = await opened();
    gh.failures.push(http(502));
    expect(await reconcile(gh, open)).toEqual({ _tag: "undetermined", reason: "github 502: m" });
    expect(await reconcile(gh, open)).toEqual({ _tag: "found", externalRef: "1000" });
  });
});
