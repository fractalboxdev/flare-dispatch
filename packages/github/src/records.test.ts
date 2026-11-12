import { Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeJobRecord,
  decodeRunReport,
  decodeVerdictRecord,
  JobRecordPayload,
  jobRecordPayload,
  VerdictRecordPayload,
  verdictRecordPayload,
  type JobRecordRequest,
  type ReportedFinding,
  type RunReport,
  type VerdictRecordRequest,
} from "./records.ts";

const lease: JobRecordRequest = {
  executionId: "exec-1",
  epoch: 3,
  run: "check",
  repository: "acme/widgets",
  commitSha: "a".repeat(40),
  class: "required",
  executorKind: "cloudflare",
};

const terminal: VerdictRecordRequest = {
  executionId: "exec-1",
  epoch: 3,
  run: "check",
  repository: "acme/widgets",
  commitSha: "a".repeat(40),
  ref: "refs/pull/7/head",
  class: "required",
  trigger: "pull_request",
  verdict: { _tag: "failure", category: "finding", reason: "2 tests failed" },
  conclusion: "failure",
  checkName: "flare-dispatch/check",
};

/** What a request may carry beside the record's fields: the input, the logs and the secrets. */
const SENSITIVE = {
  input_json: '{"token":"ghs_input_secret"}',
  inputJson: '{"token":"ghs_input_secret"}',
  logs: "step 1: echo ghs_log_secret",
  logText: "step 1: echo ghs_log_secret",
  secret: "records-signing-key-value",
  installationToken: "ghs_installation_secret",
};

describe("job.record", () => {
  it("[FD-GH-093] the jobRecordPayload binding holds the execution id, epoch, run, repository, commit SHA, class and executor kind", () => {
    const payload = jobRecordPayload(lease);
    expect(payload).toEqual({
      schema: "job-record/v1",
      execution_id: "exec-1",
      epoch: 3,
      run: "check",
      repository: "acme/widgets",
      commit_sha: "a".repeat(40),
      class: "required",
      executor_kind: "cloudflare",
    });
    expect(Exit.isSuccess(decodeJobRecord(payload))).toBe(true);
  });
});

describe("verdict.record", () => {
  it("[FD-GH-095] the payload holds the schema verdict-record/v1, execution id, epoch, run, repository, commit SHA, ref, class, trigger, verdict, reason, conclusion and check name", () => {
    const payload = verdictRecordPayload(terminal);
    expect(payload).toEqual({
      schema: "verdict-record/v1",
      execution_id: "exec-1",
      epoch: 3,
      run: "check",
      repository: "acme/widgets",
      commit_sha: "a".repeat(40),
      ref: "refs/pull/7/head",
      class: "required",
      trigger: "pull_request",
      verdict: "failure",
      reason: "2 tests failed",
      conclusion: "failure",
      check_name: "flare-dispatch/check",
    });
    expect(Exit.isSuccess(decodeVerdictRecord(payload))).toBe(true);

    // The reason of each outcome; a halt whose key is paused has no conclusion yet, and a run with no check no name.
    const of = (r: Partial<VerdictRecordRequest>) => verdictRecordPayload({ ...terminal, ...r });
    expect(of({ verdict: { _tag: "success" }, conclusion: "success" })).toMatchObject({
      verdict: "success",
      reason: null,
    });
    expect(of({ verdict: { _tag: "cancelled", cause: "superseded" } })).toMatchObject({
      verdict: "cancelled",
      reason: "superseded",
    });
    expect(
      of({ verdict: { _tag: "skipped", reason: "not-applicable", detail: "draft-pr" } }),
    ).toMatchObject({ verdict: "skipped", reason: "not-applicable: draft-pr" });
    // A skip with no detail states its reason alone, as the execution row does.
    expect(of({ verdict: { _tag: "skipped", reason: "x", detail: "" } })).toMatchObject({
      verdict: "skipped",
      reason: "x",
    });
    expect(
      of({
        verdict: { _tag: "failure", category: "halt", reason: "halt: operator" },
        conclusion: null,
        checkName: null,
      }),
    ).toMatchObject({ verdict: "failure", conclusion: null, check_name: null });
    expect(of({ verdict: { _tag: "deferred" } })).toMatchObject({
      verdict: "deferred",
      reason: null,
    });

    // A payload missing a field, or naming another schema, is refused.
    const { check_name: _dropped, ...missing } = payload;
    expect(Exit.isFailure(decodeVerdictRecord(missing))).toBe(true);
    expect(Exit.isFailure(decodeVerdictRecord({ ...payload, schema: "verdict-record/v2" }))).toBe(
      true,
    );
  });
});

