// The Container pools of the `cloudflare` executor kind (specs/architecture.md § Components, specs/profile.md § Pools and
// browser sessions): each pool's declaration for mameko's composition, the `PoolController` settings derived from the
// profile, the grant catalogue a Container's outbound handler decides over, and the launch keys.
import { RUN_CATALOG } from "@fractalboxdev/flare-dispatch-catalog";
import { poolAdmissionCaps, type Profile } from "@fractalboxdev/flare-dispatch-profile";
import {
  poolPartition,
  poolRegistration,
  poolServes,
  type PoolDeclaration,
} from "@fractalboxdev/mameko-coordinator";
import type { Grant } from "@fractalboxdev/mameko-egress";
import {
  d1LeaseStore,
  poolControllerSettings,
  type JsonWebKeyLike,
  type PoolControllerSettings,
} from "@fractalboxdev/mameko-host-cloudflare";
import { LeaseStore } from "@fractalboxdev/mameko-ports";
import { Effect } from "effect";
import type { ControlPlaneEnv } from "./config.ts";

/**
 * Each Container pool's Container binding and `max_instances`, as `wrangler.jsonc` declares its Container class. The
 * admission cap is the profile's (FD-PROF-033), strictly below `max_instances` (MAMEKO-ADM-048).
 */
const POOL_CONTAINERS: Readonly<
  Record<string, { readonly container: string; readonly maxInstances: number }>
> = {
  lean: { container: "LEAN_POOL", maxInstances: 64 },
  agent: { container: "AGENT_POOL", maxInstances: 16 },
  browser: { container: "BROWSER_POOL", maxInstances: 32 },
  release: { container: "RELEASE_POOL", maxInstances: 16 },
};

/**
 * The Container pools the composition declares, by pool name. The `control` pool runs a run program in its Durable
 * Object with no Container (MAMEKO-EXEC-056), so it is not a Container pool.
 */
export const POOL_DECLARATIONS: Readonly<Record<string, PoolDeclaration>> = Object.fromEntries(
  Object.entries(POOL_CONTAINERS).map(([name, p]) => [
    name,
    {
      admission_cap: poolAdmissionCaps[name]!.admission_cap,
      max_instances: p.maxInstances,
      container: p.container,
      labels: [],
    },
  ]),
);

/** The headers a job's HTTPS client sends; a grant admits a request only when it allows every header it carries. */
const CLIENT_HEADERS = [
  "accept",
  "accept-encoding",
  "accept-language",
  "authorization",
  "cache-control",
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "git-protocol",
  "host",
  "pragma",
  "user-agent",
];

/** A git smart-HTTP client's methods; a push needs `POST` to `git-receive-pack`, which no repository grant serves. */
const GIT_METHODS = ["GET", "POST"];

/**
 * The grant catalogue each Container's outbound handler decides over (MAMEKO-ISO-021): `git-remote`, the repository's git
 * host for the checkout of the `setup` phase (FD-GATE-110), and `cf-api`, the Cloudflare API under the deploy token
 * the Worker holds (FD-GATE-066). `cf-api` carries no credential on a deploy without that token, so a request under it
 * leaves unauthenticated and the API refuses it.
 */
export const poolGrants = (env: Pick<ControlPlaneEnv, "DEPLOY_API_TOKEN">): readonly Grant[] => [
  {
    name: "git-remote",
    host: "github.com",
    methods: GIT_METHODS,
    pathPrefix: "/",
    maxBodyBytes: 1024 * 1024,
    headers: CLIENT_HEADERS,
  },
  {
    name: "cf-api",
    host: "api.cloudflare.com",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    pathPrefix: "/client/v4/",
    maxBodyBytes: 100 * 1024 * 1024,
    headers: CLIENT_HEADERS,
    credential:
      env.DEPLOY_API_TOKEN === undefined || env.DEPLOY_API_TOKEN === ""
        ? undefined
        : `Bearer ${env.DEPLOY_API_TOKEN}`,
  },
];

