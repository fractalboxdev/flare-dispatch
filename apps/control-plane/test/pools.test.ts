// The Container pools' declarations, settings, grants and launch keys (specs/architecture.md § Components).
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { launchGrants } from "@fractalboxdev/mameko-host-cloudflare";
import { describe, expect, it } from "vitest";
import type { ControlPlaneEnv } from "../src/config.ts";
import {
  launchKeysOf,
  POOL_DECLARATIONS,
  poolSettings,
  poolsServing,
  wakePools,
} from "../src/pools.ts";

const profile = buildProfile("production");

const env = (extra: Partial<ControlPlaneEnv> = {}) =>
  ({ R2_ACCOUNT_ID: "0123abcd", ...extra }) as unknown as ControlPlaneEnv;

describe("Container pools", () => {
  it("[FD-ARCH-001] declares one Container pool per Container class, each partitioned by the profile's pools entry", () => {
    const settings = poolSettings(env(), profile);
    expect(Object.keys(settings.pools).sort()).toEqual(["agent", "browser", "lean", "release"]);
    expect(settings.pools["lean"]).toEqual({
      container: "LEAN_POOL",
      partition: {
        cap: 48,
        classes: { batch: { max: 4, min: 0 }, interactive: { max: 8, min: 0 } },
      },
    });
    expect(settings.pools["release"]!.partition.classes).toEqual({ release: { max: 8, min: 0 } });
    expect(settings.objectStoreHost).toBe("0123abcd.r2.cloudflarestorage.com");
    expect(poolSettings(env({ R2_ACCOUNT_ID: "" }), profile).objectStoreHost).toBeNull();
    for (const d of Object.values(POOL_DECLARATIONS))
      expect(d.admission_cap).toBeLessThan(d.max_instances);
  });

  it("[FD-ARCH-001] an admission wakes the controllers of exactly the pools serving its class, and a device-only placement wakes none", async () => {
    expect(poolsServing(profile, "release")).toEqual(["release"]);
    expect([...poolsServing(profile, "required")].sort()).toEqual(["agent", "browser"]);
    const woken: string[] = [];
    const pools = {
      POOL_CONTROLLER: {
        idFromName: (name: string) => name,
        get: (id: unknown) => ({
          wake: async (pool?: string) => void woken.push(`${String(id)}:${pool}`),
        }),
      },
    } as unknown as ControlPlaneEnv;
    await wakePools(pools, profile, { className: "interactive", eligibleKinds: ["cloudflare"] });
    expect(woken.sort()).toEqual(["agent:agent", "browser:browser", "lean:lean"]);
    woken.length = 0;
    await wakePools(pools, profile, { className: "interactive", eligibleKinds: ["device"] });
    expect(woken).toEqual([]);
  });

  it("[FD-GATE-066] worker-deploy's setup grants reach the Cloudflare API only through cf-api, which attaches the deploy token the Worker holds and none without it", () => {
    const withToken = poolSettings(
      env({ DEPLOY_API_TOKEN: "cf-token", PUBLIC_ORIGIN: "https://ci.example.com" }),
      profile,
    );
    const grants = launchGrants(withToken, "worker-deploy");
    expect(grants.setup.map((g) => g.name)).toEqual(["cf-api", "deploy-claim"]);
    expect(grants.agent).toEqual([]);
    expect(grants.setup.filter((g) => g.host === "api.cloudflare.com")).toEqual([
      expect.objectContaining({ name: "cf-api", credential: "Bearer cf-token" }),
    ]);
    expect(launchGrants(poolSettings(env(), profile), "worker-deploy").setup[0]!.credential).toBe(
      undefined,
    );
    // A run the catalogue does not declare gets no grant.
    expect(launchGrants(withToken, "no-such-run")).toEqual({ setup: [], agent: [] });
  });

  it("[FD-GATE-067] worker-deploy's deploy-claim grant covers POST to the dispatcher's deploy-claim route alone, with no credential, and exists only on a deploy with a public origin", () => {
    const settings = poolSettings(env({ PUBLIC_ORIGIN: "https://ci.example.com/" }), profile);
    const claim = launchGrants(settings, "worker-deploy").setup.find(
      (g) => g.name === "deploy-claim",
    );
    expect(claim).toMatchObject({
      host: "ci.example.com",
      methods: ["POST"],
      pathPrefix: "/v1/deploy-claims/",
    });
    expect(claim?.credential).toBeUndefined();
    // No other run holds it.
    for (const run of ["sandbox-image", "security-gate", "pr-review"])
      expect(launchGrants(settings, run).setup.map((g) => g.name)).not.toContain("deploy-claim");
    for (const origin of [undefined, "", "not a url"])
      expect(
        launchGrants(
          poolSettings(env({ PUBLIC_ORIGIN: origin }), profile),
          "worker-deploy",
        ).setup.map((g) => g.name),
        String(origin),
      ).toEqual(["cf-api"]);
  });

  it("[FD-ARCH-001] the launch keys are the secret's P-256 private JWK and its public half, and none for any other value", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as unknown as Record<
      string,
      string
    >;
    const keys = launchKeysOf(env({ LAUNCH_SIGNING_KEY: JSON.stringify(jwk) }));
    expect(keys?.signing).toEqual({
      kty: "EC",
      crv: "P-256",
      x: jwk["x"],
      y: jwk["y"],
      d: jwk["d"],
    });
    expect(keys?.verify).toEqual({ kty: "EC", crv: "P-256", x: jwk["x"], y: jwk["y"] });
    const { d: _d, ...publicOnly } = jwk;
    for (const value of [
      undefined,
      "",
      "not json",
      JSON.stringify(publicOnly),
      JSON.stringify({ ...jwk, crv: "P-384" }),
    ])
      expect(launchKeysOf(env({ LAUNCH_SIGNING_KEY: value })), String(value)).toBeNull();
  });
});
