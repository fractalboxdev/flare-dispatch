// The pools of the `cloudflare` executor kind (specs/architecture.md § Components, specs/profile.md § Pools and browser
// sessions), the Container pools and the `control` pool: each pool's declaration for mameko's composition, the
// `PoolController` settings derived from the profile, the grant catalogue a Container's outbound handler decides over,
// and the launch keys.
import {
  DEPLOY_CLAIM_ROUTE,
  MODEL_GATEWAY_PATH,
  RUN_CATALOG,
} from "@fractalboxdev/flare-dispatch-catalog";
import { poolAdmissionCaps, type Profile } from "@fractalboxdev/flare-dispatch-profile";
import {
  poolPartition,
  poolRegistration,
  poolServes,
  type PoolDeclaration,
} from "@fractalboxdev/mameko-coordinator";
import type { Grant } from "@fractalboxdev/mameko-egress";
import { CONTROL_POOL } from "@fractalboxdev/mameko-kernel";
import {
  d1LeaseStore,
  poolControllerSettings,
  type JsonWebKeyLike,
  type PoolControllerSettings,
} from "@fractalboxdev/mameko-host-cloudflare";
import { LeaseStore } from "@fractalboxdev/mameko-ports";
import { Effect } from "effect";
import type { ControlPlaneEnv } from "./config.ts";
import { deployClaimHost } from "./deploy-claim.ts";
import {
  MODEL_LEASE_CREDENTIAL,
  MODEL_REQUEST_MAX_BYTES,
  mintModelLeaseCredential,
} from "./model-gateway.ts";

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
 * The `control` pool's declaration: its `container` is the pool controller's own binding, whose objects run each
 * lease's run program with no Container (MAMEKO-EXEC-057). No Container class backs it, so `max_instances` bounds
 * nothing but the admission cap's validation (MAMEKO-ADM-048).
 */
const CONTROL_DECLARATION = { container: "POOL_CONTROLLER", maxInstances: 32 } as const;

/** The pools the composition declares, by pool name: each Container pool and the `control` pool. */
export const POOL_DECLARATIONS: Readonly<Record<string, PoolDeclaration>> = Object.fromEntries(
  Object.entries({ ...POOL_CONTAINERS, [CONTROL_POOL]: CONTROL_DECLARATION }).map(([name, p]) => [
    name,
    {
      admission_cap: poolAdmissionCaps[name]!.admission_cap,
      max_instances: p.maxInstances,
      container: p.container,
      labels: [],
    },
  ]),
);

/** The headers a job's HTTPS client sends, Node's `fetch` and git's among them; a grant admits a request only when it allows every header it carries. */
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
  "sec-fetch-mode",
  "user-agent",
];

/** A git smart-HTTP client's methods; a push needs `POST` to `git-receive-pack`, which no repository grant serves. */
const GIT_METHODS = ["GET", "POST"];

/** The headers a job's GitHub REST client sends beside an HTTPS client's own. */
const GITHUB_API_HEADERS = [...CLIENT_HEADERS, "x-github-api-version"];

/**
 * The grant catalogue each Container's outbound handler decides over (MAMEKO-ISO-021): `git-remote`, the repository's git
 * host for the checkout of the `setup` phase (FD-GATE-110); `cf-api`, the Cloudflare API under the deploy token the
 * Worker holds (FD-GATE-066); `deploy-claim`, `POST` to the dispatcher's deploy-claim route alone, where
 * `worker-deploy` presents its lease's deploy-claim token (FD-GATE-067); `model-gateway`, `POST` to the dispatcher's
 * model route alone, which an agentic recipe reaches in its `agent` phase (FD-AGT-010); and `github-api-read`, `GET` of
 * GitHub's repository routes with no credential, which answer a public repository's reads alone. `cf-api` carries no
 * credential on a deploy without that token, so a request under it leaves unauthenticated and the API refuses it.
 * `deploy-claim` attaches no credential. `model-gateway` names no credential here: it is a minted grant, whose
 * credential the controller issues for each launch, the lease's model-lease token (`MINTED_GRANTS`). A deploy that
 * names no `PUBLIC_ORIGIN` has neither dispatcher grant, so its leases carry no deploy claim and no model route either.
 */
