import { describe, expect, it } from "vitest";
import type { ExecutionOutcome } from "@fractalboxdev/mameko-coordinator";
import { checkConclusion, NOT_APPLICABLE_DETAILS, verdictOf, type Verdict } from "./conclusion.ts";

const CAPACITY = ["budget", "capacity", "deadline", "halt", "placement"] as const;
const CATEGORIES = ["finding", "infra", ...CAPACITY, "unrecorded", "config", "policy"] as const;

describe("checkConclusion", () => {
  it("FD-GH-022 success concludes success", () => {
    expect(checkConclusion({ _tag: "success" }).conclusion).toBe("success");
  });

  it("FD-GH-023 every failure category concludes failure with the reason in the title", () => {
    for (const category of CATEGORIES.filter((c) => c !== "unrecorded"))
      expect(checkConclusion({ _tag: "failure", category, reason: `${category}: x` })).toEqual({
        conclusion: "failure",
        title: `${category}: x`,
      });
  });

  it("MAMEKO-LEASE-090 an acceptance-check rejection concludes failure with the reason kind it returns", () => {
    expect(
      checkConclusion({
        _tag: "failure",
        category: "policy",
        reason: "provenance: statement digest",
      }),
    ).toEqual({ conclusion: "failure", title: "provenance: statement digest" });
  });

  it("FD-GH-024 a cancellation concludes cancelled with the cause", () => {
    expect(checkConclusion({ _tag: "cancelled", cause: "superseded" })).toEqual({
      conclusion: "cancelled",
      title: "superseded",
    });
  });

  it("FD-GH-025 a not-applicable skip with a listed detail concludes neutral", () => {
    for (const detail of NOT_APPLICABLE_DETAILS)
      expect(
        checkConclusion({ _tag: "skipped", reason: "not-applicable", detail }).conclusion,
      ).toBe("neutral");
  });

  it("FD-GH-026 any other skip concludes failure, internal: invalid skip reason", () => {
    for (const v of [
      { _tag: "skipped", reason: "not-applicable", detail: "made-up" },
      { _tag: "skipped", reason: "budget", detail: "draft-pr" },
    ] as const)
      expect(checkConclusion(v)).toEqual({
        conclusion: "failure",
        title: "internal: invalid skip reason",
      });
  });

  it("FD-GH-027 MAMEKO-ADM-060, MAMEKO-PROF-018 no capacity reason concludes neutral", () => {
    for (const category of CAPACITY)
      expect(
        checkConclusion({ _tag: "failure", category, reason: `${category}: context overflow` })
          .conclusion,
      ).toBe("failure");
    expect(checkConclusion({ _tag: "deferred" })).toEqual({
      conclusion: "failure",
      title: "capacity: deferred",
    });
  });

  it("FD-GH-027 expired concludes failure, deadline: expired", () => {
    expect(checkConclusion({ _tag: "expired" })).toEqual({
      conclusion: "failure",
      title: "deadline: expired",
    });
  });

  it("FD-GH-028 an unrecorded terminal status concludes failure, internal: terminal write not recorded", () => {
    expect(
      checkConclusion({ _tag: "failure", category: "unrecorded", reason: "unrecorded" }),
    ).toEqual({ conclusion: "failure", title: "internal: terminal write not recorded" });
  });

  it("FD-GH-029 emits only success, failure, cancelled and neutral", () => {
    const verdicts: Verdict[] = [
      { _tag: "success" },
      ...CATEGORIES.map((category) => ({ _tag: "failure" as const, category, reason: "r" })),
      { _tag: "cancelled", cause: "operator-cancel" },
      { _tag: "skipped", reason: "not-applicable", detail: "draft-pr" },
      { _tag: "deferred" },
      { _tag: "expired" },
    ];
    expect(new Set(verdicts.map((v) => checkConclusion(v).conclusion))).toEqual(
      new Set(["success", "failure", "cancelled", "neutral"]),
    );
  });
});

describe("verdictOf", () => {
  const conclude = (outcome: ExecutionOutcome) => checkConclusion(verdictOf(outcome));

  it("FD-GH-022 Success concludes success", () => {
    expect(conclude({ _tag: "Success", epoch: 1 }).conclusion).toBe("success");
  });

  it("FD-GH-023 Failure keeps its reason, and its kind names the category", () => {
    expect(verdictOf({ _tag: "Failure", reason: "budget: x", epoch: 1 })).toEqual({
      _tag: "failure",
      category: "budget",
      reason: "budget: x",
    });
    expect(
      verdictOf(
        { _tag: "Failure", reason: "provenance: slsa", epoch: null },
        {
          provenance: "policy",
        },
      ),
    ).toMatchObject({ category: "policy" });
  });

  it("FD-GH-028 an unrecorded Failure concludes internal: terminal write not recorded", () => {
    expect(conclude({ _tag: "Failure", reason: "unrecorded", epoch: null }).title).toBe(
      "internal: terminal write not recorded",
    );
  });

  it("FD-GH-024 Cancelled keeps its cause, a cause outside the closed list included", () => {
    for (const cause of ["pr-closed", "cancelled"])
      expect(conclude({ _tag: "Cancelled", cause })).toEqual({
        conclusion: "cancelled",
        title: cause,
      });
  });

  it("FD-GH-025 Skipped with a listed detail concludes neutral", () => {
    expect(conclude({ _tag: "Skipped", detail: "draft-pr", epoch: 1 })).toEqual({
      conclusion: "neutral",
      title: "not applicable: draft-pr",
    });
  });

  it("FD-GH-026 Skipped with any other detail concludes failure", () => {
    expect(conclude({ _tag: "Skipped", detail: "", epoch: 1 })).toEqual({
      conclusion: "failure",
      title: "internal: invalid skip reason",
    });
  });

  it("Deferred and Expired conclude failure", () => {
    expect(conclude({ _tag: "Deferred" }).title).toBe("capacity: deferred");
    expect(conclude({ _tag: "Expired" }).title).toBe("deadline: expired");
  });
});
