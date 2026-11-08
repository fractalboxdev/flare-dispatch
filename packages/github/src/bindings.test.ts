// The bindings and rules beside the appliers: `installationOf`, the check label, fan-out children, the conclusion
// mapping's closure, the neutral invariant, quarantined failures and the check-run lookup's answers.
import {
  type Actuator,
  Actuators,
  AlarmPort,
  type Alarm,
  type IntentRow,
} from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { CheckRunApplierLive, InstallationDirectory } from "./applier.ts";
import {
  checkNeutralInvariant,
  childConclusions,
  installationOf,
  neutralHolds,
  PARENT_CLOSED,
  validateCheckLabel,
} from "./bindings.ts";
import { GithubHttpError } from "./client.ts";
import {
  checkConclusion,
  concludeSummary,
  quarantineAnnotations,
  type Verdict,
} from "./conclusion.ts";
import { fakeGithub, fakeLayers, row, type FakeGithub } from "./fake.test-support.ts";

const directory = Layer.succeed(InstallationDirectory, {
  installationFor: (scope) => Effect.succeed(scope === "acme/app" ? 7 : null),
});

describe("installationOf", () => {
  it("FD-GH-056 the limit key is the id of the installation that serves the row's repository", async () => {
    expect(
      await Effect.runPromise(installationOf("acme/app").pipe(Effect.provide(directory))),
    ).toBe("7");
    const exit = await Effect.runPromise(
      Effect.exit(installationOf("acme/none").pipe(Effect.provide(directory))),
    );
    expect(JSON.stringify(exit)).toContain("NoInstallation");
  });
});

describe("check labels", () => {
  it("FD-GH-007 a checkLabel outside ^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$ is rejected with InvalidCheckLabel", async () => {
    expect(await Effect.runPromise(validateCheckLabel("ci.lint-1"))).toBe("ci.lint-1");
    for (const bad of ["", "-x", "has space", "a".repeat(33), "a/b"]) {
      const exit = await Effect.runPromise(Effect.exit(validateCheckLabel(bad)));
      expect(JSON.stringify(exit)).toContain("InvalidCheckLabel");
    }
  });
});

describe("fan-out children", () => {
  it("FD-GH-020 a parent's outcome concludes every child not yet concluded, with its outcome or parent closed", () => {
    const success: Verdict = { _tag: "success" };
    expect(
      childConclusions([
        { executionId: "a", verdict: success, concluded: false },
        { executionId: "b", verdict: null, concluded: false },
        { executionId: "c", verdict: success, concluded: true },
      ]),
    ).toEqual([
      { executionId: "a", intentKey: "cp:check:conclude", verdict: success },
      { executionId: "b", intentKey: "cp:check:conclude", verdict: PARENT_CLOSED },
    ]);
    expect(checkConclusion(PARENT_CLOSED)).toEqual({
      conclusion: "failure",
      title: "parent closed before this part settled",
    });
  });
});

const VERDICTS: readonly Verdict[] = [
  { _tag: "success" },
  { _tag: "failure", category: "budget", reason: "budget: exhausted" },
  { _tag: "cancelled", cause: "superseded" },
  { _tag: "skipped", reason: "not-applicable", detail: "draft-pr" },
  { _tag: "skipped", reason: "other", detail: "x" },
  { _tag: "deferred" },
  { _tag: "expired" },
];

describe("the conclusion mapping", () => {
  it("FD-GH-021 every verdict of the closed union maps through checkConclusion to one of four conclusions", () => {
    const conclusions = new Set(VERDICTS.map((v) => checkConclusion(v).conclusion));
    expect([...conclusions].sort()).toEqual(["cancelled", "failure", "neutral", "success"]);
  });

  it("FD-GH-031 a neutral conclusion on any outcome but a listed not-applicable skip pages neutral-invariant", async () => {
    expect(VERDICTS.filter((v) => neutralHolds(checkConclusion(v).conclusion, v))).toHaveLength(
      VERDICTS.length,
    );
    expect(
      neutralHolds("neutral", {
        _tag: "failure",
        category: "capacity",
        reason: "capacity: model unavailable",
      }),
    ).toBe(false);
    const alarms: Alarm[] = [];
    const layer = Layer.succeed(AlarmPort, {
      deliver: (a) => Effect.sync(() => void alarms.push(a)),
    });
    await Effect.runPromise(
      checkNeutralInvariant("e1", "acme/app", "neutral", { _tag: "deferred" }).pipe(
        Effect.provide(layer),
      ),
    );
    await Effect.runPromise(
      checkNeutralInvariant("e2", "acme/app", "neutral", VERDICTS[3]!).pipe(Effect.provide(layer)),
    );
    expect(alarms.map((a) => [a.name, a.severity, a.dedupeKey])).toEqual([
      ["neutral-invariant", "page", "neutral-invariant:e1"],
    ]);
  });
});