export const poolGrants = (
  env: Pick<ControlPlaneEnv, "DEPLOY_API_TOKEN" | "PUBLIC_ORIGIN">,
): readonly Grant[] => {
  const dispatcher = deployClaimHost(env);
  return [
    {
      name: "git-remote",
      host: "github.com",
      methods: GIT_METHODS,
      pathPrefix: "/",
      maxBodyBytes: 1024 * 1024,
      headers: CLIENT_HEADERS,
    },
    {
      name: "github-api-read",
      host: "api.github.com",
      methods: ["GET"],
      pathPrefix: "/repos/",
      maxBodyBytes: 0,
      headers: GITHUB_API_HEADERS,
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
    ...(dispatcher === undefined
      ? []
      : [
          {
            name: "deploy-claim",
            host: dispatcher,
            methods: ["POST"],
            pathPrefix: DEPLOY_CLAIM_ROUTE,
            maxBodyBytes: 1024,
            headers: CLIENT_HEADERS,
          },
          {
            name: "model-gateway",
            host: dispatcher,
            methods: ["POST"],
            pathPrefix: MODEL_GATEWAY_PATH,
            maxBodyBytes: MODEL_REQUEST_MAX_BYTES,
            headers: CLIENT_HEADERS,
          },
        ]),
  ];
};

/**
 * The runs whose `agent` phase reads GitHub's repository routes with no credential: `triage-prs` reads a repository's
 * open pull requests, their check runs and reviews, and declares `outbound`. `triage-issues` reads issues, untrusted
 * input beside private data, so a host beyond the model gateway in its `agent` phase would complete the trifecta
 * (FD-AGT-005); it holds none.
 */
const GITHUB_API_READERS: ReadonlySet<string> = new Set(["triage-prs"]);

/**
 * Each catalogue run's grant names per egress phase: the grants its spec declares; for a run that requires
 * `Workspace`, the `setup` profile's `git-remote` base grant (FD-PROF-050), through which the executor checks the
 * lease's source out before the job starts; for an agentic recipe that calls models, the `agent` profile's
 * `model-gateway` base grant, so its `agent` phase reaches the model route; and for a run of `GITHUB_API_READERS`,
 * `github-api-read`.
 */
export const RUN_GRANTS: PoolControllerSettings["runGrants"] = Object.fromEntries(
  Object.values(RUN_CATALOG).map(({ spec, agentic }) => [
    spec.name,
    {
      setup: [
        ...new Set([
          ...(spec.requires.includes("Workspace") ? ["git-remote"] : []),
          ...spec.grants.setup,
        ]),
      ],
      agent: [
        ...spec.grants.agent,
        ...(agentic?.declaration.needsModel === true ? ["model-gateway"] : []),
        ...(GITHUB_API_READERS.has(spec.name) ? ["github-api-read"] : []),
      ],
    },
  ]),
);

/**
 * The grants whose credential the controller mints for each launch (MAMEKO-ISO-052, MAMEKO-HOST-050): `model-gateway`,
 * whose credential is the lease's model-lease token, on a deploy with the model-lease secret and the dispatcher grant.
 */
export const mintedGrants = (
  env: Pick<ControlPlaneEnv, "DEPLOY_API_TOKEN" | "PUBLIC_ORIGIN" | "MODEL_LEASE_SECRET">,
): readonly string[] =>
  env.MODEL_LEASE_SECRET !== undefined &&
  env.MODEL_LEASE_SECRET !== "" &&
  poolGrants(env).some((g) => g.name === MODEL_LEASE_CREDENTIAL)
    ? [MODEL_LEASE_CREDENTIAL]
    : [];

/**
 * The credential the controller mints for one launch's grant (MAMEKO-HOST-050): the `model-gateway` grant carries the
 * lease's model-lease token as a bearer credential, expiring at the lease's `deadline_at`. `mintedGrants` names no
 * other grant, so any other is refused.
 */
export const mintPoolCredential =
  (env: Pick<ControlPlaneEnv, "MODEL_LEASE_SECRET">) =>
  (
    grant: string,
    lease: { readonly executionId: string; readonly epoch: number; readonly deadlineAt: number },
  ): Promise<{ readonly credential: string; readonly expiresAt: number }> =>
    grant === MODEL_LEASE_CREDENTIAL
      ? mintModelLeaseCredential(env, {
          executionId: lease.executionId,
          epoch: lease.epoch,
          expiresAt: lease.deadlineAt,
        })
      : Promise.reject(new Error(`grant ${grant}: no credential minter is bound`));

/**
 * The `PoolController` class's settings: each pool's partition under the profile, the grants, the minted grants and
 * the R2 endpoint.
 */
export const poolSettings = (env: ControlPlaneEnv, profile: Profile): PoolControllerSettings =>
  poolControllerSettings(profile, POOL_DECLARATIONS, {
    grants: poolGrants(env),
    mintedGrants: mintedGrants(env),
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

/** The pools that serve `className`, whose controllers an admission of that class wakes (MAMEKO-HOST-056). */
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

/**
 * Writes each declared pool's `executors` row before the first request, admission or tick (MAMEKO-LEASE-003): the
 * `control` pool's always, and each Container pool's on a deploy that can launch its Containers.
 */
export const registerPools = (
  env: Pick<ControlPlaneEnv, "DB">,
  profile: Profile,
  containers: boolean,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const lease = yield* LeaseStore;
      for (const [name, declaration] of Object.entries(POOL_DECLARATIONS))
        if (containers || name === CONTROL_POOL)
          yield* lease.register(poolRegistration(profile, name, declaration));
    }).pipe(Effect.provide(d1LeaseStore(env.DB))),
  );
