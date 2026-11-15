// The Container pools' declarations, settings, grants and launch keys (specs/architecture.md § Components).
import { RUN_CATALOG } from "@fractalboxdev/flare-dispatch-catalog";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { decide } from "@fractalboxdev/mameko-egress";
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
    expect(grants.setup.map((g) => g.name)).toEqual(["git-remote", "cf-api", "deploy-claim"]);
    expect(grants.agent).toEqual([]);
    expect(grants.setup.filter((g) => g.host === "api.cloudflare.com")).toEqual([
      expect.objectContaining({ name: "cf-api", credential: "Bearer cf-token" }),
    ]);
    expect(
      launchGrants(poolSettings(env(), profile), "worker-deploy").setup.find(
        (g) => g.name === "cf-api",
      )!.credential,
    ).toBe(undefined);
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
      ).toEqual(["git-remote", "cf-api"]);
  });

  it("[FD-AGT-010] an agentic recipe that calls models reaches the dispatcher's model route in its agent phase alone, with no credential, and its setup phase reaches the git host alone", () => {
    const settings = poolSettings(env({ PUBLIC_ORIGIN: "https://ci.example.com/" }), profile);
    for (const run of ["pr-review", "improve-pr", "self-heal-pr", "release-notes"]) {
      const grants = launchGrants(settings, run);
      expect(
        grants.setup.map((g) => g.name),
        run,
      ).toEqual(["git-remote"]);
      expect(grants.agent, run).toEqual([
        expect.objectContaining({
          name: "model-gateway",
          host: "ci.example.com",
          methods: ["POST"],
          pathPrefix: "/v1/model/",
        }),
      ]);
      expect(grants.agent[0]?.credential, run).toBeUndefined();
    }
    // `triage-prs` calls no model, so its agent phase holds no model route.
    expect(launchGrants(settings, "triage-prs").agent.map((g) => g.name)).toEqual([
      "github-api-read",
    ]);
    // A gate run's phases hold no model route.
    for (const run of ["worker-deploy", "security-gate", "sandbox-image"])
      expect(
        launchGrants(settings, run).agent.map((g) => g.name),
        run,
      ).not.toContain("model-gateway");
    // A deploy that names no public origin has no dispatcher host to grant.
    expect(launchGrants(poolSettings(env(), profile), "pr-review").agent).toEqual([]);
  });

  it("[FD-PROF-050] MAMEKO-ADM-033 every run that requires Workspace reaches the git host in its setup phase, where the executor checks out the lease's source, and no other run does", () => {
    const settings = poolSettings(env({ PUBLIC_ORIGIN: "https://ci.example.com/" }), profile);
    for (const [run, entry] of Object.entries(RUN_CATALOG)) {
      const setup = launchGrants(settings, run).setup.map((g) => g.name);
      expect(setup.includes("git-remote"), run).toBe(entry.spec.requires.includes("Workspace"));
      expect(setup.filter((g) => g === "git-remote").length, run).toBeLessThanOrEqual(1);
    }
    expect(launchGrants(settings, "security-gate").setup.map((g) => g.name)).toEqual([
      "git-remote",
    ]);
    const git = launchGrants(settings, "pr-review").setup[0]!;
    expect(git).toMatchObject({ host: "github.com", methods: ["GET", "POST"], pathPrefix: "/" });
    expect(git.credential).toBeUndefined();
  });

  it("[FD-AGT-005] github-api-read covers GET of GitHub's repository routes with no credential, in triage-prs' agent phase alone", () => {
    const settings = poolSettings(env({ PUBLIC_ORIGIN: "https://ci.example.com/" }), profile);
    const read = launchGrants(settings, "triage-prs").agent.find(
      (g) => g.name === "github-api-read",
    );
    expect(read).toMatchObject({
      host: "api.github.com",
      methods: ["GET"],
      pathPrefix: "/repos/",
      maxBodyBytes: 0,
    });
    expect(read!.credential).toBeUndefined();
    // The Container's outbound handler decides each request with mameko's egress decision over the phase's grants.
    const agent = launchGrants(settings, "triage-prs").agent;
    const request = (method: string, path: string, headers = ["accept", "x-github-api-version"]) =>
      decide(
        { scheme: "https", host: "api.github.com", method, path, bodyBytes: 0, headers },
        agent,
        "enforce",
      );
    for (const path of [
      "/repos/acme/app/pulls?state=open&per_page=100",
      `/repos/acme/app/commits/${"a".repeat(40)}/check-runs?per_page=100`,
      "/repos/acme/app/pulls/7/reviews?per_page=100",
    ])
      expect(request("GET", path), path).toEqual({
        _tag: "Admit",
        grant: "github-api-read",
        credential: undefined,
      });
    expect(request("POST", "/repos/acme/app/issues")._tag).toBe("Deny");
    expect(request("GET", "/user")._tag).toBe("Deny");
    expect(request("GET", "/repos/acme/app/pulls", ["accept", "cookie"])._tag).toBe("Deny");
    // `triage-issues` reads untrusted issues beside private data, so its agent phase reaches no host beyond the model
    // route; no other run holds the grant in either phase.
    for (const run of Object.keys(RUN_CATALOG).filter((r) => r !== "triage-prs")) {
      const grants = launchGrants(settings, run);
      expect(
        [...grants.setup, ...grants.agent].map((g) => g.name),
        run,
      ).not.toContain("github-api-read");
    }
    expect(launchGrants(settings, "triage-issues").agent.map((g) => g.name)).toEqual([
      "model-gateway",
    ]);
  });

  it("[FD-IFC-102] [FD-IFC-103] control-plane-read covers GET under the dispatcher's executions path alone, in ci-triage-pr's agent phase alone", () => {
    const settings = poolSettings(env({ PUBLIC_ORIGIN: "https://ci.example.com/" }), profile);
    const agent = launchGrants(settings, "ci-triage-pr").agent;
    expect(agent.map((g) => g.name)).toEqual(["model-gateway", "control-plane-read"]);
    expect(agent.find((g) => g.name === "control-plane-read")).toMatchObject({
      host: "ci.example.com",
      methods: ["GET"],
      pathPrefix: "/v1/executions",
      maxBodyBytes: 0,
    });
    // The lease's token is the credential; the grant carries no value of its own.
    expect(agent.find((g) => g.name === "control-plane-read")!.credential).toBeUndefined();
    expect(launchGrants(settings, "ci-triage-pr").setup.map((g) => g.name)).toEqual(["git-remote"]);
    const request = (method: string, path: string, host = "ci.example.com") =>
      decide(
        { scheme: "https", host, method, path, bodyBytes: 0, headers: ["accept", "authorization"] },
        agent,
        "enforce",
      );
    for (const path of [
      "/v1/executions?repository=acme%2Fapp&status=done&finished_since=0&limit=200",
      "/v1/executions/01JEXEC0000000000000000000/logs?format=text",
    ])
      expect(request("GET", path), path).toEqual({
        _tag: "Admit",
        grant: "control-plane-read",
        credential: undefined,
      });
    expect(request("POST", "/v1/executions/01JEXEC0000000000000000000/cancel")._tag).toBe("Deny");
    expect(request("GET", "/v1/ops/health")._tag).toBe("Deny");
    expect(request("GET", "/v1/artifacts/a1")._tag).toBe("Deny");
    expect(request("GET", "/v1/executions", "api.github.com")._tag).toBe("Deny");
    // No other run holds the grant in either phase.
    for (const run of Object.keys(RUN_CATALOG).filter((r) => r !== "ci-triage-pr")) {
      const grants = launchGrants(settings, run);
      expect(
        [...grants.setup, ...grants.agent].map((g) => g.name),
        run,
      ).not.toContain("control-plane-read");
    }
    // A deploy that names no public origin has no dispatcher host to grant.
    expect(launchGrants(poolSettings(env(), profile), "ci-triage-pr").agent).toEqual([]);
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
