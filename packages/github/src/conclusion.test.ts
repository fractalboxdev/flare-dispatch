import { describe, expect, it } from "vitest";
import { checkConclusion, NOT_APPLICABLE_DETAILS, type Verdict } from "./conclusion.ts";

const CAPACITY = ["budget", "capacity", "deadline", "halt", "placement"] as const;
const CATEGORIES = [
  "finding",
  "infra",
  ...CAPACITY,
  "unrecorded",
  "config",
  "policy",
  "provenance",
] as const;

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

  it("FD-GH-027 FD-QOS-056 no capacity reason concludes neutral", () => {
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
    ];
    expect(new Set(verdicts.map((v) => checkConclusion(v).conclusion))).toEqual(
      new Set(["success", "failure", "cancelled", "neutral"]),
    );
  });
});
