// The actuators the control plane runs, one per actuator binding the profile names: the check-run applier under
// `checkRun` and the side-output applier under every other binding, `verdictRecord` included. The drainer sends each
// row to the binding its kind names (mameko specs/outbox.md § The actuator port and the actuator rate limit;
// specs/github-output.md § Scope).
import { type Actuator, Actuators, actuatorRegistry } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { makeCheckRunApplier } from "./applier.ts";
import { makeSideOutputApplier } from "./side-applier.ts";

/** The actuator bindings the side-output applier serves. */
export const SIDE_OUTPUT_BINDINGS = [
  "issueComment",
  "pullReview",
  "issue",
  "pullRequest",
  "release",
  "canary",
  "webhookRedelivery",
  "labels",
  "followOn",
  "notifyEmail",
  "notifySlack",
  "notice",
  "verdictRecord",
] as const;

/** Every GitHub binding's actuator, keyed by binding name. */
export const makeGithubActuators = Effect.gen(function* () {
  const checkRun = yield* makeCheckRunApplier;
  const sides = yield* makeSideOutputApplier;
  const byName: Record<string, Required<Actuator>> = { checkRun };
  for (const name of SIDE_OUTPUT_BINDINGS) byName[name] = sides;
  return byName;
});

/** The `Actuators` registry over every GitHub binding. */
export const GithubApplierLive = Layer.effect(
  Actuators,
  Effect.map(makeGithubActuators, (byName) => actuatorRegistry(byName)),
);
