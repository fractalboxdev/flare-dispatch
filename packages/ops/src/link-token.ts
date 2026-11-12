// The dashboard's log links. Each carries the API's link token for that one execution (FD-IFC-018), minted under the
// API configuration's link key, epoch and lifetime, so the log route that checks it opens it; a dashboard link's token
// expires within 3600 s (FD-OPS-067, FD-IFC-019).
import {
  ApiConfig,
  apiConfigFromEnv,
  ConfigInvalid as ApiConfigInvalid,
  type ApiConfigShape,
  type ApiEnv,
} from "@fractalboxdev/flare-dispatch-api/config";
import { executionLinks } from "@fractalboxdev/flare-dispatch-api/links";
import { Effect } from "effect";
import { ConfigInvalid } from "./config.ts";

/** The bindings the link configuration reads; every other binding is the routes' own. */
const LINK_BINDINGS = [
  "PUBLIC_ORIGIN",
  "LINK_KEY",
  "LINK_EPOCH",
  "LINK_LIFETIME_S",
  "WEBHOOK_SECRET",
  "OIDC_SIGNING_JWK",
  "PROVENANCE_KEY",
  "LOG_KEY",
  "COMPILE_CACHE_SECRET",
  "CACHE_TOKEN_SECRET",
  "INSTALL_STATE_KEY",
] as const satisfies ReadonlyArray<keyof ApiEnv>;

/**
 * The API's configuration from a Worker's env, read as the log route reads it. A link key or provenance key the API
 * refuses (FD-IFC-023, FD-PROV-033) or a link lifetime or epoch it cannot use answers `ConfigInvalid`.
 */
export const linkConfigFrom = (env: Readonly<Record<string, unknown>>, requestOrigin: string) =>
  Effect.gen(function* () {
    const bindings: Record<string, string> = {};
    for (const name of LINK_BINDINGS) {
      const value = env[name];
      if (typeof value === "string") bindings[name] = value;
      else if (typeof value === "number") bindings[name] = String(value);
    }
    const config = apiConfigFromEnv(bindings as ApiEnv, requestOrigin);
    if (config instanceof ApiConfigInvalid)
      return yield* new ConfigInvalid({ issues: [`${config.path}: ${config.message}`] });
    return config;
  });

/** A dashboard link to one execution's logs carrying its link token, or null on a deploy with no link key. */
export const dashboardLogLink = (
  config: ApiConfigShape,
  executionId: string,
  nowS: number,
): Effect.Effect<string | null> =>
  config.linkKey === undefined
    ? Effect.succeed(null)
    : executionLinks(executionId, "dashboard", nowS).pipe(
        Effect.map((links) => links.logs_url),
        Effect.provideService(ApiConfig, config),
      );
