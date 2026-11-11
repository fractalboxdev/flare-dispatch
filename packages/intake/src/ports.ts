// The effects intake causes outside admission: the manifest's failure check run,
// installation eviction and the cancel of a destroyed merge group's executions.
import { GithubApp, GithubClient, GithubRead } from "@fractalboxdev/flare-dispatch-github";
import { Context, Effect, Layer } from "effect";
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
