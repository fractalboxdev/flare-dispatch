// The control plane's records configuration: the rendered `RECORDS_URL` decides whether the profile it serves declares
// the record kinds (specs/github-output.md § Job and verdict records).
import { SideOutputConfig } from "@fractalboxdev/flare-dispatch-github";
import { ConfigurationSource } from "@fractalboxdev/mameko-ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  configurationSourceOf,
  profileOf,
  recordsUrlOf,
  type ControlPlaneEnv,
} from "../src/config.ts";
import { recordsEndpointOf, sideOutputLayer } from "../src/github.ts";

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

  it("[FD-GH-093] mameko's configuration source delivers the document the control plane serves, at its policy version", () => {
    const loaded = (e: ControlPlaneEnv) =>
      Effect.runSync(
        Effect.flatMap(ConfigurationSource, (source) => source.load).pipe(
          Effect.provide(configurationSourceOf(e, 2)),
        ),
      );
    for (const e of [env({ RECORDS_URL: "https://records.example.com/hook" }), env({})]) {
      const { document, policyVersion } = loaded(e);
      expect(policyVersion).toBe(profileOf(e, 2).policy_version);
      expect(document).toEqual(profileOf(e, 2));
    }
    expect(loaded(env({ RECORDS_URL: "https://records.example.com/hook" })).policyVersion).toBe(
      "flare-dispatch.v2.0-phase2-records",
    );
  });

  it("[FD-GH-098] the side-output applier signs records with RECORDS_SIGNING_KEY and posts them to RECORDS_URL, and has no endpoint without both", () => {
    const app = { appId: "1", privateKeyPem: "pem", fetch };
    const recordsOf = (e: ControlPlaneEnv) =>
      Effect.runSync(
        SideOutputConfig.use((s) => Effect.succeed(s.records)).pipe(
          Effect.provide(sideOutputLayer(e, app)),
        ),
      );
    const set = env({
      RECORDS_URL: " https://records.example.com/hook ",
      RECORDS_SIGNING_KEY: "records-key",
    });
    expect(recordsEndpointOf(set)).toEqual({
      url: "https://records.example.com/hook",
      secret: "records-key",
    });
    expect(recordsOf(set)).toEqual({
      url: "https://records.example.com/hook",
      secret: "records-key",
    });
    for (const unset of [
      env({ RECORDS_URL: "https://records.example.com/hook" }),
      env({ RECORDS_URL: "https://records.example.com/hook", RECORDS_SIGNING_KEY: " " }),
      env({ RECORDS_URL: "", RECORDS_SIGNING_KEY: "records-key" }),
    ]) {
      expect(recordsEndpointOf(unset)).toBeUndefined();
      expect(recordsOf(unset)).toBeUndefined();
    }
  });
});
