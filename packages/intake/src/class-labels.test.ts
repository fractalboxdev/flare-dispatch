// Intake's class resolution admits the label `resolveClass` attaches to a security scan run, so `cloud-only` holds for
// that run from phase 2 (specs/profile.md § Placement).
import { buildProfile, placementInputs } from "@fractalboxdev/flare-dispatch-profile";
import { AlarmPort } from "@fractalboxdev/mameko-ports";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ClassResolver, IntakeConfig, type ClassRequest } from "./config.ts";
import { profileClassResolver } from "./layer.ts";
import { ProtectionSnapshots } from "./protection.ts";
import type { IntakeRun } from "./runs.ts";

const runNamed = (name: string): IntakeRun => ({
  name,
  params: Schema.Unknown,
  input: Schema.Unknown,
  trigger: () => Option.none(),
  defaultClass: "interactive",
  maxDurationSec: 600,
  ownsCheck: true,
  gating: false,
  retries: 1,
});

const request = (run: string): ClassRequest => ({
  run: runNamed(run),
  trigger: "dispatch",
  event: null,
  repo: "acme/app",
  ref: "refs/heads/main",
  sha: "abc123",
  defaultBranch: "main",
  targetBranch: null,
  refProtection: null,
  checkName: `flare-dispatch/${run}`,
  classInput: null,
  caller: null,
});

const resolve = (run: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* ClassResolver).resolve(request(run));
    }).pipe(
      Effect.provide(
        profileClassResolver.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(IntakeConfig, {
                catalog: () => undefined,
                profile: buildProfile("production", 2),
                appId: 1,
                webhookSecret: undefined,
                webhookEvents: undefined,
                allows: () => true,
                confidentiality: () => "unclassified",
                writeCredentialIn: () => null,
              }),
              Layer.succeed(AlarmPort, { deliver: () => Effect.void }),
              Layer.succeed(ProtectionSnapshots, {
                requiredSet: () => Effect.die("a scan run reads no required set"),
                refProtected: () => Effect.succeed(false),
                refresh: () => Effect.succeed(false),
              }),
            ),
          ),
        ),
      ),
    ),
  );

describe("class resolution of a security scan run", () => {
  it("[FD-PROF-066] admits security-scan on security-gate and security-rescan, and cloud-only holds for them from phase 2", async () => {
    for (const run of ["security-gate", "security-rescan"]) {
      const resolution = await resolve(run);
      expect(resolution).toEqual({
        _tag: "Class",
        class: "interactive",
        labels: ["security-scan"],
        alarm: null,
      });
      const labels = resolution._tag === "Class" ? resolution.labels : [];
      const { facts } = placementInputs(buildProfile("production", 2), {
        class: "interactive",
        labels,
      });
      expect(facts.cloudOnly).toBe(true);
    }
    expect(await resolve("check")).toMatchObject({ _tag: "Class", labels: [] });
  });
});
