// The application ports the composition supplies against mameko's configuration validation (MAMEKO-HOST-045).
import { buildProfile, missingPorts } from "@fractalboxdev/flare-dispatch-profile";
import { describe, expect, it } from "vitest";
import type { ControlPlaneEnv } from "../src/config.ts";
import { suppliedPorts } from "../src/ports.ts";

const env = (extra: Partial<ControlPlaneEnv>) =>
  ({ PLANE_ID: "flare-dispatch", ...extra }) as unknown as ControlPlaneEnv;

describe("the composition's application ports", () => {
  it("[FD-ARCH-039] MAMEKO-HOST-045 a deploy with the GitHub App supplies every port the phase 0 profile uses", () => {
    const withApp = env({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "key" });
    expect(missingPorts(buildProfile("production"), suppliedPorts(withApp))).toEqual([]);
    expect(missingPorts(buildProfile("development"), suppliedPorts(withApp))).toEqual([]);
  });

  it("[FD-ARCH-039] MAMEKO-HOST-045 names the applier ports a deploy without the App lacks", () => {
    expect(missingPorts(buildProfile("production"), suppliedPorts(env({})))).toEqual([
      "actuator",
      "actuator-rate-limit",
    ]);
  });
});
