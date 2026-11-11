// FlareDispatch's profile on the composed control plane. The document each deployment's configuration source supplies
// to mameko goes through mameko's loader and profile validator with the runtime adapter's declared pools, and device
// enrollment goes through the API's registry, mameko's `registerDevice` and host-cloudflare's runtime Layer on D1
// under workerd, with the registration rules of each deployment and phase.
import { DeviceRegistry } from "@fractalboxdev/flare-dispatch-api/ports";
import { d1DeviceRegistry } from "@fractalboxdev/flare-dispatch-api/registry";
import {
  buildProfile,
  configurationSourceLayer,
  loadProfile,
  poolAdmissionCaps,
  profileLoader,
  validationContext,
  type Deployment,
  type Phase,
  type ValidationContext,
} from "@fractalboxdev/flare-dispatch-profile";
import { runD1Migrations, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { ConfigurationSource, type ProfileDocument } from "@fractalboxdev/mameko-ports";
import { Effect, Exit } from "effect";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DEPLOYMENTS: readonly Deployment[] = ["production", "development"];

const contextOf = (deployment: Deployment, phase: Phase = 0): ValidationContext => ({
  ...validationContext,
  deployment,
  phase,
});

/** The document the deployment's configuration source supplies. */
const served = (deployment: Deployment) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* ConfigurationSource).load;
    }).pipe(Effect.provide(configurationSourceLayer(deployment))),
  );

const accepted = (document: ProfileDocument, context: ValidationContext) =>
  Effect.runPromise(loadProfile(profileLoader(context), document));

/** The validator's reasons for refusing `document`, or none when the loader accepts it. */
const refusals = async (document: ProfileDocument, context: ValidationContext) => {
  const exit = await Effect.runPromiseExit(loadProfile(profileLoader(context), document));
  if (Exit.isSuccess(exit)) return [];
  const failure = await Effect.runPromise(
    Effect.flip(loadProfile(profileLoader(context), document)),
  );
  return failure.rejections.map((r) => r.reason);
};

describe("the profile each deployment's configuration source supplies, through mameko's loader", () => {
  it("[FD-PROF-032] partitions the Container pools by class, and the validator reads each pool's admission cap from poolAdmissionCaps", async () => {
    for (const deployment of DEPLOYMENTS) {
      const document = await served(deployment);
      const loaded = await accepted(document, contextOf(deployment));
      expect(
        loaded.pools.map((p) => ({
          name: p.name,
          caps: Object.fromEntries(p.classes.map((c) => [c.class, [c.max, c.min]])),
          reservedFor: p.reserved_for ?? null,
        })),
      ).toEqual([
        { name: "lean", caps: { batch: [4, 0], interactive: [8, 0] }, reservedFor: null },
        {
          name: "agent",
          caps: { batch: [6, 0], interactive: [6, 0], required: [8, 2] },
          reservedFor: null,
        },
        {
          name: "browser",
          caps: { batch: [4, 0], interactive: [10, 0], required: [16, 2] },
          reservedFor: null,
        },
        { name: "release", caps: {}, reservedFor: "release" },
        { name: "control", caps: {}, reservedFor: null },
      ]);
      // poolAdmissionCaps declares every pool the profile names, and no other.
      expect(Object.keys(poolAdmissionCaps).sort()).toEqual(loaded.pools.map((p) => p.name).sort());

      // A pool the runtime adapter's configuration does not declare refuses the profile, naming the pool.
      for (const pool of Object.keys(poolAdmissionCaps)) {
        const { [pool]: _dropped, ...declaredPools } = poolAdmissionCaps;
        expect(await refusals(document, { ...contextOf(deployment), declaredPools })).toEqual([
          `pool ${pool} not declared by the runtime adapter`,
        ]);
      }
      // The minimums kept for `required` count against the admission cap the validator reads.
      expect(
        await refusals(document, {
          ...contextOf(deployment),
          declaredPools: { ...poolAdmissionCaps, agent: { admission_cap: 1 } },
        }),
      ).toEqual(["minimums 2 above the admission cap 1"]);
      expect(
        await refusals(document, {
          ...contextOf(deployment),
          declaredPools: { ...poolAdmissionCaps, browser: { admission_cap: 2 } },
        }),
      ).toEqual([]);
    }
  });

  it("[FD-PROF-034] caps browser sessions at 10, batch at 1, interactive at 2 and required at 10 with 1 kept", async () => {
    for (const deployment of DEPLOYMENTS) {
      const loaded = await accepted(await served(deployment), contextOf(deployment));
      expect(loaded.browser_sessions.cap).toBe(10);
      expect(
        Object.fromEntries(
          loaded.browser_sessions.classes.map((c) => [c.class, { max: c.max, min: c.min }]),
        ),
      ).toEqual({
        batch: { max: 1, min: 0 },
        interactive: { max: 2, min: 0 },
        required: { max: 10, min: 1 },
      });
    }
  });
});

