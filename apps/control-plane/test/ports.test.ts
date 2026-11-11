// The application ports the composition supplies against mameko's configuration validation (MAMEKO-HOST-046), and the
// object-store presigner the isolate's services carry (FD-CACHE-091).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { R2Presigner } from "@fractalboxdev/flare-dispatch-cache";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { parseJsonc, placeholderOverlay, renderTemplate } from "@fractalboxdev/flare-dispatch-ops";
import { buildProfile, missingPorts } from "@fractalboxdev/flare-dispatch-profile";
import { ObjectStorePresigner } from "@fractalboxdev/mameko-ports";
import { type Context, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { isolateServices } from "../src/composition.ts";
import type { ControlPlaneEnv } from "../src/config.ts";
import { suppliedPorts } from "../src/ports.ts";

const env = (extra: Partial<ControlPlaneEnv>) =>
  ({ PLANE_ID: "flare-dispatch", ...extra }) as unknown as ControlPlaneEnv;

describe("the composition's application ports", () => {
  it("[FD-ARCH-039] MAMEKO-HOST-046 a deploy with the GitHub App supplies every port the phase 0 profile uses", () => {
    const withApp = env({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "key" });
    expect(missingPorts(buildProfile("production"), suppliedPorts(withApp))).toEqual([]);
    expect(missingPorts(buildProfile("development"), suppliedPorts(withApp))).toEqual([]);
  });

  it("[FD-ARCH-039] a deploy with the GitHub App supplies the credential minter, and one without it supplies none", () => {
    expect(suppliedPorts(env({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "key" }))).toContain(
      "credential-minter",
    );
    expect(suppliedPorts(env({}))).not.toContain("credential-minter");
  });

  it("[FD-ARCH-039] MAMEKO-HOST-046 names the applier ports a deploy without the App lacks", () => {
    expect(missingPorts(buildProfile("production"), suppliedPorts(env({})))).toEqual([
      "actuator",
      "actuator-rate-limit",
    ]);
  });
});

const PRESIGN = {
  R2_ACCOUNT_ID: "0123abcd",
  CACHE_BUCKET_NAME: "fd-cache",
  R2_PRESIGN_ACCESS_KEY_ID: "PRESIGNKEY",
  R2_PRESIGN_SECRET_ACCESS_KEY: "presign-secret",
};

const isolateOf = async (extra: Partial<ControlPlaneEnv>) =>
  (await isolateServices(
    env({ DB: await migratedD1(), DEPLOYMENT: "production", ...extra }),
  )) as Context.Context<ObjectStorePresigner | R2Presigner>;

describe("the object-store presigner", () => {
  it("[FD-CACHE-091] a deploy holding the presign token, the account id and the bucket name supplies the presigner, and one missing any supplies none", () => {
    expect(suppliedPorts(env(PRESIGN))).toContain("object-store-presigner");
    for (const name of Object.keys(PRESIGN))
      expect(suppliedPorts(env({ ...PRESIGN, [name]: "" }))).not.toContain(
        "object-store-presigner",
      );
    // The App's key is no presign token.
    expect(
      suppliedPorts(env({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "key" })),
    ).not.toContain("object-store-presigner");
  });

  it("[FD-CACHE-091] the isolate's presigner signs with the presign token on the bucket's S3 endpoint", async () => {
    const services = await isolateOf(PRESIGN);
    const expiresAt = Date.now() + 600_000;
    const signed = await Effect.runPromise(
      ObjectStorePresigner.use((p) => p.presign("cache/ns/k/e.1/a", "PUT", 42, expiresAt)).pipe(
        Effect.provide(services),
      ),
    );
    const url = new URL(signed.url);
    expect(url.host).toBe("0123abcd.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/fd-cache/cache/ns/k/e.1/a");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^PRESIGNKEY\/\d{8}\/auto\/s3\//);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host");
    // The policy's signer is the same one.
    const policy = await Effect.runPromise(
      R2Presigner.use((p) =>
        p.presign({ key: "logs/x", method: "GET", length: null, expiresAt }),
      ).pipe(Effect.provide(services)),
    );
    expect(new URL(policy.url).host).toBe("0123abcd.r2.cloudflarestorage.com");
  });

  it("[FD-CACHE-091] a deploy without the presign token signs no URL", async () => {
    const services = await isolateOf({ ...PRESIGN, R2_PRESIGN_SECRET_ACCESS_KEY: undefined });
    const exit = await Effect.runPromiseExit(
      ObjectStorePresigner.use((p) => p.presign("k", "GET", null, Date.now() + 60_000)).pipe(
        Effect.provide(services),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("leaves R2_PRESIGN_SECRET_ACCESS_KEY unset");
  });

  it("[FD-CACHE-091] the committed template renders the account id and the cache bucket's name, and holds no presign token", async () => {
    const template = readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8");
    const rendered = parseJsonc(
      await Effect.runPromise(renderTemplate("control-plane", template, placeholderOverlay)),
    );
    const vars = rendered["vars"] as Record<string, unknown>;
    expect(vars["R2_ACCOUNT_ID"]).toBe(placeholderOverlay.accountId);
    expect(vars["CACHE_BUCKET_NAME"]).toBe(placeholderOverlay.r2["CACHE"]);
    const cache = (rendered["r2_buckets"] as { binding: string; bucket_name: string }[]).find(
      (b) => b.binding === "CACHE",
    );
    expect(vars["CACHE_BUCKET_NAME"]).toBe(cache?.bucket_name);
    // The token is a Worker secret, never a var.
    expect(Object.keys(vars).filter((k) => k.startsWith("R2_PRESIGN_"))).toEqual([]);
  });
});