describe("verdict.record scan results and findings", () => {
  const finding = (i: number, ruleId = "generic-api-key"): ReportedFinding => ({
    ruleId,
    fingerprint: i.toString(16).padStart(64, "0"),
    path: `src/f${i}.ts`,
    startLine: i + 1,
    endLine: i + 1,
    level: "failure",
  });
  const scan: NonNullable<RunReport["scan"]> = {
    bundle_digest: `sha256:${"b".repeat(64)}`,
    advisory_snapshots: [
      { ecosystem: "npm", digest: `sha256:${"e".repeat(64)}` },
      { ecosystem: "PyPI", digest: `sha256:${"f".repeat(64)}` },
    ],
    scanners: [
      { name: "gitleaks", version: "8.30.1", result: "finding" },
      { name: "zizmor", version: "1.32.0", result: "nothing-in-scope" },
      { name: "osv-scanner", version: "2.7.0", result: null },
    ],
  };

  it("[FD-GH-096] holds the scan bundle digest, each advisory snapshot digest, each scanner's name, version and result, and the findings the run reports", () => {
    const findings = [finding(0), finding(1, "unpinned-uses")];
    const payload = verdictRecordPayload({
      ...terminal,
      reports: [{ scan, findings, findingsTruncated: false }],
    });
    expect(payload).toMatchObject({ schema: "verdict-record/v1", execution_id: "exec-1" });
    expect(payload.scan).toEqual(scan);
    expect(payload.findings).toEqual(findings);
    expect(payload.findingsTruncated).toBe(false);
    expect(Exit.isSuccess(decodeVerdictRecord(payload))).toBe(true);

    // A run that reports neither yields neither member, so an absent list is never read as no finding.
    const plain = verdictRecordPayload({ ...terminal, reports: [] });
    expect(Object.keys(plain)).not.toContain("scan");
    expect(Object.keys(plain)).not.toContain("findings");
    expect(Object.keys(plain)).not.toContain("findingsTruncated");
    expect(Exit.isSuccess(decodeVerdictRecord(plain))).toBe(true);
    // A run that reports an empty list holds it: no finding was found.
    expect(verdictRecordPayload({ ...terminal, reports: [{ findings: [] }] })).toMatchObject({
      findings: [],
      findingsTruncated: false,
    });
  });

  it("[FD-GH-096] holds at most 200 findings, and sets findingsTruncated where the run found more", () => {
    // Two reports of one execution, 150 findings each: the record holds the first 200 in report order.
    const first = Array.from({ length: 150 }, (_, i) => finding(i));
    const second = Array.from({ length: 150 }, (_, i) => finding(150 + i, "pr-review/security"));
    const payload = verdictRecordPayload({
      ...terminal,
      reports: [
        { scan, findings: first },
        { findings: second, findingsTruncated: false },
      ],
    });
    expect(payload.findings).toHaveLength(200);
    expect(payload.findings).toEqual([...first, ...second].slice(0, 200));
    expect(payload.findingsTruncated).toBe(true);
    expect(Exit.isSuccess(decodeVerdictRecord(payload))).toBe(true);
    // A record of 201 findings is refused.
    expect(
      Exit.isFailure(
        decodeVerdictRecord({ ...payload, findings: [...first, ...second].slice(0, 201) }),
      ),
    ).toBe(true);

    // Exactly 200 is not truncated; a run that says it listed fewer than it found is.
    const exactly = Array.from({ length: 200 }, (_, i) => finding(i));
    expect(
      verdictRecordPayload({ ...terminal, reports: [{ findings: exactly }] }).findingsTruncated,
    ).toBe(false);
    expect(
      verdictRecordPayload({
        ...terminal,
        reports: [{ findings: [finding(0)], findingsTruncated: true }],
      }),
    ).toMatchObject({ findings: [finding(0)], findingsTruncated: true });
  });

  it("[FD-GH-096] reads a run's report from its check payload and copies only the declared fields", () => {
    // A pr-review finding as the run holds it: the reviewer's title and message stay out of the record.
    const reviewed = {
      ...finding(3, "pr-review/security"),
      title: "t",
      message: "secret-ish text",
    };
    const decoded = decodeRunReport({
      name: "flare-dispatch/pr-review",
      head_sha: "a".repeat(40),
      annotations: [],
      report: { findings: [reviewed], findingsTruncated: false },
    });
    expect(decoded._tag).toBe("Some");
    const report = decoded._tag === "Some" ? decoded.value.report : {};
    const payload = verdictRecordPayload({ ...terminal, reports: [report] });
    expect(payload.findings).toEqual([finding(3, "pr-review/security")]);
    expect(JSON.stringify(payload)).not.toContain("secret-ish text");
    // A payload without a report, or with a finding that has no fingerprint, reports nothing.
    expect(decodeRunReport({ name: "x", markdown: "" })._tag).toBe("None");
    const { fingerprint: _f, ...unidentified } = finding(4);
    expect(decodeRunReport({ report: { findings: [unidentified] } })._tag).toBe("None");
  });
});

