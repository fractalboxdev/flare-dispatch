import { describe, expect, it } from "vitest";
import type { ExecutionOutcome } from "@fractalboxdev/mameko-coordinator";
import {
  checkConclusion,
  concludeSummary,
  confidentialSummary,
  NOT_APPLICABLE_DETAILS,
  verdictOf,
  type ConcludeDetails,
  type Verdict,
} from "./conclusion.ts";

const CAPACITY = ["budget", "capacity", "deadline", "halt", "placement"] as const;
const CATEGORIES = ["finding", "infra", ...CAPACITY, "unrecorded", "config", "policy"] as const;

describe("checkConclusion", () => {
  it("[FD-GH-022] success concludes success", () => {
    expect(checkConclusion({ _tag: "success" }).conclusion).toBe("success");
  });

  it("[FD-GH-023] every failure category concludes failure with the reason in the title", () => {
    for (const category of CATEGORIES.filter((c) => c !== "unrecorded"))
      expect(checkConclusion({ _tag: "failure", category, reason: `${category}: x` })).toEqual({
        conclusion: "failure",
        title: `${category}: x`,
      });
  });

  it("MAMEKO-LEASE-093 an acceptance-check rejection concludes failure with the reason kind it returns", () => {
    expect(
      checkConclusion({
        _tag: "failure",
        category: "policy",
        reason: "provenance: statement digest",
      }),
    ).toEqual({ conclusion: "failure", title: "provenance: statement digest" });
  });

  it("[FD-GH-024] a cancellation concludes cancelled with the cause", () => {
    expect(checkConclusion({ _tag: "cancelled", cause: "superseded" })).toEqual({
      conclusion: "cancelled",
      title: "superseded",
    });
  });

  it("[FD-GH-025] a not-applicable skip with a listed detail concludes neutral", () => {
    for (const detail of NOT_APPLICABLE_DETAILS)
      expect(
        checkConclusion({ _tag: "skipped", reason: "not-applicable", detail }).conclusion,
      ).toBe("neutral");
  });

  it("[FD-GH-026] any other skip concludes failure, internal: invalid skip reason", () => {
    for (const v of [
      { _tag: "skipped", reason: "not-applicable", detail: "made-up" },
      { _tag: "skipped", reason: "budget", detail: "draft-pr" },
    ] as const)
      expect(checkConclusion(v)).toEqual({
        conclusion: "failure",
        title: "internal: invalid skip reason",
      });
  });

  it("[FD-GH-027] MAMEKO-ADM-059, MAMEKO-PROF-018 no capacity reason concludes neutral", () => {
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

  it("[FD-GH-027] expired concludes failure, deadline: expired", () => {
    expect(checkConclusion({ _tag: "expired" })).toEqual({
      conclusion: "failure",
      title: "deadline: expired",
    });
  });

  it("[FD-GH-028] an unrecorded terminal status concludes failure, internal: terminal write not recorded", () => {
    expect(
      checkConclusion({ _tag: "failure", category: "unrecorded", reason: "unrecorded" }),
    ).toEqual({ conclusion: "failure", title: "internal: terminal write not recorded" });
  });

  it("[FD-GH-029] emits only success, failure, cancelled and neutral", () => {
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

  it("[FD-GH-022] Success concludes success", () => {
    expect(conclude({ _tag: "Success", epoch: 1 }).conclusion).toBe("success");
  });

  it("[FD-GH-023] Failure keeps its reason, and its kind names the category", () => {
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

  it("[FD-GH-028] an unrecorded Failure concludes internal: terminal write not recorded", () => {
    expect(conclude({ _tag: "Failure", reason: "unrecorded", epoch: null }).title).toBe(
      "internal: terminal write not recorded",
    );
  });

  it("[FD-GH-024] Cancelled keeps its cause, a cause outside the closed list included", () => {
    for (const cause of ["pr-closed", "cancelled"])
      expect(conclude({ _tag: "Cancelled", cause })).toEqual({
        conclusion: "cancelled",
        title: cause,
      });
  });

  it("[FD-GH-025] Skipped with a listed detail concludes neutral", () => {
    expect(conclude({ _tag: "Skipped", detail: "draft-pr", epoch: 1 })).toEqual({
      conclusion: "neutral",
      title: "not applicable: draft-pr",
    });
  });

  it("[FD-GH-026] Skipped with any other detail concludes failure", () => {
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

describe("the check summary's provenance links", () => {
  const ORIGIN = "https://dispatcher.example.com";
  const ENVELOPE = `sha256:${"e".repeat(64)}`;
  const PENDING = `sha256:${"f".repeat(64)}`;
  const APP = `sha256:${"1".repeat(64)}`;
  const LIB = `sha256:${"2".repeat(64)}`;
  const details = (provenance: ConcludeDetails["provenance"]): ConcludeDetails => ({
    class: "batch",
    executor_kind: "cloudflare",
    executor_id: "cf-1",
    placement_reason: "cloud entry won",
    queue_age_ms: 1_000,
    reserved_micro_usd: 10,
    settled_micro_usd: 8,
    markdown: "run markdown",
    ...(provenance === undefined ? {} : { provenance }),
  });
  const logged = {
    envelope_digest: ENVELOPE,
    status: "logged" as const,
    statement_url: `${ORIGIN}/v1/provenance/executions/01JEXEC`,
    inclusion_proof_url: "https://rekor.sigstore.dev/api/v1/log/entries/24296fb24b8ad77a",
    subjects: [
      { digest: APP, url: `${ORIGIN}/v1/provenance/subjects/${APP}` },
      { digest: LIB, url: `${ORIGIN}/v1/provenance/subjects/${LIB}` },
    ],
  };

  it("[FD-PROV-042] a logged statement's summary line links the statement, its inclusion proof and each subject digest", () => {
    const summary = concludeSummary({ _tag: "success" }, details([logged]));
    const line = summary.split("\n").find((l) => l.includes(ENVELOPE))!;
    expect(line).toBe(
      `- Statement [\`${ENVELOPE}\`](${logged.statement_url}): logged, ` +
        `[inclusion proof](${logged.inclusion_proof_url}); ` +
        `subjects [\`${APP}\`](${logged.subjects[0]!.url}), [\`${LIB}\`](${logged.subjects[1]!.url})`,
    );
    // The links sit under their own heading, before the run's markdown.
    expect(summary.indexOf("**Provenance:**")).toBeLessThan(summary.indexOf(line));
    expect(summary.indexOf(line)).toBeLessThan(summary.indexOf("run markdown"));
  });

  it("[FD-PROV-042] a statement whose append is pending shows log-pending with no inclusion proof, beside a logged one", () => {
    const summary = concludeSummary(
      { _tag: "failure", category: "finding", reason: "step test failed" },
      details([
        logged,
        {
          envelope_digest: PENDING,
          status: "log-pending",
          statement_url: `${ORIGIN}/v1/provenance/executions/01JEXEC`,
          inclusion_proof_url: null,
          subjects: [],
        },
      ]),
    );
    expect(summary).toContain(
      `- Statement [\`${PENDING}\`](${ORIGIN}/v1/provenance/executions/01JEXEC): log-pending`,
    );
    expect(summary.match(/inclusion proof/g)).toHaveLength(1);
  });

  it("[FD-PROV-042] an execution with no statement has no provenance section, and a confidential-compute summary carries none", () => {
    expect(concludeSummary({ _tag: "success" }, details(undefined))).not.toContain("Provenance");
    expect(confidentialSummary({ _tag: "success" }, details([logged]), undefined)).not.toContain(
      ENVELOPE,
    );
  });
});
