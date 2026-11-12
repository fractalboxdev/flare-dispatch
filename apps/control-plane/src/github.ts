// The GitHub services of one isolate. With the App's id and key, `githubLiveLayer` serves every read and the applier
// of every GitHub kind. A `development` deployment without them reads the captured repository of `dev-repository.ts`.
// Any other deployment without them has no GitHub reads: each fails `GithubUncredentialed`, and nothing is applied.
// The API's configuration and links by their own entries: the package's index loads its D1 and Durable Object Layers.
import {
  ApiConfig,
  apiConfigFromEnv,
  ConfigInvalid,
  type ApiConfigShape,
} from "@fractalboxdev/flare-dispatch-api/config";
import { executionLinks } from "@fractalboxdev/flare-dispatch-api/links";
import { statementLinks } from "@fractalboxdev/flare-dispatch-api/statements";
import { statementRecordOf } from "@fractalboxdev/flare-dispatch-api/statements-live";
import {
  d1LogAppendStore,
  StatementLogged,
  StatementLoggedFailed,
} from "@fractalboxdev/flare-dispatch-cache";
import {
  ConcludeFacts,
  ConcludeFactsUnavailable,
  conclusionFactsOf,
  GithubRead,
  GithubUncredentialed,
  GithubUnexpected,
  githubLiveLayer,
  insertProvenanceRefresh,
  installationQuotaObjectLayer,
  SideOutputConfig,
  d1CommentWrites,
  type AppOptions,
} from "@fractalboxdev/flare-dispatch-github";
import { d1IntakeStore, IntakeStore } from "@fractalboxdev/flare-dispatch-intake";
import { APP_BINDINGS, unsetBindings } from "@fractalboxdev/flare-dispatch-ops";
import type { ActuatorRateLimit, Actuators, AlarmPort } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { apiEnvOf, concludeKindOf, profileOf, type ControlPlaneEnv } from "./config.ts";
import {
  devFile,
  devRepositoryOf,
  repositoryConfidentiality,
  type DevRepository,
} from "./dev-repository.ts";

/** `fetch` as a plain function: workerd refuses it called as a method of another object. */
export const boundFetch: typeof fetch = (input, init) => fetch(input, init);

/** The App's id and private key, when the deploy holds both. */
export const appOptionsOf = (env: ControlPlaneEnv): AppOptions | undefined =>
  // The ops package's `APP_BINDINGS`, which the deploy stage's composition check reads too (FD-ARCH-039).
  unsetBindings(env, APP_BINDINGS).length > 0
    ? undefined
    : {
        appId: env.GITHUB_APP_ID as string,
        privateKeyPem: env.GITHUB_APP_PRIVATE_KEY as string,
        fetch: boundFetch,
      };

/** The App's bot login, `<app slug>[bot]`: the author of every commit the App writes. */
export const appLoginOf = (env: ControlPlaneEnv) =>
  `${env.GITHUB_APP_SLUG ?? "flare-dispatch"}[bot]`;

