// The GitHub services of one isolate. With the App's id and key, `githubLiveLayer` serves every read and the applier
// of every GitHub kind. A `development` deployment without them reads the captured repository of `dev-repository.ts`.
// Any other deployment without them has no GitHub reads: each fails `GithubUncredentialed`, and nothing is applied.
import {
  GithubRead,
  GithubUncredentialed,
  GithubUnexpected,
  githubLiveLayer,
  SideOutputConfig,
  type AppOptions,
} from "@fractalboxdev/flare-dispatch-github";
import type { AlarmPort, ApplierRateLimit, EffectApplier } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import type { ControlPlaneEnv } from "./config.ts";
import { devFile, devRepositoryOf, type DevRepository } from "./dev-repository.ts";

/** `fetch` as a plain function: workerd refuses it called as a method of another object. */
export const boundFetch: typeof fetch = (input, init) => fetch(input, init);

/** The App's id and private key, when the deploy holds both. */
export const appOptionsOf = (env: ControlPlaneEnv): AppOptions | undefined =>
  env.GITHUB_APP_ID === undefined ||
  env.GITHUB_APP_ID === "" ||
  env.GITHUB_APP_PRIVATE_KEY === undefined ||
  env.GITHUB_APP_PRIVATE_KEY === ""
    ? undefined
    : { appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, fetch: boundFetch };

/** The App's bot login, `<app slug>[bot]`: the author of every commit the App writes. */
export const appLoginOf = (env: ControlPlaneEnv) =>
  `${env.GITHUB_APP_SLUG ?? "flare-dispatch"}[bot]`;

/** The identity the App commits as, and the Slack endpoint when the deploy names one. */
export const sideOutputLayer = (env: ControlPlaneEnv, app: AppOptions) => {
  const slug = env.GITHUB_APP_SLUG ?? "flare-dispatch";
  return Layer.succeed(SideOutputConfig, {
    appBot: {
      login: `${slug}[bot]`,
      name: `${slug}[bot]`,
      email: `${app.appId}+${slug}[bot]@users.noreply.github.com`,
    },
    slack:
      env.SLACK_URL === undefined || env.SLACK_SECRET === undefined
        ? undefined
        : { url: env.SLACK_URL, secret: env.SLACK_SECRET },
    fetch: boundFetch,
  });
};

/** Every GitHub service under the App's authority; built once per isolate. */
export const appServices = (
  env: ControlPlaneEnv,
  app: AppOptions,
  alarms: Layer.Layer<AlarmPort>,
) => githubLiveLayer(app).pipe(Layer.provide(Layer.merge(sideOutputLayer(env, app), alarms)));

export type AppServices = Layer.Success<ReturnType<typeof appServices>>;
export type { EffectApplier, ApplierRateLimit };

const unknown = (what: string) =>
  Effect.fail(new GithubUnexpected({ message: `the captured repository does not hold ${what}` }));

/** The captured repository's reads: its own facts answer, every other read fails. */
export const devGithubRead = (dev: DevRepository) => {
  const ours = (repo: string) => repo.toLowerCase() === dev.repository.toLowerCase();
  const uncredentialed = (repo: string) => Effect.fail(new GithubUncredentialed({ repo }));
  return Layer.succeed(GithubRead, {
    installation: (repo) => (ours(repo) ? Effect.succeed(dev.installation) : uncredentialed(repo)),
    file: (repo, path, ref) => {
      if (!ours(repo)) return uncredentialed(repo);
      if (ref !== dev.head) return unknown(`${path} at ${ref}`);
      const text = devFile(dev, path);
      return text === undefined
        ? unknown(path)
        : Effect.succeed(
            text === null ? null : { size: new TextEncoder().encode(text).byteLength, text },
          );
    },
    defaultBranch: (repo) =>
      ours(repo) ? Effect.succeed(dev.default_branch) : uncredentialed(repo),
    branchHead: (repo, branch) =>
      !ours(repo)
        ? uncredentialed(repo)
        : branch === dev.default_branch
          ? Effect.succeed(dev.head)
          : unknown(`the head of ${branch}`),
    openPulls: (repo) => (ours(repo) ? unknown("pull requests") : uncredentialed(repo)),
    checkRuns: (repo) => (ours(repo) ? unknown("check runs") : uncredentialed(repo)),
    requiredChecks: (repo) => (ours(repo) ? unknown("branch rules") : uncredentialed(repo)),
    repositories: () => unknown("an installation's repositories"),
  });
};

/** No App: every read fails, since no installation serves any repository (FD-GH-003). */
export const noGithubRead = Layer.succeed(GithubRead, {
  installation: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  file: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  defaultBranch: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  branchHead: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  openPulls: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  checkRuns: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  requiredChecks: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  repositories: (installation) =>
    Effect.fail(new GithubUncredentialed({ repo: `installation ${installation}` })),
});

/** The reads of a deploy without the App. */
export const readsWithoutApp = (env: ControlPlaneEnv) => {
  const dev = devRepositoryOf(env);
  return dev === undefined ? noGithubRead : devGithubRead(dev);
};