/** Each catalogue run's grant names per egress phase, as its spec declares them. */
export const RUN_GRANTS: PoolControllerSettings["runGrants"] = Object.fromEntries(
  Object.values(RUN_CATALOG).map(({ spec }) => [
    spec.name,
    { setup: [...spec.grants.setup], agent: [...spec.grants.agent] },
  ]),
);

/** The `PoolController` class's settings: each pool's partition under the profile, the grants and the R2 endpoint. */
export const poolSettings = (env: ControlPlaneEnv, profile: Profile): PoolControllerSettings =>
  poolControllerSettings(profile, POOL_DECLARATIONS, {
    grants: poolGrants(env),
    runGrants: RUN_GRANTS,
    objectStoreHost:
      env.R2_ACCOUNT_ID === undefined || env.R2_ACCOUNT_ID === ""
        ? null
        : `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  });

/**
 * The launch signing key, an ES256 private JWK in the `LAUNCH_SIGNING_KEY` Worker secret, and its public half, which
 * the channel verifies each Container's launch credential with (MAMEKO-PROTO-015). `null` where the secret is unset
 * or is not a P-256 private JWK; a pool then launches no Container, because every launch credential fails.
 */
export const launchKeysOf = (
  env: Pick<ControlPlaneEnv, "LAUNCH_SIGNING_KEY">,
): {
  readonly signing: JsonWebKeyLike & { readonly d: string };
  readonly verify: JsonWebKeyLike;
} | null => {
  if (env.LAUNCH_SIGNING_KEY === undefined || env.LAUNCH_SIGNING_KEY === "") return null;
  try {
    const jwk = JSON.parse(env.LAUNCH_SIGNING_KEY) as Record<string, unknown>;
    if (jwk["kty"] !== "EC" || jwk["crv"] !== "P-256") return null;
    const [x, y, d] = [jwk["x"], jwk["y"], jwk["d"]];
    if (typeof x !== "string" || typeof y !== "string" || typeof d !== "string") return null;
    return {
      signing: { kty: "EC", crv: "P-256", x, y, d } as JsonWebKeyLike & { readonly d: string },
      verify: { kty: "EC", crv: "P-256", x, y } as JsonWebKeyLike,
    };
  } catch {
    return null;
  }
};

/** The pools that serve `className`, whose controllers an admission of that class wakes (MAMEKO-HOST-054). */
export const poolsServing = (profile: Profile, className: string): readonly string[] =>
  Object.entries(POOL_DECLARATIONS)
    .filter(([name, d]) => poolServes(poolPartition(profile, name, d), className))
    .map(([name]) => name);

/**
 * Wakes the `PoolController` of each pool serving the class, so it claims at once. A placement whose eligible kinds
 * leave out `cloudflare` wakes none.
 */
export const wakePools = async (
  env: Pick<ControlPlaneEnv, "POOL_CONTROLLER">,
  profile: Profile,
  placement: { readonly className: string; readonly eligibleKinds: readonly string[] | null },
): Promise<readonly string[]> => {
  if (!(placement.eligibleKinds?.includes("cloudflare") ?? true)) return [];
  const pools = poolsServing(profile, placement.className);
  await Promise.all(
    pools.map((name) => env.POOL_CONTROLLER.get(env.POOL_CONTROLLER.idFromName(name)).wake(name)),
  );
  return pools;
};

/** Writes each declared pool's `executors` row before the first request, admission or tick (MAMEKO-LEASE-003). */
export const registerPools = (env: Pick<ControlPlaneEnv, "DB">, profile: Profile): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const lease = yield* LeaseStore;
      for (const [name, declaration] of Object.entries(POOL_DECLARATIONS))
        yield* lease.register(poolRegistration(profile, name, declaration));
    }).pipe(Effect.provide(d1LeaseStore(env.DB))),
  );
