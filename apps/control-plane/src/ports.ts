// The mameko application ports the composition supplies a Layer for, by port id, which configuration validation reads
// (MAMEKO-HOST-045). Each entry names the Layer `composition.ts` builds for it.
import type { ControlPlaneEnv } from "./config.ts";

const hasApp = (env: ControlPlaneEnv) =>
  env.GITHUB_APP_ID !== undefined &&
  env.GITHUB_APP_ID !== "" &&
  env.GITHUB_APP_PRIVATE_KEY !== undefined &&
  env.GITHUB_APP_PRIVATE_KEY !== "";

export const suppliedPorts = (env: ControlPlaneEnv): readonly string[] => [
  // `ConfigurationSourceLive` and `GateDecisionSourceLive` from the profile package.
  "configuration-source",
  "gate-decision-source",
  // `alarmPortFromEnv` from the operability package.
  "alarm-port",
  // `githubLiveLayer`'s applier of every GitHub kind and its `InstallationQuota` rate limit.
  ...(hasApp(env) ? ["effect-applier", "applier-rate-limit"] : []),
  // `PostureSource` and the agentic package's `localPortsLayer` (`agentic.ts`).
  "posture-source",
  "local-registration",
  "writeback-gate",
  "reuse-policy",
];
