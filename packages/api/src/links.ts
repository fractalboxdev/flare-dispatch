// The links the dispatcher writes: an execution's details page and its logs, each carrying a link token for that one
// execution, and an artifact's, carrying a link token for that one artifact (FD-IFC-018, FD-IFC-019). Without a link
// key a link carries no token, and only an Access identity opens it.
import { Effect } from "effect";
import { ApiConfig, DASHBOARD_LINK_LIFETIME_S } from "./config.ts";
import { mintLinkToken, type LinkPurpose } from "./link-token.ts";

export interface ExecutionLinks {
  readonly details_url: string;
  readonly logs_url: string;
}

/**
 * Where a link is shown decides its lifetime: a check run's and an artifact listing's for the configured lifetime, at
 * most 7 days (FD-IFC-019, FD-CACHE-077), the dashboard's for at most 1 h (FD-OPS-067).
 */
export type LinkAudience = "check-run" | "listing" | "dashboard";

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A link token for one object, minted `nowS` seconds after the epoch; without a link key, none. */
export const linkToken = (
  purpose: LinkPurpose,
  objectId: string,
  audience: LinkAudience,
  nowS: number = nowSeconds(),
): Effect.Effect<string | undefined, never, ApiConfig> =>
  Effect.gen(function* () {
    const config = yield* ApiConfig;
    if (config.linkKey === undefined) return undefined;
    const key = config.linkKey;
    const lifetime =
      audience === "dashboard"
        ? Math.min(DASHBOARD_LINK_LIFETIME_S, config.linkLifetimeS)
        : config.linkLifetimeS;
    const expiresAtS = nowS + lifetime;
    return yield* Effect.promise(() =>
      mintLinkToken(key, { purpose, objectId, expiresAtS, epoch: config.linkEpoch }),
    );
  });

const withToken = (url: string, token: string | undefined) =>
  token === undefined ? url : `${url}?t=${encodeURIComponent(token)}`;

export const executionLinks = (
  executionId: string,
  audience: LinkAudience,
  nowS: number = nowSeconds(),
): Effect.Effect<ExecutionLinks, never, ApiConfig> =>
  Effect.gen(function* () {
    const { publicOrigin } = yield* ApiConfig;
    const token = yield* linkToken("logs", executionId, audience, nowS);
    const id = encodeURIComponent(executionId);
    return {
      details_url: withToken(`${publicOrigin}/executions/${id}`, token),
      logs_url: withToken(`${publicOrigin}/v1/executions/${id}/logs`, token),
    };
  });

/** An artifact's URL, carrying a link token bound to that one artifact (FD-CACHE-077). */
export const artifactUrl = (
  artifactId: string,
  audience: LinkAudience,
  nowS: number = nowSeconds(),
): Effect.Effect<string, never, ApiConfig> =>
  Effect.gen(function* () {
    const { publicOrigin } = yield* ApiConfig;
    const token = yield* linkToken("artifact", artifactId, audience, nowS);
    return withToken(`${publicOrigin}/v1/artifacts/${encodeURIComponent(artifactId)}`, token);
  });
