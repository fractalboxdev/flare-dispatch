// The application ports this package serves, as one Layer beside the runtime
// adapter's (mameko specs/hosts.md § Application ports). The live client and the
// applier rate limit share one installation quota, so every response's headers
// reach the permit decisions.
import { Layer } from "effect";
import { CheckRunApplierLive } from "./applier.ts";
import { githubClientLayer, type GithubClientOptions } from "./client.ts";
import {
  ApplierRateLimitLive,
  installationQuotaLayer,
  quotaOptionsDefault,
  type QuotaOptions,
} from "./rate-limit.ts";

/** `EffectApplier` and `ApplierRateLimit`; the application supplies `InstallationDirectory` and `AlarmPort`. */
export const githubApplicationLayer = (
  client: GithubClientOptions,
  quota: QuotaOptions = quotaOptionsDefault,
) =>
  Layer.mergeAll(
    CheckRunApplierLive.pipe(Layer.provide(githubClientLayer(client))),
    ApplierRateLimitLive,
  ).pipe(Layer.provide(installationQuotaLayer(quota)));
