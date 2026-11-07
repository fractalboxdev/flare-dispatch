// The values of the operator overlay the HTTP API reads (specs/operability.md § Template, overlay and rendered
// configuration), and the secrets it holds as Worker secrets. The Worker's rendered configuration carries both as
// environment bindings; `apiConfigFromEnv` reads them.
import { Context, Schema } from "effect";

/** The default lifetime of a check-run details link token: 24 h (FD-IFC-019). */
export const DEFAULT_LINK_LIFETIME_S = 86_400;
/** The longest lifetime a check-run details link token may have: 7 days (FD-IFC-019). */
export const MAX_LINK_LIFETIME_S = 604_800;
/** The longest lifetime of a link the dashboard writes: 3600 s (FD-OPS-067). */
export const DASHBOARD_LINK_LIFETIME_S = 3_600;

export interface ApiConfigShape {
  /** `access.teamDomain` and `access.aud`; absent while the overlay sets either one to nothing (FD-IFC-014). */
  readonly access: { readonly teamDomain: string; readonly aud: string } | undefined;
  /** `operators`: the Access identities the operator routes and enrollment admit (FD-IFC-016, FD-IFC-088). */
  readonly operators: readonly string[];
  /** `dispatchers`: the Access identities allowed to dispatch (FD-IFC-027). */
  readonly dispatchers: readonly string[];
  /** `dispatch.oidcAudience`, the audience an Actions OIDC token must carry (FD-IFC-024). */
  readonly oidcAudience: string | undefined;
  /** `executors.planeId`, the plane id every `connect` signature binds (FD-IFC-085). */
  readonly planeId: string | undefined;
  /** The public origin the dispatcher writes into `details_url` and `logs_url`, with no trailing slash. */
  readonly publicOrigin: string;
  /** The lifetime of a check-run details link token, in seconds (FD-IFC-019). */
  readonly linkLifetimeS: number;
  /** The link key, a Worker secret; absent, no link token is minted and none verifies. */
  readonly linkKey: string | undefined;
  /** The current link epoch: a link token minted at a lower epoch is revoked (FD-IFC-021). */
  readonly linkEpoch: number;
}

export class ApiConfig extends Context.Service<ApiConfig, ApiConfigShape>()(
  "@fractalboxdev/flare-dispatch-api/ApiConfig",
) {}

/** The bindings `apiConfigFromEnv` reads: overlay values as vars, the link key as a secret. */
export interface ApiEnv {
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUD?: string;
  /** A JSON array of Access identities. */
  readonly OPERATORS?: string;
  /** A JSON array of Access identities. */
  readonly DISPATCHERS?: string;
  readonly DISPATCH_OIDC_AUDIENCE?: string;
  readonly PLANE_ID?: string;
  readonly PUBLIC_ORIGIN?: string;
  readonly LINK_LIFETIME_S?: string;
  readonly LINK_KEY?: string;
  readonly LINK_EPOCH?: string;
  /** The secrets the link key must differ from (FD-IFC-023). */
  readonly WEBHOOK_SECRET?: string;
  readonly OIDC_SIGNING_JWK?: string;
  readonly PROVENANCE_KEY?: string;
}

export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()("ConfigInvalid", {
  path: Schema.String,
  message: Schema.String,
}) {}

const present = (value: string | undefined) =>
  value === undefined || value.trim() === "" ? undefined : value.trim();

const identities = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const identityList = (path: string, raw: string | undefined): readonly string[] | ConfigInvalid => {
  const value = present(raw);
  if (value === undefined) return [];
  try {
    return identities(value).map((id) => id.trim().toLowerCase());
  } catch {
    return new ConfigInvalid({ path, message: `${path} is not a JSON array of identities` });
  }
};

/**
 * The link key must differ from the webhook secret, the OIDC key and the provenance key (FD-IFC-023), so a value one
 * purpose reveals never forges another.
 */
export const distinctLinkKey = (env: ApiEnv): ConfigInvalid | undefined => {
  const link = present(env.LINK_KEY);
  if (link === undefined) return undefined;
  const others: ReadonlyArray<readonly [string, string | undefined]> = [
    ["WEBHOOK_SECRET", env.WEBHOOK_SECRET],
    ["OIDC_SIGNING_JWK", env.OIDC_SIGNING_JWK],
    ["PROVENANCE_KEY", env.PROVENANCE_KEY],
  ];
  const same = others.find(([, value]) => present(value) === link);
  return same === undefined
    ? undefined
    : new ConfigInvalid({ path: "LINK_KEY", message: `the link key equals ${same[0]}` });
};

/** Reads the API's configuration from the Worker's bindings; a value it cannot use answers `ConfigInvalid`. */
export const apiConfigFromEnv = (
  env: ApiEnv,
  requestOrigin: string,
): ApiConfigShape | ConfigInvalid => {
  const teamDomain = present(env.ACCESS_TEAM_DOMAIN);
  const aud = present(env.ACCESS_AUD);
  const operators = identityList("OPERATORS", env.OPERATORS);
  if (operators instanceof ConfigInvalid) return operators;
  const dispatchers = identityList("DISPATCHERS", env.DISPATCHERS);
  if (dispatchers instanceof ConfigInvalid) return dispatchers;
  const distinct = distinctLinkKey(env);
  if (distinct !== undefined) return distinct;
  const lifetimeRaw = present(env.LINK_LIFETIME_S);
  const linkLifetimeS = lifetimeRaw === undefined ? DEFAULT_LINK_LIFETIME_S : Number(lifetimeRaw);
  if (!Number.isInteger(linkLifetimeS) || linkLifetimeS < 1 || linkLifetimeS > MAX_LINK_LIFETIME_S)
    return new ConfigInvalid({
      path: "LINK_LIFETIME_S",
      message: `the link lifetime is a whole number of seconds from 1 to ${MAX_LINK_LIFETIME_S}`,
    });
  const epochRaw = present(env.LINK_EPOCH);
  const linkEpoch = epochRaw === undefined ? 0 : Number(epochRaw);
  if (!Number.isInteger(linkEpoch) || linkEpoch < 0)
    return new ConfigInvalid({ path: "LINK_EPOCH", message: "the link epoch is a whole number" });
  return {
    access: teamDomain !== undefined && aud !== undefined ? { teamDomain, aud } : undefined,
    operators,
    dispatchers,
    oidcAudience: present(env.DISPATCH_OIDC_AUDIENCE),
    planeId: present(env.PLANE_ID),
    publicOrigin: (present(env.PUBLIC_ORIGIN) ?? requestOrigin).replace(/\/+$/, ""),
    linkLifetimeS,
    linkKey: present(env.LINK_KEY),
    linkEpoch,
  };
};
