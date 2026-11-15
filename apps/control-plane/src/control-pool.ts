// The `control` pool's run catalogue with the services the control plane builds inside each execution
// (`control-runs.ts`). The `offload-test` parent runs in the pool controller's Durable Object, inside the control plane,
// so it reaches its services directly rather than through an egress grant:
//
// - `MatrixChildren` over intake's admission and mameko's store (`matrixChildrenLayer`), for the execution its
//   `ExecutionLease` names;
// - `GithubRead` under the App installation token the control plane holds for the repository; a deploy without the App
//   fails every read `GithubUncredentialed` (FD-RUN-017).
import {
  controlRuns,
  type ControlRunServices,
} from "@fractalboxdev/flare-dispatch-catalog/control-runs";
import {
  GithubRead,
  GithubReadFailed,
  GithubUncredentialed,
  githubReadOver,
  type ExecutionLease,
  type GithubGet,
} from "@fractalboxdev/flare-dispatch-catalog";
import {
  GithubApp,
  InstallationDirectory,
  InstallationQuota,
  restRequest,
  tokenFromApp,
} from "@fractalboxdev/flare-dispatch-github";
import {
  matrixChildrenLayer,
  type Admission,
  type IntakeConfig,
  type IntakeStore,
  type MatrixChildrenOptions,
} from "@fractalboxdev/flare-dispatch-intake";
import { Context, Effect, Layer, Schema } from "effect";
import type { ControlPlaneEnv } from "./config.ts";
import { appOptionsOf, type DeployedApp } from "./github.ts";

/** The isolate's services did not build, so the execution has no services to run on. */
export class ControlServicesUnavailable extends Schema.TaggedError<ControlServicesUnavailable>()(
  "ControlServicesUnavailable",
  { detail: Schema.String },
) {}

/**
 * One GET under the installation that serves the repository: a repository no installation serves, or a `401`, is
 * `GithubUncredentialed`; any other refusal or a lost request is `GithubReadFailed`.
 */
const appGithubGet = (app: DeployedApp) =>
  Effect.gen(function* () {
    const github = yield* GithubApp;
    const directory = yield* InstallationDirectory;
    const request = restRequest(
      {
        fetch: app.fetch,
        token: tokenFromApp(github),
        ...(app.baseUrl === undefined ? {} : { baseUrl: app.baseUrl }),
      },
      yield* InstallationQuota,
    );
    const get: GithubGet = (what, repo, path) =>
      Effect.gen(function* () {
        const installation = yield* directory.installationFor(repo);
        if (installation === null) return yield* new GithubUncredentialed({ what });
        return yield* request<unknown>(installation, "GET", path);
      }).pipe(
        Effect.catchTags({
          GithubHttpError: (e) =>
            e.status === 401
              ? Effect.fail(new GithubUncredentialed({ what }))
              : Effect.fail(new GithubReadFailed({ what, status: e.status, detail: e.message })),
          GithubNetworkError: (e) => Effect.fail(new GithubReadFailed({ what, detail: e.message })),
        }),
      );
    return get;
  });

/** No installation token: every read fails, so no caller decides on a read that never happened (FD-GH-003). */
const uncredentialedGet: GithubGet = (what) => Effect.fail(new GithubUncredentialed({ what }));

/** `GithubRead` for the control pool's runs, over the isolate's GitHub services. */
export const controlGithubRead = <S>(
  env: ControlPlaneEnv,
  services: Context.Context<S>,
): Layer.Layer<GithubRead> => {
  const app = appOptionsOf(env);
  if (app === undefined) return githubReadOver(uncredentialedGet);
  return Layer.unwrap(
    Effect.map(appGithubGet(app), githubReadOver).pipe(
      Effect.provide(
        services as unknown as Context.Context<
          GithubApp | InstallationDirectory | InstallationQuota
        >,
      ),
    ),
  );
};

/**
 * The services of one `offload-test` execution, built from the isolate's services (`isolateServices`) and its
 * `ExecutionLease`.
 */
export const controlRunServices = <S>(
  env: ControlPlaneEnv,
  isolate: () => Promise<Context.Context<S>>,
  options: MatrixChildrenOptions = {},
): Layer.Layer<ControlRunServices, ControlServicesUnavailable, ExecutionLease> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const services = yield* Effect.tryPromise({
        try: isolate,
        catch: (cause) => new ControlServicesUnavailable({ detail: String(cause) }),
      });
      const intake = services as unknown as Context.Context<IntakeConfig | Admission | IntakeStore>;
      return Layer.merge(
        matrixChildrenLayer(env.DB, options).pipe(Layer.provide(Layer.succeedContext(intake))),
        controlGithubRead(env, services),
      );
    }),
  );

/** The `control` pool's run catalogue, with each run's services over the isolate's. */
export const controlPoolRuns = <S>(
  env: ControlPlaneEnv,
  isolate: () => Promise<Context.Context<S>>,
  options: MatrixChildrenOptions = {},
) => controlRuns(controlRunServices(env, isolate, options));
