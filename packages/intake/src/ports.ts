// The effects intake causes outside admission: the manifest's failure check run,
// a held request's queued check run, installation eviction and the cancel of a
// destroyed merge group's executions.
import { GithubApp, GithubClient, GithubRead } from "@fractalboxdev/flare-dispatch-github";
import { checkOpenPayload } from "@fractalboxdev/flare-dispatch-profile";
import { Context, Effect, Layer } from "effect";
import type { IntakeAdmitInput } from "./config.ts";
import { MANIFEST_ERRORS_LISTED } from "./manifest.ts";

export const MANIFEST_CHECK = "flare-dispatch/manifest";

/** Posts the one `failure` check run that lists an invalid manifest's first 20 decode errors (FD-INT-018). */
export class ManifestReporter extends Context.Service<
  ManifestReporter,
  {
    readonly invalid: (repo: string, sha: string, errors: readonly string[]) => Effect.Effect<void>;
  }
>()("@fractalboxdev/flare-dispatch-intake/ManifestReporter") {}

export const manifestSummary = (errors: readonly string[]) => {
  const listed = errors.slice(0, MANIFEST_ERRORS_LISTED);
  const more = errors.length - listed.length;
  return [
    "`.github/flare-dispatch.json` does not decode, so no run of this manifest was submitted.",
    "",
    ...listed.map((e) => `- ${e}`),
    ...(more > 0 ? ["", `and ${more} more`] : []),
  ].join("\n");
};

/**
 * The check run belongs to no execution, so no applier writes it; a GitHub failure is logged, because the shed row
 * already records the refusal.
 */
export const manifestReporterLayer = Layer.effect(
  ManifestReporter,
  Effect.gen(function* () {
    const client = yield* GithubClient;
    const read = yield* GithubRead;
    return {
      invalid: (repo, sha, errors) =>
        Effect.gen(function* () {
          const installation = yield* read.installation(repo);
          yield* client.createCheckRun({
            installation,
            repo,
            body: {
              name: MANIFEST_CHECK,
              head_sha: sha,
              status: "completed",
              conclusion: "failure",
              output: { title: "manifest: invalid", summary: manifestSummary(errors) },
            },
          });
        }).pipe(Effect.catch((e) => Effect.logWarning("manifest check run not posted", e))),
    };
  }),
);

/** The check run a held request's execution owns: its name and head SHA under the execution id (FD-INT-057). */
export interface HeldCheck {
  readonly repo: string;
  readonly executionId: string;
  readonly name: string;
  readonly headSha: string;
}

/**
 * The check run of a held request, as admission's `check.open` row would open it once the request is admitted: none
 * for a run that owns no check or a request that carries `local-only` (FD-GH-005, FD-INT-061).
 */
export const heldCheckOf = (admit: IntakeAdmitInput): HeldCheck | null => {
  const open = checkOpenPayload({ check: admit.check ?? null, labels: admit.labels });
  return open === null
    ? null
    : {
        repo: admit.scopeId,
        executionId: admit.executionId,
        name: open.name,
        headSha: open.head_sha,
      };
};

/**
 * The check run of a request held for its run's cooldown window (FD-INT-057). `queued` posts it `queued` with
 * `external_id` the execution id the request is admitted under, so the `check.open` applier adopts it at release
 * rather than creating a second one (FD-GH-010). `dropped` concludes it `cancelled` when release answers the request
 * with another execution, whose own check run reports it.
 */
export class HeldCheckReporter extends Context.Service<
  HeldCheckReporter,
  {
    readonly queued: (check: HeldCheck) => Effect.Effect<void>;
    readonly dropped: (check: HeldCheck, answeredBy: string) => Effect.Effect<void>;
  }
>()("@fractalboxdev/flare-dispatch-intake/HeldCheckReporter") {}

/**
 * Both writes are reporting: a GitHub failure is logged and the hold or release stands, because `check.open` creates
 * the check run at admission when none carries the execution id.
 */
export const heldCheckReporterLayer = Layer.effect(
  HeldCheckReporter,
  Effect.gen(function* () {
    const client = yield* GithubClient;
    const read = yield* GithubRead;
    return {
      queued: (check) =>
        Effect.gen(function* () {
          const installation = yield* read.installation(check.repo);
          yield* client.createCheckRun({
            installation,
            repo: check.repo,
            body: {
              name: check.name,
              head_sha: check.headSha,
              external_id: check.executionId,
              status: "queued",
            },
          });
        }).pipe(
          Effect.catch((e) =>
            Effect.logWarning("held check run not posted", {
              executionId: check.executionId,
              cause: e,
            }),
          ),
        ),
      dropped: (check, answeredBy) =>
        Effect.gen(function* () {
          const installation = yield* read.installation(check.repo);
          const runs = yield* client.listCheckRuns({
            installation,
            repo: check.repo,
            ref: check.headSha,
            name: check.name,
          });
          for (const run of runs)
            if (run.external_id === check.executionId && run.status !== "completed")
              yield* client.updateCheckRun({
                installation,
                repo: check.repo,
                checkRunId: run.id,
                body: {
                  status: "completed",
                  conclusion: "cancelled",
                  output: {
                    title: "not admitted",
                    summary: `Admission answered this request with execution \`${answeredBy}\`, whose check run reports it.`,
                  },
                },
              });
        }).pipe(
          Effect.catch((e) =>
            Effect.logWarning("held check run not concluded", {
              executionId: check.executionId,
              cause: e,
            }),
          ),
        ),
    };
  }),
);

/** Drops cached installation state before intake answers the webhook that changed it (FD-GH-066). */
export class InstallationEviction extends Context.Service<
  InstallationEviction,
  {
    readonly installation: (id: number) => Effect.Effect<void>;
    readonly repositories: (repos: readonly string[]) => Effect.Effect<void>;
  }
>()("@fractalboxdev/flare-dispatch-intake/InstallationEviction") {}

export const installationEvictionLayer = Layer.effect(
  InstallationEviction,
  Effect.gen(function* () {
    const app = yield* GithubApp;
    return { installation: app.evictInstallation, repositories: app.evictRepositories };
  }),
);