let mf: Miniflare;
let databases = 0;
beforeAll(() => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    compatibilityDate: "2026-05-01",
    d1Databases: Array.from({ length: 8 }, (_, i) => `DB${i}`),
  });
}, 60_000);
afterAll(() => mf?.dispose());

type KeyStore = "software" | "secure-enclave";

const publicKey = async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer;
  return btoa(String.fromCharCode(...new Uint8Array(spki)));
};

/**
 * The enrollment of a deployment at a phase: the API's registry over mameko's `registerDevice` on a fresh D1 database,
 * with the profile's `registration` and, where given, an attestation verifier that answers `verified`.
 */
const enrollment = async (deployment: Deployment, phase: Phase, verified?: boolean) => {
  const db = (await mf.getD1Database(`DB${databases++}`)) as unknown as D1Like;
  await runD1Migrations(db);
  let at = 0;
  const registry = d1DeviceRegistry({
    db,
    anchor: { read: async () => at, advance: async (e: number) => (at = Math.max(at, e)) },
    profile: buildProfile(deployment, phase),
    posture: () => Effect.succeed("unmanaged"),
    verify: verified === undefined ? undefined : () => Effect.succeed(verified),
  });
  let n = 0;
  /** Registers a fresh key from `keyStore`, and answers the registry's answer and the executor row it wrote. */
  const register = async (keyStore: KeyStore) => {
    const executorId = `conf-device-${++n}`;
    const key = await publicKey();
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* DeviceRegistry).register({
          executor_id: executorId,
          identity: {
            public_key: key,
            key_store: keyStore,
            certificate_chain: [],
            evidence: keyStore === "software" ? null : { attestation: "evidence" },
          },
          labels: [],
          protocol_version: "1",
          code_hash: null,
        });
      }).pipe(Effect.provide(registry)),
    );
    const row = (
      await db
        .prepare("select key_store, attested_at from executors where executor_id = ?")
        .bind(executorId)
        .all()
    ).results[0] as { key_store: string; attested_at: number | null } | undefined;
    const answer = Exit.isSuccess(exit)
      ? "registered"
      : (JSON.stringify(exit.cause).match(/registration refused: ([a-z-]+)/)?.[1] ?? "failed");
    return { answer, row: row ?? null };
  };
  return { register };
};

describe("device registration on the composed control plane", () => {
  it("[FD-PROF-052] a production deployment at phase 0 admits only software keys without attestation", async () => {
    const plane = await enrollment("production", 0);
    const software = await plane.register("software");
    expect(software.answer).toBe("registered");
    expect(software.row).toEqual({ key_store: "software", attested_at: null });
    const enclave = await plane.register("secure-enclave");
    expect(enclave).toEqual({ answer: "key-store", row: null });
  }, 60_000);

  it("[FD-PROF-052] a production deployment from phase 1 admits only secure-enclave keys its attestation verifier accepts", async () => {
    // No verifier supplied: every key is refused.
    const unverified = await enrollment("production", 1);
    expect(await unverified.register("software")).toEqual({ answer: "key-store", row: null });
    expect(await unverified.register("secure-enclave")).toEqual({
      answer: "attestation",
      row: null,
    });

    const rejecting = await enrollment("production", 1, false);
    expect(await rejecting.register("secure-enclave")).toEqual({
      answer: "attestation",
      row: null,
    });

    const verifying = await enrollment("production", 1, true);
    expect(await verifying.register("software")).toEqual({ answer: "key-store", row: null });
    const enclave = await verifying.register("secure-enclave");
    expect(enclave.answer).toBe("registered");
    expect(enclave.row?.key_store).toBe("secure-enclave");
    expect(enclave.row?.attested_at).toEqual(expect.any(Number));
  }, 60_000);

  it("[FD-PROF-052] a development deployment admits only software keys without attestation, at every phase", async () => {
    for (const phase of [0, 1] as const) {
      const plane = await enrollment("development", phase, true);
      const software = await plane.register("software");
      expect(software.answer).toBe("registered");
      expect(software.row).toEqual({ key_store: "software", attested_at: null });
      expect(await plane.register("secure-enclave")).toEqual({ answer: "key-store", row: null });
    }
  }, 60_000);
});
