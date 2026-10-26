import { EffectApplier, type IntentRow } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ANNOTATION_BATCH, CheckRunApplierLive } from "./applier.ts";
import { GithubHttpError, GithubNetworkError } from "./client.ts";
import { OUTPUT_LIMIT } from "./conclusion.ts";
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

const withApplier = <A>(
  gh: FakeGithub,
  f: (applier: EffectApplier["Service"]) => Effect.Effect<A>,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        return yield* f(yield* EffectApplier);
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
  it("FD-GH-005 FD-GH-009 creates the check run queued on the head SHA with external_id = execution id", async () => {
    const gh = fakeGithub();
    expect(await apply(gh, row("check.open", ref))).toEqual({
      _tag: "applied",
      externalRef: "1000",
    });
    expect(gh.runs).toMatchObject([{ name: ref.name, external_id: "exec-1", status: "queued" }]);
  });

  it("FD-GH-010 MAMEKO-OUT-024 lookup adopts the check run an earlier attempt created", async () => {
    const gh = await opened();
    expect(await lookup(gh, row("check.open", ref, { attempts: 1 }))).toEqual({
      _tag: "found",
      externalRef: "1000",
    });
  });

  it("FD-GH-010 a repeated apply finds the existing check run instead of creating a second", async () => {
    const gh = await opened();
    expect(await apply(gh, row("check.open", ref, { attempts: 1 }))).toEqual({
      _tag: "applied",
      externalRef: "1000",
    });
    expect(gh.runs).toHaveLength(1);
    expect(gh.calls).toEqual(["list"]);
  });

  it("MAMEKO-OUT-024 lookup answers absent when no attempt reached GitHub", async () => {
    expect(await lookup(fakeGithub(), row("check.open", ref, { attempts: 1 }))).toEqual({
      _tag: "absent",
    });
  });

  it("FD-GH-010 a lookup that cannot read answers absent, and the next apply reads before it creates", async () => {
    const gh = await opened();
    const down = new GithubHttpError({ status: 502, message: "bad gateway", rateLimited: false });
    gh.failures.push(down, down, down, down);
    expect(await lookup(gh, row("check.open", ref, { attempts: 1 }))).toEqual({ _tag: "absent" });
    expect(await apply(gh, row("check.open", ref, { attempts: 2 }))).toEqual({
      _tag: "applied",
      externalRef: "1000",
    });
    expect(gh.runs).toHaveLength(1);
  });
});