describe("record contents", () => {
  it("[FD-GH-097] neither record payload holds input_json, log text or a secret value", () => {
    // The schemas declare exactly the record's fields.
    expect(Object.keys(JobRecordPayload.fields).sort()).toEqual(
      [
        "schema",
        "execution_id",
        "epoch",
        "run",
        "repository",
        "commit_sha",
        "class",
        "executor_kind",
      ].sort(),
    );
    expect(Object.keys(VerdictRecordPayload.fields).sort()).toEqual(
      [
        "schema",
        "execution_id",
        "epoch",
        "run",
        "repository",
        "commit_sha",
        "ref",
        "class",
        "trigger",
        "verdict",
        "reason",
        "conclusion",
        "check_name",
        "scan",
        "findings",
        "findingsTruncated",
      ].sort(),
    );

    // A request that carries the input, the logs and secrets beside the fields yields a record of none of them.
    const leaseWithExtras: JobRecordRequest = { ...lease, ...SENSITIVE };
    const terminalWithExtras: VerdictRecordRequest = { ...terminal, ...SENSITIVE };
    for (const record of [
      jobRecordPayload(leaseWithExtras),
      verdictRecordPayload(terminalWithExtras),
    ]) {
      const body = JSON.stringify(record);
      for (const [key, value] of Object.entries(SENSITIVE)) {
        expect(body).not.toContain(`"${key}"`);
        expect(body).not.toContain(value);
      }
      expect(body).not.toContain("ghs_");
    }

    // A payload carrying any of them is refused, so no row holds one.
    for (const key of ["input_json", "logs", "secret"]) {
      expect(Exit.isFailure(decodeJobRecord({ ...jobRecordPayload(lease), [key]: "x" })), key).toBe(
        true,
      );
      expect(
        Exit.isFailure(decodeVerdictRecord({ ...verdictRecordPayload(terminal), [key]: "x" })),
        key,
      ).toBe(true);
    }
  });
});
