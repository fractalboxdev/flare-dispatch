import { Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeJobRecord,
  decodeVerdictRecord,
  JobRecordPayload,
  jobRecordPayload,
  VerdictRecordPayload,
  verdictRecordPayload,
  type JobRecordRequest,
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