describe("check.start and check.progress", () => {
  const start = { ...ref, epoch: 2, executor_kind: "device", attempt: 1 };
  const progress = { ...ref, class: "interactive", bucket: "2–5", deadline_at: 0 } as const;

  it("FD-GH-011 check.start sets in_progress and names the executor kind and the epoch", async () => {
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

  it("FD-GH-012 check.progress states the class, the queue-position bucket and the deadline", async () => {
    const gh = await opened();
    await apply(gh, row("check.progress", progress));
    expect(gh.runs[0]?.output.title).toBe("Queued: position 2–5");
    expect(gh.runs[0]?.output.summary).toContain("Class `interactive`");
    expect(gh.runs[0]?.output.summary).toContain("1970-01-01T00:00:00.000Z");
  });

  it("FD-GH-051 neither applies after the check run concludes", async () => {
    const gh = await opened();
    await apply(
      gh,
      row("check.conclude", { ...ref, verdict: { _tag: "success" }, attempt: 1, details }),
    );
    for (const r of [row("check.start", start), row("check.progress", progress)])
      expect((await apply(gh, r))._tag).toBe("refused");
    expect(gh.runs[0]).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("FD-GH-051 check.start before check.open is applied waits instead of creating", async () => {
    expect(await apply(fakeGithub(), row("check.start", start))).toEqual({
      _tag: "retryable",
      reason: "check run not open yet",
    });
  });
});

describe("check.conclude", () => {
  const conclude = (verdict: unknown, attempt = 1, extra: object = {}) =>
    row("check.conclude", { ...ref, verdict, attempt, details: { ...details, ...extra } });

  it("FD-GH-014 FD-GH-023 concludes with the conclusion and the reason in the title", async () => {
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

  it("FD-GH-052 creates the check run completed when no check.open was applied", async () => {
    const gh = fakeGithub();
    expect((await apply(gh, conclude({ _tag: "cancelled", cause: "pr-closed" })))._tag).toBe(
      "applied",
    );
    expect(gh.runs).toMatchObject([
      { external_id: "exec-1", status: "completed", conclusion: "cancelled" },
    ]);
  });

  it("FD-GH-008 appends the attempt to the title only after the first attempt", async () => {
    const gh = await opened();
    await apply(gh, conclude({ _tag: "success" }, 3));
    expect(gh.runs[0]?.output.title).toBe("success (attempt 3)");
  });

  it("FD-GH-015 FD-GH-016 the summary leads with the failing step, then class, executor, queue age, cost and reason", async () => {
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

  it("FD-GH-017 cuts a long summary to 65535 characters ending in a log-viewer link", async () => {
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

  it("FD-GH-018 sends annotations in batches of at most 50", async () => {
    const gh = await opened();
    await apply(gh, annotations(120));
    expect(gh.calls.filter((c) => c === "update")).toHaveLength(Math.ceil(120 / ANNOTATION_BATCH));
    expect(gh.annotations.get(1000)).toHaveLength(120);
  });

  it("FD-GH-018 a repeat reads annotations back and sends only the missing ones", async () => {
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

describe("answers", () => {
  const open = row("check.open", ref);
  const http = (status: number, rateLimited = false) =>
    new GithubHttpError({ status, message: "m", rateLimited });

  it("FD-GH-045 MAMEKO-OUT-017 404 and 422 are refused", async () => {
    for (const status of [404, 422]) {
      const gh = fakeGithub();
      gh.failures.push(http(status));
      expect(await apply(gh, open)).toEqual({ _tag: "refused", reason: `github ${status}: m` });
    }
  });

  it("FD-GH-046 MAMEKO-OUT-018 5xx, 429 and a secondary-rate-limit 403 are retryable; a plain 403 is refused", async () => {
    for (const e of [http(500), http(503), http(429, true), http(403, true)]) {
      const gh = fakeGithub();
      gh.failures.push(e);
      expect((await apply(gh, open))._tag).toBe("retryable");
    }
    const gh = fakeGithub();
    gh.failures.push(http(403));
    expect((await apply(gh, open))._tag).toBe("refused");
  });

  it("MAMEKO-OUT-022 a request sent without an answer is unknown; one never sent is retryable", async () => {
    const lost = fakeGithub();
    lost.failures.push(new GithubNetworkError({ sent: true, message: "reset" }));
    expect((await apply(lost, open))._tag).toBe("unknown");
    const unsent = fakeGithub();
    unsent.failures.push(new GithubNetworkError({ sent: false, message: "dns" }));
    expect((await apply(unsent, open))._tag).toBe("retryable");
  });

  it("FD-GH-047 a 401 mints a new token and retries once", async () => {
    const gh = fakeGithub();
    gh.failures.push(http(401));
    expect((await apply(gh, open))._tag).toBe("applied");
    expect(gh.tokenRefreshes).toBe(1);
  });

  it("FD-GH-048 a second 401 is refused installation: unauthorized and raises installation-lost", async () => {
    const gh = fakeGithub();
    gh.failures.push(http(401), null, http(401));
    expect(await apply(gh, open)).toEqual({
      _tag: "refused",
      reason: "installation: unauthorized",
    });
    expect(gh.alarms.map((a) => [a.name, a.severity])).toEqual([["installation-lost", "page"]]);
  });

  it("FD-GH-004 no installation for the repository is refused installation: not found with a page", async () => {
    const gh = fakeGithub();
    expect(await apply(gh, row("check.open", ref, { scopeId: "acme/other" }))).toEqual({
      _tag: "refused",
      reason: "installation: not found",
    });
    expect(gh.alarms[0]).toMatchObject({ name: "installation-lost", severity: "page" });
    expect(gh.calls).toEqual([]);
  });

  it("refuses a kind it does not serve and a payload its kind does not decode", async () => {
    expect((await apply(fakeGithub(), row("comment", {})))._tag).toBe("refused");
    expect((await apply(fakeGithub(), row("check.start", ref)))._tag).toBe("refused");
  });

  it("MAMEKO-OUT-025 reconcile answers undetermined when GitHub cannot be read", async () => {
    const gh = await opened();
    gh.failures.push(http(502));
    expect(await reconcile(gh, open)).toEqual({ _tag: "undetermined", reason: "github 502: m" });
    expect(await reconcile(gh, open)).toEqual({ _tag: "found", externalRef: "1000" });
  });
});
