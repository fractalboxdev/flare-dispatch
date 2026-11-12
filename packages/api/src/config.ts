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

/** The class ceilings a `dispatch.scoped` entry may name (specs/operability.md FD-OPS-092). */
export const ScopedClassCeiling = Schema.Literals(["interactive", "batch"]);
export type ScopedClassCeiling = typeof ScopedClassCeiling.Type;

/**
 * One `dispatch.scoped` entry: an automated caller of read-only scan runs, the runs and repositories it may name and
 * the class ceiling its dispatches resolve under (specs/interfaces.md FD-IFC-089 to FD-IFC-093).
 */
export interface ScopedDispatch {
  readonly identity: string;
  readonly runs: readonly string[];
  readonly repositories: readonly string[];
  readonly classCeiling: ScopedClassCeiling;
}

export interface ApiConfigShape {
  /** `access.teamDomain` and `access.aud`; absent while the overlay sets either one to nothing (FD-IFC-014). */
  readonly access: { readonly teamDomain: string; readonly aud: string } | undefined;
  /** `operators`: the Access identities the operator routes and enrollment admit (FD-IFC-016, FD-IFC-088). */
  readonly operators: readonly string[];
  /** `dispatchers`: the Access identities allowed to dispatch (FD-IFC-027). */
  readonly dispatchers: readonly string[];
  /**
   * `containment`: the Access identities the tightening operator routes admit (FD-IFC-095), which tighten controls and
   * never release them (FD-IFC-096 to FD-IFC-098).
   */
  readonly containment: readonly string[];
  /** `dispatch.scoped`: the Access identities allowed to dispatch only the runs and repositories their entry names. */
  readonly scoped: readonly ScopedDispatch[];
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
  /** A JSON array of Access identities: the overlay's `containment`. */
  readonly CONTAINMENT?: string;
  readonly DISPATCH_OIDC_AUDIENCE?: string;
  /** A JSON array of `dispatch.scoped` entries `{ identity, runs, repositories, classCeiling }`. */
  readonly DISPATCH_SCOPED?: string;
  readonly PLANE_ID?: string;
  readonly PUBLIC_ORIGIN?: string;
  readonly LINK_LIFETIME_S?: string;
  readonly LINK_KEY?: string;
  readonly LINK_EPOCH?: string;
  /** The secrets the link key must differ from (FD-IFC-023). */
  readonly WEBHOOK_SECRET?: string;
  readonly OIDC_SIGNING_JWK?: string;
  /** The provenance key, which countersigns accepted statements (specs/provenance.md § Keys). */
  readonly PROVENANCE_KEY?: string;
  /** The log key, which signs the private log's checkpoints (specs/provenance.md § Keys). */
  readonly LOG_KEY?: string;
  /** The other capability secrets: compile-cache tokens (FD-CACHE-057) and install states (FD-OPS-073). */
  readonly COMPILE_CACHE_SECRET?: string;
  readonly CACHE_TOKEN_SECRET?: string;
  readonly INSTALL_STATE_KEY?: string;
  /** The verdict record signing key, which signs each job and verdict record (specs/github-output.md FD-GH-099). */
  readonly RECORDS_SIGNING_KEY?: string;
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

const NonEmpty = Schema.String.check(Schema.isMinLength(1));

const scopedEntries = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        identity: NonEmpty,
        runs: Schema.Array(NonEmpty),
        repositories: Schema.Array(NonEmpty),
        classCeiling: ScopedClassCeiling,
      }),
    ),
  ),
);

/**
 * The `dispatch.scoped` entries, each identity lowercased as Access reports it. A value that does not decode, or a
 * class ceiling other than `interactive` or `batch`, answers `ConfigInvalid`, so no scoped caller dispatches under an
 * entry the API cannot honor.
 */
const scopedList = (raw: string | undefined): readonly ScopedDispatch[] | ConfigInvalid => {
  const value = present(raw);
  if (value === undefined) return [];
  try {
    return scopedEntries(value).map((entry) => ({
      ...entry,
      identity: entry.identity.trim().toLowerCase(),
    }));
  } catch {
    return new ConfigInvalid({
      path: "DISPATCH_SCOPED",
      message:
        "DISPATCH_SCOPED is not a JSON array of { identity, runs, repositories, classCeiling } entries",
    });
  }
};

/**
 * The link key must differ from the webhook secret, the OIDC key and the provenance key (FD-IFC-023), and from the
 * secrets the compile-cache tokens and the install states derive from, so a value one purpose reveals never forges
 * another.
 */
