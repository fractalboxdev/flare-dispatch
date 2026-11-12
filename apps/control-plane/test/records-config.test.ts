// The control plane's records configuration: the rendered `RECORDS_URL` decides whether the profile it serves declares
// the record kinds (specs/github-output.md § Job and verdict records).
import { describe, expect, it } from "vitest";
import { profileOf, recordsUrlOf, type ControlPlaneEnv } from "../src/config.ts";

const env = (vars: Partial<ControlPlaneEnv>) => vars as ControlPlaneEnv;

describe("records configuration", () => {
  it("[FD-GH-093] the control plane's phase 2 profile generates job.record on lease-granted exactly where RECORDS_URL is set", () => {
    const set = env({ RECORDS_URL: "https://records.example.com/hook" });
    expect(recordsUrlOf(set)).toBe("https://records.example.com/hook");
    expect(profileOf(set, 2).intent_kinds["job.record"]).toMatchObject({
      on: "lease-granted",
      payload: "jobRecordPayload",
    });
    expect(profileOf(set, 2).intent_kinds["verdict.record"]).toMatchObject({ ops: true });

    // The var renders empty where the overlay sets no `records.url`.
    for (const unset of [env({}), env({ RECORDS_URL: "" }), env({ RECORDS_URL: "  " })]) {
      expect(recordsUrlOf(unset)).toBeUndefined();
      expect(profileOf(unset, 2).intent_kinds["job.record"]).toBeUndefined();
      expect(profileOf(unset, 2).intent_kinds["verdict.record"]).toBeUndefined();
    }
    // The committed phase serves no record kind yet.
    expect(profileOf(set).intent_kinds["job.record"]).toBeUndefined();
  });
});
