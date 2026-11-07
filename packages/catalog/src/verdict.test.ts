import { describe, expect, it } from "vitest";
import { CommandExit } from "./command.ts";
import {
  categoryOf,
  FD_REASON_KINDS,
  MAMEKO_REASON_KINDS,
  NOT_APPLICABLE_DETAILS,
  Outcome,
  type Reason,
} from "./reasons.ts";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { installVerdictOf, NOTHING_TO_LINT_LINE, verdictOf } from "./verdict.ts";

describe("exit to verdict", () => {
  it("FD-GATE-002 records success for exit 0", () => {
    expect(verdictOf(CommandExit.Exited({ code: 0 }))).toEqual({ _tag: "success" });
  });

  it("FD-GATE-003 records exit: <code> for a non-zero exit", () => {
    expect(verdictOf(CommandExit.Exited({ code: 2 }))).toEqual({
      _tag: "failure",
      reason: "exit: 2",
    });
  });

  it("FD-GATE-005 records exit: signal <name>", () => {
    expect(verdictOf(CommandExit.Signalled({ signal: "SIGSEGV" }))).toEqual({
      _tag: "failure",
      reason: "exit: signal SIGSEGV",
    });
  });

  it("FD-GATE-006, FD-GATE-007 and FD-GATE-008 record the timeout, deadline and output-limit reasons", () => {
    expect(verdictOf(CommandExit.TimedOut())).toEqual(Outcome.failure("timeout: job"));
    expect(verdictOf(CommandExit.DeadlineReached())).toEqual(Outcome.failure("deadline"));
    expect(verdictOf(CommandExit.OverLimit())).toEqual(Outcome.failure("output: over limit"));
  });

  it("FD-GATE-024 skips an oxlint run that found nothing to lint, and only an oxlint run with exit 0", () => {
    const output = `scanning\n${NOTHING_TO_LINT_LINE}\n`;
    expect(verdictOf(CommandExit.Exited({ code: 0 }), { output, lint: true })).toEqual(
      Outcome.skipped("nothing-to-lint"),
    );
    expect(verdictOf(CommandExit.Exited({ code: 0 }), { output })).toEqual(Outcome.success());
    expect(verdictOf(CommandExit.Exited({ code: 1 }), { output, lint: true })).toEqual(
      Outcome.failure("exit: 1"),
    );
  });

  it("FD-GATE-028 records install: exit <code> for a failed install", () => {
    expect(installVerdictOf(CommandExit.Exited({ code: 7 }))).toEqual(
      Outcome.failure("install: exit 7"),
    );
    expect(installVerdictOf(CommandExit.TimedOut())).toEqual(Outcome.failure("timeout: job"));
  });

  it("FD-GATE-004 maps no non-zero exit to success", () => {
    for (let code = 1; code < 256; code++)
      for (const lint of [true, false])
        expect(
          verdictOf(CommandExit.Exited({ code }), { lint, output: NOTHING_TO_LINT_LINE })._tag,
        ).toBe("failure");
    for (const exit of [
      CommandExit.Signalled({ signal: "SIGTERM" }),
      CommandExit.TimedOut(),
      CommandExit.DeadlineReached(),
      CommandExit.OverLimit(),
      CommandExit.NotStarted({ detail: "x" }),
    ])
      expect(verdictOf(exit)._tag).toBe("failure");
  });
});

describe("reason kinds", () => {
  it("FD-RUN-057 declares every kind of specs/run-model.md § Reason kinds but provenance, in its category", () => {
    expect(FD_REASON_KINDS).toEqual({
      exit: "finding",
      timeout: "finding",
      output: "finding",
      install: "finding",
      discover: "finding",
      jobs: "finding",
      smoke: "finding",
      image: "finding",
      review: "finding",
      "no-fix": "finding",
      suppression: "infra",
      writeback: "policy",
      intent: "policy",
      release: "policy",
    });
    expect(Object.keys(FD_REASON_KINDS)).not.toContain("provenance");
    for (const kind of Object.keys(FD_REASON_KINDS))
      expect(kind in MAMEKO_REASON_KINDS).toBe(false);
  });

  it("FD-RUN-057 types a failure reason as a closed union of kinds", () => {
    const ok: Reason[] = ["exit: 1", "infra: no verdict", "deadline", "release: tag moved"];
    expect(ok.map(categoryOf)).toEqual(["finding", "infra", "deadline", "policy"]);
    // @ts-expect-error a kind neither table declares fails typecheck
    const bad: Reason = "flaky: retried";
    expect(categoryOf(bad)).toBeUndefined();
    // @ts-expect-error provenance is the result-acceptance check's kind, not a run's
    Outcome.failure("provenance: check");
  });

  it("types a skip by the profile's not-applicable details", () => {
    const profile = buildProfile("production");
    expect([...NOT_APPLICABLE_DETAILS]).toEqual(profile.outcome_mapping.not_applicable_details);
    // @ts-expect-error a detail the profile does not list fails typecheck
    Outcome.skipped("no-tests");
  });
});
