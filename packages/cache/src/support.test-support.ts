// Test support: a Miniflare instance with the cache bucket, the D1 database and the `CacheLedger` and `TransparencyLog`
// Durable Objects; the fake presigner the suites sign with, since Miniflare has no S3 endpoint; and the leases and
// clock the policies read.
import { join } from "node:path";
import { build } from "esbuild";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { Miniflare } from "miniflare";
import { ArtifactDb, ARTIFACT_SCHEMA } from "./artifacts.ts";
import { CacheClock, CacheLeases, memoryLeases, type LeaseState } from "./lease.ts";
import { memoryLedgers, type CacheLedgers } from "./ledger.ts";
import {
  CacheBucket,
  es256Sign,
  Ledgers,
  ManifestSigner,
  type Bucket,
  type ManifestSignerService,
} from "./manifest.ts";
import { R2Presigner, type PresignRequest, type R2PresignerService } from "./presign.ts";
import { protectedCloud, pullRequestNamespace } from "./namespaces.ts";

export const SECRET = "test-compile-cache-secret";

export const startMiniflare = async (bindings: Readonly<Record<string, string>> = {}) => {
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "test-worker.test-support.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: bundle.outputFiles[0]!.text }],
    compatibilityDate: "2026-05-01",
    r2Buckets: ["CACHE"],
    d1Databases: { DB: "cache-test" },
    durableObjects: {
      CACHE_LEDGER: { className: "CacheLedger", useSQLite: true },
      TRANSPARENCY_LOG: { className: "TransparencyLog", useSQLite: true },
    },
    bindings: { COMPILE_CACHE_SECRET: SECRET, ...bindings },
  });
  await mf.ready;
  const bucket = (await mf.getR2Bucket("CACHE")) as unknown as Bucket;
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const statement of ARTIFACT_SCHEMA) await db.prepare(statement).run();
  return { mf, bucket, db };
};

/** Signs `fake://<method>/<key>` URLs that carry every signed field, so a suite can read back what was signed. */
export const fakePresigner = (signed: PresignRequest[] = []): R2PresignerService => ({
  presign: (request) =>
    Effect.sync(() => {
      signed.push(request);
      const query = new URLSearchParams({
        length: String(request.length),
        expires: String(request.expiresAt),
        ...request.query,
      });
      return { url: `fake://${request.method}/${request.key}?${query}`, expiresAt: request.expiresAt };
    }),
});

export const signingKeys = async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    pair,
    publicJwk: (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey,
  };
};

export const signerFor = (
  key: CryptoKey,
  devices: Record<string, string> = {},
): ManifestSignerService => ({
  sign: (body) =>
    Effect.promise(async () => ({
      alg: "ES256" as const,
      key_id: "control-plane",
      value: await es256Sign(key, body),
    })),
  deviceKey: (id) => Effect.succeed(devices[id] ?? null),
});

export const REPO = "acme/widgets";
export const EXEC = "exec-0001";

export const lease = (over: Partial<LeaseState> = {}): LeaseState => ({
  executionId: EXEC,
  repo: REPO,
  epoch: 2,
  status: "active",
  namespaces: {
    read: [pullRequestNamespace(REPO, 7), protectedCloud(REPO), "cas"],
    write: pullRequestNamespace(REPO, 7),
  },
  executorId: "cf-1",
  executorKind: "cloudflare",
  class: "interactive",
  deadlineAt: 10_000_000,
  ...over,
});

export interface World {
  readonly leases: Map<string, LeaseState>;
  readonly ledgers: CacheLedgers;
  readonly signed: PresignRequest[];
  now: number;
}

export const world = (leases: LeaseState[] = [lease()]): World => ({
  leases: new Map(leases.map((l) => [l.executionId, l])),
  ledgers: memoryLedgers(),
  signed: [],
  now: 1_000_000,
});

export const layers = (
  w: World,
  bucket: Bucket,
  signer: ManifestSignerService,
  db?: D1Database,
) =>
  Layer.mergeAll(
    Layer.succeed(CacheLeases, memoryLeases(w.leases)),
    Layer.succeed(CacheBucket, bucket),
    Layer.succeed(Ledgers, w.ledgers),
    Layer.succeed(ManifestSigner, signer),
    Layer.succeed(CacheClock, { now: () => w.now }),
    Layer.succeed(R2Presigner, fakePresigner(w.signed)),
    ...(db === undefined ? [] : [Layer.succeed(ArtifactDb, db)]),
  );

/** The typed failure of an exit, or `undefined` when it succeeded. */
export const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.match(exit, {
    onSuccess: () => undefined,
    onFailure: (cause) => Option.getOrUndefined(Cause.findErrorOption(cause)),
  });

/** Clears the bucket between tests. */
export const emptyBucket = async (bucket: Bucket) => {
  for (;;) {
    const page = await bucket.list({ limit: 1000 });
    if (page.objects.length === 0) return;
    await bucket.delete(page.objects.map((o) => o.key));
  }
};