/** The identity the App commits as, and the Slack endpoint when the deploy names one. */
export const sideOutputLayer = (env: ControlPlaneEnv, app: AppOptions) => {
  const slug = env.GITHUB_APP_SLUG ?? "flare-dispatch";
  return Layer.succeed(SideOutputConfig, {
    commentWrites: d1CommentWrites(env.DB),
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

/**
 * The link configuration a check run's log link is minted under: the API's, at the deploy's `PUBLIC_ORIGIN`. A deploy
 * that names no public origin, or whose API configuration is invalid, writes no details link, since a tick has no
 * request origin to fall back on.
 */
export const linkConfigOf = (env: ControlPlaneEnv): ApiConfigShape | undefined => {
  const origin = env.PUBLIC_ORIGIN?.trim();
  if (origin === undefined || origin === "") return undefined;
  const config = apiConfigFromEnv(apiEnvOf(env), origin);
  return config instanceof ConfigInvalid ? undefined : config;
};

/**
 * The facts of an execution's conclusion: the intake record beside mameko's execution, placement and reservation rows,
 * with the log viewer link carrying a link token minted for a check run (FD-GH-013, FD-GH-015), the links of each
 * provenance statement recorded for the execution (FD-PROV-042), and a repository's confidentiality mode as
 * `repositoryConfidentiality` reads it (FD-GH-019).
 */
export const concludeFactsLayer = (env: ControlPlaneEnv) =>
  Layer.effect(
    ConcludeFacts,
    Effect.gen(function* () {
      const store = yield* IntakeStore;
      const statements = d1LogAppendStore(env.DB as unknown as D1Database);
      const links = linkConfigOf(env);
      const confidentiality = repositoryConfidentiality(env);
      return {
        confidentialCompute: (repo: string) => confidentiality(repo) === "confidential-compute",
        of: (executionId: string) =>
          Effect.gen(function* () {
            const record = yield* store
              .conclusionFacts(executionId)
              .pipe(
                Effect.catchTag("StoreUnavailable", ({ message }) =>
                  Effect.fail(new ConcludeFactsUnavailable({ message })),
                ),
              );
            if (record === null) return null;
            const detailsUrl =
              links === undefined
                ? undefined
                : (yield* executionLinks(executionId, "check-run").pipe(
                    Effect.provideService(ApiConfig, links),
                  )).logs_url;
            const facts = conclusionFactsOf(record, detailsUrl);
            if (links === undefined) return facts;
            const provenance = yield* statements
              .forExecution(executionId)
              .pipe(
                Effect.catchTag("LogAppendStoreFailed", ({ message }) =>
                  Effect.fail(new ConcludeFactsUnavailable({ message })),
                ),
              );
            return provenance.length === 0
              ? facts
              : {
                  ...facts,
                  details: {
                    ...facts.details,
                    provenance: provenance.map((intent) =>
                      statementLinks(links.publicOrigin, statementRecordOf(intent)),
                    ),
                  },
                };
          }),
      };
    }),
  ).pipe(Layer.provide(d1IntakeStore(env.DB)));

/**
 * What the log-append drain tells once a statement's append succeeds: an execution with a conclusion row gets a
 * `check.conclude` row of the profile's kind that renders its summary again with the statement's links (FD-PROV-042).
 * A failed insert retries the append.
 */
export const statementLoggedLayer = (env: ControlPlaneEnv) =>
  Layer.succeed(StatementLogged, {
    notify: (statement, now) =>
      insertProvenanceRefresh(env.DB, concludeKindOf(profileOf(env)), statement, now).pipe(
        Effect.asVoid,
        Effect.catchTag("ProvenanceRefreshUnavailable", ({ message }) =>
          Effect.fail(new StatementLoggedFailed({ message })),
        ),
      ),
  });

/**
 * The quota of every limit key: its `InstallationQuota` object, so each isolate's applier calls for one installation
 * take their permits from one ledger (FD-ARCH-003).
 */
export const sharedQuota = (env: Pick<ControlPlaneEnv, "INSTALLATION_QUOTA">) =>
  installationQuotaObjectLayer((limitKey) =>
    env.INSTALLATION_QUOTA.get(env.INSTALLATION_QUOTA.idFromName(limitKey)),
  );

/** Every GitHub service under the App's authority, over the shared quota; built once per isolate. */
export const appServices = (
  env: ControlPlaneEnv,
  app: AppOptions,
  alarms: Layer.Layer<AlarmPort>,
) =>
  githubLiveLayer(app, sharedQuota(env)).pipe(
    Layer.provide(Layer.mergeAll(sideOutputLayer(env, app), alarms, concludeFactsLayer(env))),
  );

export type AppServices = Layer.Success<ReturnType<typeof appServices>>;
export type { Actuators, ActuatorRateLimit };

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
    visibility: (repo) =>
      !ours(repo)
        ? uncredentialed(repo)
        : dev.visibility === undefined
          ? unknown("its visibility")
          : Effect.succeed(dev.visibility),
    branchHead: (repo, branch) =>
      !ours(repo)
        ? uncredentialed(repo)
        : branch === dev.default_branch
          ? Effect.succeed(dev.head)
          : unknown(`the head of ${branch}`),
    openPulls: (repo) => (ours(repo) ? unknown("pull requests") : uncredentialed(repo)),
    checkRuns: (repo) => (ours(repo) ? unknown("check runs") : uncredentialed(repo)),
    requiredChecks: (repo) => (ours(repo) ? unknown("branch rules") : uncredentialed(repo)),
    refProtected: (repo) => (ours(repo) ? unknown("rulesets") : uncredentialed(repo)),
    permission: (repo) => (ours(repo) ? unknown("collaborator permissions") : uncredentialed(repo)),
    repositories: () => unknown("an installation's repositories"),
  });
};

/** No App: every read fails, since no installation serves any repository (FD-GH-003). */
export const noGithubRead = Layer.succeed(GithubRead, {
  installation: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  file: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  defaultBranch: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  visibility: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  branchHead: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  openPulls: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  checkRuns: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  requiredChecks: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  refProtected: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  permission: (repo) => Effect.fail(new GithubUncredentialed({ repo })),
  repositories: (installation) =>
    Effect.fail(new GithubUncredentialed({ repo: `installation ${installation}` })),
});

/** The reads of a deploy without the App. */
export const readsWithoutApp = (env: ControlPlaneEnv) => {
  const dev = devRepositoryOf(env);
  return dev === undefined ? noGithubRead : devGithubRead(dev);
};