export const distinctLinkKey = (env: ApiEnv): ConfigInvalid | undefined => {
  const link = present(env.LINK_KEY);
  if (link === undefined) return undefined;
  const others: ReadonlyArray<readonly [string, string | undefined]> = [
    ["WEBHOOK_SECRET", env.WEBHOOK_SECRET],
    ["OIDC_SIGNING_JWK", env.OIDC_SIGNING_JWK],
    ["PROVENANCE_KEY", env.PROVENANCE_KEY],
    ["COMPILE_CACHE_SECRET", env.COMPILE_CACHE_SECRET],
    ["INSTALL_STATE_KEY", env.INSTALL_STATE_KEY],
  ];
  const same = others.find(([, value]) => present(value) === link);
  return same === undefined
    ? undefined
    : new ConfigInvalid({ path: "LINK_KEY", message: `the link key equals ${same[0]}` });
};

/**
 * The key material a secret holds: its text, and the private scalar `d` of every JWK it holds, so an OIDC key set
 * whose current or retired key is the provenance key matches it however each secret is formatted.
 */
const keyMaterial = (secret: string): ReadonlySet<string> => {
  const out = new Set<string>([secret]);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (typeof v === "object" && v !== null)
      for (const [k, x] of Object.entries(v)) {
        if (k === "d" && typeof x === "string" && x !== "") out.add(`jwk.d:${x}`);
        else walk(x);
      }
  };
  try {
    walk(JSON.parse(secret));
  } catch {
    // Not JSON: the text alone is the key material.
  }
  return out;
};

/** The bindings the provenance key must differ from: the OIDC key, the log key and every capability-token key. */
export const PROVENANCE_KEY_DISTINCT_FROM = [
  "OIDC_SIGNING_JWK",
  "LOG_KEY",
  "LINK_KEY",
  "COMPILE_CACHE_SECRET",
  "CACHE_TOKEN_SECRET",
  "INSTALL_STATE_KEY",
] as const satisfies ReadonlyArray<keyof ApiEnv>;

/**
 * The provenance key must differ from the OIDC key, the log key and every capability-token key (FD-PROV-033), so a
 * key one purpose reveals never countersigns a statement. A secret that holds the same private JWK in another form
 * matches too. The refusal names the binding, never a value.
 */
export const distinctProvenanceKey = (env: ApiEnv): ConfigInvalid | undefined => {
  const provenance = present(env.PROVENANCE_KEY);
  if (provenance === undefined) return undefined;
  const mine = keyMaterial(provenance);
  const same = PROVENANCE_KEY_DISTINCT_FROM.find((name) => {
    const other = present(env[name]);
    return other !== undefined && [...keyMaterial(other)].some((m) => mine.has(m));
  });
  return same === undefined
    ? undefined
    : new ConfigInvalid({ path: "PROVENANCE_KEY", message: `the provenance key equals ${same}` });
};

/** The bindings the verdict record signing key must differ from. */
export const RECORDS_KEY_DISTINCT_FROM = [
  "WEBHOOK_SECRET",
  "LINK_KEY",
  "OIDC_SIGNING_JWK",
  "PROVENANCE_KEY",
] as const satisfies ReadonlyArray<keyof ApiEnv>;

/**
 * The verdict record signing key must differ from the webhook secret, the link key, the OIDC key and the provenance
 * key (FD-GH-099), so a record receiver that holds the key forges no webhook, link, token or statement. A secret that
 * holds the same private JWK in another form matches too. The refusal names the binding, never a value.
 */
export const distinctRecordsKey = (env: ApiEnv): ConfigInvalid | undefined => {
  const records = present(env.RECORDS_SIGNING_KEY);
  if (records === undefined) return undefined;
  const mine = keyMaterial(records);
  const same = RECORDS_KEY_DISTINCT_FROM.find((name) => {
    const other = present(env[name]);
    return other !== undefined && [...keyMaterial(other)].some((m) => mine.has(m));
  });
  return same === undefined
    ? undefined
    : new ConfigInvalid({
        path: "RECORDS_SIGNING_KEY",
        message: `the records signing key equals ${same}`,
      });
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
  const containment = identityList("CONTAINMENT", env.CONTAINMENT);
  if (containment instanceof ConfigInvalid) return containment;
  const scoped = scopedList(env.DISPATCH_SCOPED);
  if (scoped instanceof ConfigInvalid) return scoped;
  const distinct = distinctLinkKey(env);
  if (distinct !== undefined) return distinct;
  const provenance = distinctProvenanceKey(env);
  if (provenance !== undefined) return provenance;
  const records = distinctRecordsKey(env);
  if (records !== undefined) return records;
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
    containment,
    scoped,
    oidcAudience: present(env.DISPATCH_OIDC_AUDIENCE),
    planeId: present(env.PLANE_ID),
    publicOrigin: (present(env.PUBLIC_ORIGIN) ?? requestOrigin).replace(/\/+$/, ""),
    linkLifetimeS,
    linkKey: present(env.LINK_KEY),
    linkEpoch,
  };
};
