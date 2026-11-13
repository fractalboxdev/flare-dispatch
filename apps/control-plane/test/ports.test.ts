// The application ports the composition supplies against mameko's configuration validation (MAMEKO-HOST-046), and the
// object-store presigner the isolate's services carry (FD-CACHE-091).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { R2Presigner } from "@fractalboxdev/flare-dispatch-cache";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import {
  APP_BINDINGS,
  composedPorts,
  parseJsonc,
  placeholderOverlay,
  PRESIGNER_BINDINGS,
  renderTemplate,
} from "@fractalboxdev/flare-dispatch-ops";
import { buildProfile, missingPorts } from "@fractalboxdev/flare-dispatch-profile";
import { ObjectStorePresigner, ResultAcceptanceCheck } from "@fractalboxdev/mameko-ports";
import { type Context, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { isolateServices } from "../src/composition.ts";
import { acceptanceSettingsOf, presignerConfigOf, type ControlPlaneEnv } from "../src/config.ts";
import { appOptionsOf } from "../src/github.ts";
import { suppliedPorts } from "../src/ports.ts";

const env = (extra: Partial<ControlPlaneEnv>) =>
  ({ PLANE_ID: "flare-dispatch", ...extra }) as unknown as ControlPlaneEnv;

describe("the composition's application ports", () => {
  it("[FD-ARCH-039] MAMEKO-HOST-046 a deploy with the GitHub App supplies every port the phase 0 profile uses", () => {
    const withApp = env({ GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "flare-dispatch-test", GITHUB_APP_PRIVATE_KEY: "key" });
    expect(missingPorts(buildProfile("production"), suppliedPorts(withApp))).toEqual([]);
    expect(missingPorts(buildProfile("development"), suppliedPorts(withApp))).toEqual([]);
  });

  it("[FD-ARCH-039] the unused credential minter is not advertised by an App-configured deploy", () => {
    expect(suppliedPorts(env({ GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "flare-dispatch-test", GITHUB_APP_PRIVATE_KEY: "key" }))).not.toContain(
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

const APP = { GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "flare-dispatch-test", GITHUB_APP_PRIVATE_KEY: "key" };

describe("the deploy check and the Worker read one condition per port", () => {
  it("[FD-ARCH-039] blanking any binding the ops package names drops the port exactly where the Worker builds no live Layer", () => {
    const full = env({ ...APP, ...PRESIGN });
    expect(appOptionsOf(full)).toBeDefined();
    expect(presignerConfigOf(full)).toBeDefined();
    expect(composedPorts(full)).toEqual(
      expect.arrayContaining(["actuator", "actuator-rate-limit", "object-store-presigner"]),
    );
    for (const name of APP_BINDINGS)
      for (const blank of [undefined, ""]) {
        const without = env({ ...APP, ...PRESIGN, [name]: blank });
        expect(appOptionsOf(without)).toBeUndefined();
        expect(composedPorts(without)).not.toContain("actuator");
        expect(composedPorts(without)).not.toContain("actuator-rate-limit");
        expect(presignerConfigOf(without)).toBeDefined();
      }
    for (const name of PRESIGNER_BINDINGS)
      for (const blank of [undefined, ""]) {
        const without = env({ ...APP, ...PRESIGN, [name]: blank });
        expect(presignerConfigOf(without)).toBeUndefined();
        expect(composedPorts(without)).not.toContain("object-store-presigner");
        expect(appOptionsOf(without)).toBeDefined();
      }
  });
});

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
      suppliedPorts(env({ GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "flare-dispatch-test", GITHUB_APP_PRIVATE_KEY: "key" })),
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

describe("the result-acceptance check", () => {
  it("[FD-ARCH-039] every deploy supplies the result-acceptance-check port, and the isolate's services carry it", async () => {
    expect(composedPorts(env({}))).toContain("result-acceptance-check");
    expect(suppliedPorts(env(APP))).toContain("result-acceptance-check");
    const services = (await isolateServices(
      env({ DB: await migratedD1(), DEPLOYMENT: "production" }),
    )) as Context.Context<ResultAcceptanceCheck>;
    // A submission that does not decode names no lease the control plane issued.
    const verdict = await Effect.runPromise(
      ResultAcceptanceCheck.use((p) => p.check({}, {})).pipe(Effect.provide(services)),
    );
    expect(verdict).toEqual({ _tag: "rejected", reasonKind: "provenance: unissued-lease" });
  });

  it("[FD-PROV-016] the committed template renders attestation_max_age in days, 10 where the overlay sets none, and the check's window follows it", async () => {
    const template = readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8");
    const varsOf = async (overlay: typeof placeholderOverlay) =>
      parseJsonc(await Effect.runPromise(renderTemplate("control-plane", template, overlay)))[
        "vars"
      ] as Record<string, unknown>;
    const DAY = 24 * 3_600_000;
    const defaults = await varsOf({ ...placeholderOverlay, provenance: {} });
    expect(defaults["ATTESTATION_MAX_AGE_DAYS"]).toBe(10);
    expect(acceptanceSettingsOf(defaults)).toEqual({ attestationMaxAgeMs: 10 * DAY });
    const set = await varsOf({ ...placeholderOverlay, provenance: { attestationMaxAgeDays: 12 } });
    expect(set["ATTESTATION_MAX_AGE_DAYS"]).toBe(12);
    expect(acceptanceSettingsOf(set)).toEqual({ attestationMaxAgeMs: 12 * DAY });
    // A `.dev.vars` entry arrives as text; an unset or empty var is the default.
    expect(acceptanceSettingsOf({ ATTESTATION_MAX_AGE_DAYS: "3" })).toEqual({
      attestationMaxAgeMs: 3 * DAY,
    });
    expect(acceptanceSettingsOf({})).toEqual({ attestationMaxAgeMs: 10 * DAY });
    expect(acceptanceSettingsOf({ ATTESTATION_MAX_AGE_DAYS: "" })).toEqual({
      attestationMaxAgeMs: 10 * DAY,
    });
    // A malformed value admits no attestation rather than a longer window.
    for (const bad of ["ten", -1, 0, {}])
      expect(acceptanceSettingsOf({ ATTESTATION_MAX_AGE_DAYS: bad })).toEqual({
        attestationMaxAgeMs: 0,
      });
  });
});
