// The application ports this package serves, as one Layer beside the runtime
// adapter's (mameko specs/hosts.md § Application ports). The live client and the
// applier rate limit share one installation quota, so every response's headers
// reach the permit decisions.
import { drainOnce } from "@fractalboxdev/mameko-coordinator";
import { Effect, Layer } from "effect";
import {
  GithubApp,
  githubAppLayer,
  InstallationDirectoryFromApp,
  tokenFromApp,
  type AppOptions,
} from "./app.ts";
import { CheckRunApplierLive } from "./applier.ts";
import { githubClientLayer, type GithubClientOptions } from "./client.ts";
import {
  ApplierRateLimitLive,
  installationQuotaLayer,
  quotaOptionsDefault,
  type QuotaOptions,
} from "./rate-limit.ts";
import { githubReadLayer } from "./read.ts";
import { GithubApplierLive } from "./github-applier.ts";
import { githubWritesLayer } from "./writes.ts";

/** `EffectApplier` and `ApplierRateLimit`; the application supplies `InstallationDirectory` and `AlarmPort`. */
export const githubApplicationLayer = (
  client: GithubClientOptions,
  quota: QuotaOptions = quotaOptionsDefault,
) =>
  Layer.mergeAll(
    CheckRunApplierLive.pipe(Layer.provide(githubClientLayer(client))),
    ApplierRateLimitLive,
  ).pipe(Layer.provide(installationQuotaLayer(quota)));

/**
 * Every GitHub service of one isolate under the App's own authority: `GithubApp`, `InstallationDirectory`, `GithubClient`,
 * `GithubWrites`, `GithubRead`, `InstallationQuota`, the applier of every GitHub kind and the applier rate limit. The
 * application supplies `AlarmPort` and `SideOutputConfig`, and, for the kinds it serves, `StagedWriteGate`,
 * `BlobStore`, `FollowOnSubmitter`, `EmailSender` and `NoticeChannel`; a kind whose port is absent is refused.
 * Build it once per isolate, so the token cache, the repository mapping and the quota outlive one request.
 */
export const githubLiveLayer = (app: AppOptions, quota: QuotaOptions = quotaOptionsDefault) => {
  const services = Layer.unwrap(
    Effect.gen(function* () {
      const options: GithubClientOptions = {
        fetch: app.fetch,
        token: tokenFromApp(yield* GithubApp),
        ...(app.baseUrl === undefined ? {} : { baseUrl: app.baseUrl }),
      };
      return Layer.mergeAll(
        GithubApplierLive.pipe(
          Layer.provideMerge(
            Layer.mergeAll(githubClientLayer(options), githubWritesLayer(options)),
          ),
        ),
        githubReadLayer(options),
        ApplierRateLimitLive,
      );
    }),
  );
  return services.pipe(
    Layer.provideMerge(InstallationDirectoryFromApp),
    Layer.provideMerge(Layer.mergeAll(githubAppLayer(app), installationQuotaLayer(quota))),
  );
};

/** One outbox pass for the minute tick: the drainer over the store the caller provides (MAMEKO-OUT-001). */
export const drainOutbox = (now: number, random: () => number = Math.random) =>
  drainOnce({ now, token: (id) => `${id}:${now}:${Math.floor(random() * 1e9)}`, random });