const ref = { name: "flare-dispatch/check", head_sha: "abc123" };
const details = {
  class: "required",
  executor_kind: "cloudflare",
  placement_reason: "cloud entry won",
  queue_age_ms: 0,
  reserved_micro_usd: 0,
  settled_micro_usd: 0,
};

const withApplier = <A>(gh: FakeGithub, f: (a: Required<Actuator>) => Effect.Effect<A>) =>
  Effect.runPromise(
    Actuators.use((registry) => f(registry.get("checkRun") as Required<Actuator>)).pipe(
      Effect.provide(CheckRunApplierLive.pipe(Layer.provide(fakeLayers(gh)))),
    ),
  );
const apply = (gh: FakeGithub, r: IntentRow) => withApplier(gh, (a) => a.apply(r));
const lookup = (gh: FakeGithub, r: IntentRow) => withApplier(gh, (a) => a.lookup(r));

describe("quarantined failures", () => {
  it("FD-GH-077 each quarantined failure is a warning annotation and a summary line, 50 annotations per request", async () => {
    const quarantined = Array.from({ length: 60 }, (_, i) => ({
      test: `t${i}`,
      path: "src/a.test.ts",
      line: i + 1,
      message: "flaky",
    }));
    const d = { ...details, quarantined };
    expect(quarantineAnnotations(d)[0]).toMatchObject({
      annotation_level: "warning",
      path: "src/a.test.ts",
      start_line: 1,
    });
    expect(concludeSummary({ _tag: "success" }, d)).toContain("- `t59` (src/a.test.ts:60): flaky");
    const gh = fakeGithub();
    await apply(gh, row("check.open", ref));
    await apply(
      gh,
      row("check.conclude", { ...ref, verdict: { _tag: "success" }, attempt: 1, details: d }),
    );
    expect(gh.calls.filter((c) => c === "update")).toHaveLength(2);
    expect(gh.annotations.get(1000)).toHaveLength(60);
    expect(gh.runs[0]).toMatchObject({ status: "completed", conclusion: "success" });
  });
});

describe("check-run lookup", () => {
  it("FD-GH-090 found only when exactly one check run carries the execution id and shows the effect", async () => {
    const gh = fakeGithub();
    const open = row("check.open", ref);
    expect(await lookup(gh, open)).toEqual({ _tag: "absent" });
    await apply(gh, open);
    expect(await lookup(gh, open)).toEqual({ _tag: "found", externalRef: "1000" });
    const start = row("check.start", { ...ref, epoch: 1, executor_kind: "device", attempt: 1 });
    expect(await lookup(gh, start)).toEqual({ _tag: "absent" });
    gh.runs.push({ ...gh.runs[0]!, id: 1001 });
    expect(await lookup(gh, open)).toMatchObject({ _tag: "undetermined" });
    gh.runs.pop();
    gh.failures.push(new GithubHttpError({ status: 500, message: "boom", rateLimited: false }));
    expect(await lookup(gh, open)).toMatchObject({ _tag: "undetermined" });
  });

  it("FD-GH-091 no execution id, an unserved kind or a rejected payload is refused without a GitHub call", async () => {
    const gh = fakeGithub();
    expect(await apply(gh, row("check.open", ref, { executionId: null }))).toMatchObject({
      _tag: "refused",
    });
    expect(await apply(gh, row("comment", { issue_number: 1, body: "x" }))).toMatchObject({
      _tag: "refused",
    });
    expect(await apply(gh, row("check.open", { name: 1 }))).toMatchObject({ _tag: "refused" });
    expect(gh.calls).toEqual([]);
  });
});
