// FlareDispatch's cache suite on the composed control plane: the control plane Worker under workerd through
// Miniflare, with its D1 database, its `CACHE` bucket and its `CacheLedger` Durable Object. An execution reaches its
// lease the way a device's does: an operator dispatch, a signed executor socket, a claim. The executor's readers (the
// device's compile-cache proxy and the manifest lookup) run against that Worker's route and bucket.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  CacheBucket,
  CacheClock,
  CacheLeases,
  cacheNamespaces,
  commitCacheManifest,
  compileObjectKey,
  entryPrefix,
  es256Sign,
  grantCarriesNoWorkspace,
  Ledgers,
  ledgersOf,
  logObjectName,
  lookupEntry,
  ManifestSigner,
  manifestPath,
  memoryLeases,
  memoryLedgers,
  objectPrefix,
  protectedCloud,
  pullRequestNamespace,
  readManifest,
  signCompileCacheToken,
  verifyCompileCacheToken,
  type Bucket,
  type CacheLedgerApi,
  type CacheNamespaces,
  type LeaseState,
  type UploadGrant,
} from "@fractalboxdev/flare-dispatch-cache";
import {
  compileCacheProxy,
  memoryDisk,
  openL1,
  type L1Disk,
} from "@fractalboxdev/flare-dispatch-cache/device";
import { Effect, Exit, Layer } from "effect";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUD,
  connect,
  endStandingClaim,
  hello,
  newDevice,
  OPERATOR,
  PLANE,
  registration,
  startAccessTeam,
  type AccessTeam,
} from "../../../apps/control-plane/test/support.ts";

const REPO = "fractalboxdev/flare-dispatch";
const ORIGIN = "https://ci.example.com";
const SECRET = "compile-cache-secret-for-conformance";
const PR = pullRequestNamespace(REPO, 41);

const DEV_REPOSITORY = {
  repository: REPO,
  installation: 1,
  default_branch: "main",
  head: "f".repeat(40),
  confidentiality: "non-confidential",
  files: {
    ".github/flare-dispatch.json": readFileSync(
      join(import.meta.dirname, "../../../.github/flare-dispatch.json"),
    ).toString("base64"),
  },
};

let team: AccessTeam;
let plane: Miniflare;
/** The same Worker on a deploy that binds no `CacheLedger`. */
let ledgerless: Miniflare;
/** The same Worker on a deploy whose captured repository's confidentiality mode is `confidential-compute`. */
let confidential: Miniflare;

const controlPlane = (script: string, ledger: boolean, devRepository: object = DEV_REPOSITORY) =>
  new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: script }],
    compatibilityDate: "2026-05-01",
    d1Databases: { DB: "control-plane" },
    durableObjects: {
      CHANNEL: { className: "ExecutorChannel", useSQLite: true },
      EXECUTION: { className: "ExecutionEngine", useSQLite: true },
      EPOCH_ANCHOR: { className: "EpochAnchor", useSQLite: true },
      MONITOR: { className: "LivenessMonitor", useSQLite: true },
      ...(ledger ? { CACHE_LEDGER: { className: "CacheLedger", useSQLite: true } } : {}),
    },
    r2Buckets: ["CACHE"],
    bindings: {
      DEPLOYMENT: "development",
      PLANE_ID: PLANE,
      PUBLIC_ORIGIN: ORIGIN,
      COMPILE_CACHE_SECRET: SECRET,
      ACCESS_TEAM_DOMAIN: team.teamDomain,
      ACCESS_AUD: AUD,
      OPERATORS: JSON.stringify([OPERATOR]),
      DISPATCHERS: JSON.stringify([OPERATOR]),
      FD_DEV_REPOSITORY: JSON.stringify(devRepository),
    },
  });

beforeAll(async () => {
  team = await startAccessTeam();
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "../../../apps/control-plane/src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  const script = bundle.outputFiles[0]!.text;
  plane = controlPlane(script, true);
  ledgerless = controlPlane(script, false);
  confidential = controlPlane(script, true, {
    ...DEV_REPOSITORY,
    confidentiality: "confidential-compute",
  });
  await Promise.all([plane.ready, ledgerless.ready, confidential.ready]);
}, 120_000);

afterAll(async () => {
  await Promise.all([plane?.dispose(), ledgerless?.dispose(), confidential?.dispose()]);
  await team?.close();
});

const bucket = async (mf: Miniflare = plane) => (await mf.getR2Bucket("CACHE")) as unknown as Bucket;
const db = async (mf: Miniflare = plane) => (await mf.getD1Database("DB")) as unknown as D1Database;
const ledger = async (repo: string) =>
  ledgersOf(
    (await plane.getDurableObjectNamespace("CACHE_LEDGER")) as unknown as DurableObjectNamespace,
  )(repo) as CacheLedgerApi;

/** The control plane's `fetch` from outside: a request to its public origin reaches the Worker. */
const fetchFrom =
  (mf: Miniflare) =>
  (url: string | URL | Request, init?: RequestInit): Promise<Response> =>
    mf.dispatchFetch(String(url), init as never) as unknown as Promise<Response>;

interface Lease {
  readonly execution_id: string;
  readonly epoch: number;
  readonly inputs: unknown;
  readonly cache_namespaces: CacheNamespaces;
  readonly upload_grant: UploadGrant;
  readonly [field: string]: unknown;
}

let leases = 0;

/**
 * Dispatches `check`, records the execution's trigger as `trigger` (what intake records for a webhook) and its inputs as
 * `inputs`, and claims the lease from a fresh device on the control plane's socket; `executor` is that device's id.
 */
const leaseOf = async (
  trigger: unknown,
  inputs: (dispatched: unknown) => unknown,
  mf: Miniflare = plane,
): Promise<Lease & { readonly executor: string }> => {
  const n = ++leases;
  const executorId = `conf-cache-${n}`;
  const device = await newDevice();
  const jwt = await team.jwt(OPERATOR);
  const headers = { "content-type": "application/json", "cf-access-jwt-assertion": jwt };
  const enrolled = await mf.dispatchFetch("http://x/v1/executors/register", {
    method: "POST",
    headers,
    // A repository that is not `non-confidential` places only on a device advertising container isolation or stronger.
    body: JSON.stringify(registration(executorId, device.identity, ["isolation:container"])),
  });
  expect(enrolled.status).toBe(201);
  const sha = n.toString(16).padStart(40, "c");
  const admitted = await mf.dispatchFetch("http://x/v1/dispatch/check", {
    method: "POST",
    headers,
    body: JSON.stringify({
      repository: REPO,
      sha,
      inputs: {
        repo: `https://github.com/${REPO}`,
        sha,
        ref: "main",
        // A job that names a namespace of its own.
        steps: [
          {
            label: "build",
            command: `SCCACHE_WEBDAV_KEY_PREFIX=${protectedCloud(REPO)} cargo build`,
          },
        ],
      },
    }),
  });
  expect(admitted.status).toBe(202);
  const { execution_id: id } = (await admitted.json()) as { execution_id: string };
  const d1 = await db(mf);
  const row = await d1
    .prepare("select inputs_json from intake_records where execution_id = ?")
    .bind(id)
    .first<{ inputs_json: string }>();
  await d1
    .prepare("update intake_records set cache_trigger_json = ?, inputs_json = ? where execution_id = ?")
    .bind(JSON.stringify(trigger), JSON.stringify(inputs(JSON.parse(row!.inputs_json))), id)
    .run();
  await d1
    .prepare("update executions set deadline_at = ? where id = ?")
    .bind(Date.now() + 3_600_000, id)
    .run();
  const socket = await connect(mf, executorId, device.keys);
  socket.send(hello(executorId));
  await socket.next("session.welcome");
  socket.send({ type: "exec.claim", id: "c1", free: { batch: 1 } });
  const lease = (await socket.next("exec.lease")) as unknown as Lease;
  expect(lease.execution_id).toBe(id);
  await endStandingClaim(socket);
  return { ...lease, executor: executorId };
};

/** Run inputs that name namespaces the execution row does not give it. */
const namingNamespaces = (dispatched: unknown) => ({
  ...(dispatched as object),
  cache_namespace: protectedCloud(REPO),
  cache_namespaces: { read: [protectedCloud(REPO), "pr/other/repo/1"], write: protectedCloud(REPO) },
});

const PULL_REQUEST = { _tag: "PullRequest", number: 41 };

let prLease: Lease | undefined;
const pullRequestLease = async () => (prLease ??= await leaseOf(PULL_REQUEST, namingNamespaces));

let readLease: Lease | undefined;
/** A pull-request execution whose lease the CacheLedger has not ended. */
const prLeaseForReads = async () => (readLease ??= await leaseOf(PULL_REQUEST, (d) => d));

describe("the lease the composed control plane grants", () => {
  it(
    "[FD-CACHE-002] names only cache, artifact and log prefixes of this execution and epoch, and no checkout, workspace or build output",
    async () => {
      const lease = await pullRequestLease();
      const grant = lease.upload_grant;
      expect(grantCarriesNoWorkspace(grant, lease.execution_id, lease.epoch)).toBe(true);
      expect(grant).toMatchObject({
        cache_prefix: `cache/${PR}/`,
        artifact_prefix: `artifacts/${lease.execution_id}/${lease.epoch}/`,
        log_prefix: `logs/${lease.execution_id}/${lease.epoch}/`,
      });
      // Every field the control plane adds beside the run's inputs, at any depth.
      const fields = (value: unknown, path: string): string[] =>
        value === null || typeof value !== "object"
          ? []
          : Object.entries(value).flatMap(([k, v]) => [`${path}${k}`, ...fields(v, `${path}${k}.`)]);
      const { inputs: _inputs, ...granted } = lease;
      expect(
        fields(granted, "").filter((f) => /workspace|checkout|build[_-]?output|source[_-]?executor/i.test(f)),
      ).toEqual([]);
      const prefixes = Object.entries(grant).filter(([k]) => k.endsWith("_prefix"));
      expect(prefixes.map(([k]) => k).sort()).toEqual(["artifact_prefix", "cache_prefix", "log_prefix"]);
      for (const [, prefix] of prefixes)
        expect(String(prefix)).toMatch(/^(cache|artifacts|logs)\//);
    },
    60_000,
  );

  it(
    "[FD-CACHE-016] takes the namespaces from the execution row and the executor's kind, and ignores the namespaces the run inputs and a job name",
    async () => {
      const lease = await pullRequestLease();
      const expected = cacheNamespaces(
        {
          repo: REPO,
          executionId: lease.execution_id,
          class: "batch",
          constraints: [],
          trigger: { _tag: "PullRequest", number: 41 },
        },
        "device",
      );
      expect(lease.cache_namespaces).toEqual(expected);
      expect(lease.cache_namespaces.write).toBe(PR);
      expect(lease.cache_namespaces.read).not.toContain("pr/other/repo/1");
      // The inputs the executor receives still name the namespaces; nothing granted follows them.
      expect(lease.inputs).toMatchObject({ cache_namespace: protectedCloud(REPO) });
      expect(lease.upload_grant.cache_prefix).toBe(`cache/${PR}/`);
      // The compile-cache token carries the lease's namespaces, never the inputs'.
      const verdict = await verifyCompileCacheToken(
        SECRET,
        REPO,
        lease.upload_grant.compile_cache!.token,
        Date.now(),
      );
      expect(verdict).toMatchObject({
        ok: true,
        scope: { read: expected.read, write: PR, epoch: lease.epoch },
      });

      // The same inputs on an execution whose row records a manual dispatch: it writes nothing.
      const other = await leaseOf({ _tag: "Other" }, namingNamespaces);
      expect(other.cache_namespaces.write).toBeNull();
      expect(other.upload_grant.cache_prefix).toBeNull();
      expect(other.cache_namespaces.read).not.toContain(PR);
      expect(other.cache_namespaces.read).not.toContain("pr/other/repo/1");
    },
    60_000,
  );
});

describe("the compile-cache route's writes on the composed control plane", () => {
  it(
    "[FD-CACHE-052] reserves a PUT's declared length in the repository's CacheLedger before it writes, and writes nothing the ledger refuses",
    async () => {
      const lease = await pullRequestLease();
      const { endpoint, token } = lease.upload_grant.compile_cache!;
      expect(endpoint).toBe(`${ORIGIN}/v1/compile-cache/${REPO}`);
      const put = (path: string, body: string) =>
        plane.dispatchFetch(`${endpoint}/${path}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-length": String(body.length) },
          body,
        });
      const repoLedger = await ledger(REPO);
      const before = await repoLedger.usage();
      const stored = await put("k052/a", "x".repeat(1234));
      expect(stored.status).toBe(201);
      const after = await repoLedger.usage();
      expect(after.stored + after.pending - (before.stored + before.pending)).toBe(1234);
      const r2 = await bucket();
      expect((await r2.head(compileObjectKey(PR, "k052/a")))?.size).toBe(1234);

      // Once the ledger has ended the execution, it refuses every reservation, and the route writes nothing.
      await repoLedger.end({ executionId: lease.execution_id, expiresAt: Date.now() + 3_600_000 });
      const refused = await put("k052/b", "y".repeat(10));
      expect(refused.status).toBe(403);
      expect(await r2.head(compileObjectKey(PR, "k052/b"))).toBeNull();
    },
    60_000,
  );
});

describe("the executor's cache reads against the composed control plane", () => {
  /** A device's L1, optionally on a disk whose every read fails. */
  const l1Of = async (failing: boolean) => {
    const disk = memoryDisk(1_000_000);
    const broken: L1Disk = failing
      ? { ...disk, read: async () => Promise.reject(new Error("disk read failed")) }
      : disk;
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const jwk = (await crypto.subtle.exportKey("jwk", (keys as CryptoKeyPair).publicKey)) as JsonWebKey;
    return openL1({
      disk: broken,
      l2: { fetch: async () => null, upload: async () => undefined },
      keys: { controlPlane: jwk, device: () => null },
    });
  };

  const proxyFor = async (
    lease: Lease,
    options: { readonly mf?: Miniflare; readonly token?: string; readonly fetch?: typeof fetch; readonly l1?: Awaited<ReturnType<typeof l1Of>> } = {},
  ) => {
    const grant = lease.upload_grant.compile_cache!;
    const proxy = compileCacheProxy({
      l1: options.l1 ?? (await l1Of(false)),
      read: lease.cache_namespaces.read,
      write: lease.cache_namespaces.write,
      upstream: { endpoint: grant.endpoint, token: options.token ?? grant.token },
      fetch: options.fetch ?? (fetchFrom(options.mf ?? plane) as typeof fetch),
    });
    return (path: string, method = "GET") => proxy(new Request(`http://proxy/${path}`, { method }));
  };

  it(
    "[FD-CACHE-011] a compile-cache read the route fails, at the CacheLedger, on a stale token or unreachable, is a miss",
    async () => {
      const lease = await prLeaseForReads();
      await (await bucket()).put(compileObjectKey(PR, "k011/hit"), "cached");
      // The route serves the object, so each failure below is the failure and not an absent object.
      const healthy = await proxyFor(lease);
      expect(await (await healthy("k011/hit")).text()).toBe("cached");

      // A deploy that binds no CacheLedger answers 503 for every compile-cache request.
      const direct = await ledgerless.dispatchFetch(
        `${lease.upload_grant.compile_cache!.endpoint}/k011/hit`,
        { headers: { authorization: `Bearer ${lease.upload_grant.compile_cache!.token}` } },
      );
      expect(direct.status).toBe(503);
      const noLedger = await proxyFor(lease, { mf: ledgerless });
      for (const method of ["GET", "HEAD", "PROPFIND"])
        expect((await noLedger("k011/hit", method)).status).toBe(404);

      // A token for an epoch the control plane does not hold is refused with 403.
      const stale = await signCompileCacheToken(SECRET, {
        repo: REPO,
        executionId: lease.execution_id,
        epoch: lease.epoch + 1,
        read: lease.cache_namespaces.read,
        write: lease.cache_namespaces.write,
        expiresAt: Date.now() + 60_000,
      });
      const staleProxy = await proxyFor(lease, { token: stale });
      for (const method of ["GET", "HEAD", "PROPFIND"])
        expect((await staleProxy("k011/hit", method)).status).toBe(404);

      const down = await proxyFor(lease, {
        fetch: (async () => Promise.reject(new TypeError("network down"))) as typeof fetch,
      });
      expect((await down("k011/hit")).status).toBe(404);
    },
    60_000,
  );

  it(
    "[FD-CACHE-011] an L1 read that fails falls through to the route, and an L2 manifest read that fails is a miss",
    async () => {
      const lease = await prLeaseForReads();
      const r2 = await bucket();
      await r2.put(compileObjectKey(PR, "k011/l1"), "from-route");
      const l1 = await l1Of(true);
      // L1 indexes an object under the proxy's key for the path, so the proxy reads the failing disk first.
      const l1Key = createHash("sha256").update("compile-cache/k011/l1").digest("hex");
      expect(await Effect.runPromise(l1.keep(PR, l1Key, new TextEncoder().encode("unreadable")))).toBe(true);
      const proxy = await proxyFor(lease, { l1 });
      const answer = await proxy("k011/l1");
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe("from-route");

      // An unreadable manifest in the control plane's bucket, and a bucket read that fails, are each a miss.
      const key = "b".repeat(64);
      await r2.put(manifestPath(PR, key), "{not json");
      const reader = {
        namespaces: lease.cache_namespaces,
        class: "batch",
        constraints: [],
        executorKind: "device" as const,
      };
      const keys = { controlPlane: {} as JsonWebKey, device: () => null };
      const fromBucket = (b: Bucket) => (namespace: string, k: string) =>
        Effect.runPromise(readManifest(b, namespace, k)).then((read) => read?.manifest ?? null);
      expect(await Effect.runPromise(lookupEntry(reader, key, fromBucket(r2), keys))).toBeNull();
      const failing = {
        get: async () => Promise.reject(new Error("R2 unavailable")),
      } as unknown as Bucket;
      expect(await Effect.runPromise(lookupEntry(reader, key, fromBucket(failing), keys))).toBeNull();
    },
    60_000,
  );
});

describe("a confidential-compute repository on the composed control plane", () => {
  let confidentialLease: (Lease & { readonly executor: string }) | undefined;
  const confidentialPullRequest = async () =>
    (confidentialLease ??= await leaseOf(PULL_REQUEST, namingNamespaces, confidential));

  it(
    "[FD-CACHE-008] the lease names no L2 namespace, no cache prefix and no compile-cache endpoint, whatever the run inputs name",
    async () => {
      const lease = await confidentialPullRequest();
      expect(lease.cache_namespaces).toEqual({ read: [], write: null });
      expect(lease.upload_grant.cache_prefix).toBeNull();
      expect(lease.upload_grant.compile_cache).toBeNull();
      // The inputs still name a namespace; nothing granted follows them.
      expect(lease.inputs).toMatchObject({ cache_namespace: protectedCloud(REPO) });
      // The same pull request on a repository that is not confidential reads and writes L2.
      const open = await pullRequestLease();
      expect(open.cache_namespaces.write).toBe(PR);
      expect(open.upload_grant.compile_cache).not.toBeNull();
    },
    60_000,
  );

  it(
    "[FD-CACHE-088] the log viewer shows the executor id and execution id as a pointer and fetches no log content",
    async () => {
      /** Writes one log segment of the lease's execution to a deploy's bucket and reads the viewer as an operator. */
      const viewerOf = async (mf: Miniflare, lease: Lease) => {
        const name = await logObjectName({
          executionId: lease.execution_id,
          epoch: lease.epoch,
          journalName: "step:build",
          stream: "stdout",
          start: 0,
          end: 1,
        });
        await (await bucket(mf)).put(name!, `${JSON.stringify({ line: "confidential build output" })}\n`, {
          customMetadata: { executor_id: "device", executor_kind: "device" },
        });
        const read = await mf.dispatchFetch(
          `${ORIGIN}/v1/executions/${lease.execution_id}/logs?format=html`,
          { headers: { "cf-access-jwt-assertion": await team.jwt(OPERATOR) } },
        );
        expect(read.status).toBe(200);
        return read.text();
      };
      const lease = await confidentialPullRequest();
      const pointer = await viewerOf(confidential, lease);
      expect(pointer).toContain(`"executionId":"${lease.execution_id}"`);
      expect(pointer).toContain(`"executorId":"${lease.executor}"`);
      expect(pointer).not.toContain("confidential build output");
      // A repository that is not confidential shows the log content its executor uploaded.
      expect(await viewerOf(plane, await prLeaseForReads())).toContain("confidential build output");
    },
    60_000,
  );
});

// ---- FD-CACHE-041: create-only manifests, on the control plane's bucket and on a real R2 bucket ------------------

/**
 * A real R2 bucket, the second backend of the manifest commit. CI sets these when the operator provides an R2 token
 * with object read and write on one bucket; without them the real-R2 leg is skipped and the Miniflare leg still runs.
 */
const REAL_R2 = {
  bucket: process.env["FD_R2_CONFORMANCE_BUCKET"] ?? "",
  accountId: process.env["FD_R2_CONFORMANCE_ACCOUNT_ID"] ?? "",
  apiToken: process.env["FD_R2_CONFORMANCE_API_TOKEN"] ?? "",
};
const realR2 = REAL_R2.bucket !== "" && REAL_R2.accountId !== "" && REAL_R2.apiToken !== "";

/** The commit's services over `r2`: the leases below, an in-memory ledger and a cache-signing key of the suite's own. */
const commitLayers = async (r2: Bucket, leases: readonly LeaseState[]) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return Layer.mergeAll(
    Layer.succeed(CacheLeases, memoryLeases(new Map(leases.map((l) => [l.executionId, l])))),
    Layer.succeed(CacheBucket, r2),
    Layer.succeed(Ledgers, memoryLedgers()),
    Layer.succeed(ManifestSigner, {
      sign: (body: string) =>
        Effect.promise(async () => ({
          alg: "ES256" as const,
          key_id: "control-plane",
          value: await es256Sign(pair.privateKey, body),
        })),
      deviceKey: () => Effect.succeed(null),
    }),
    Layer.succeed(CacheClock, { now: () => Date.now() }),
  );
};

/** Deletes every object of one cache entry, so a run leaves nothing behind in a shared bucket. */
const removeEntry = async (r2: Bucket, namespace: string, key: string) => {
  for (;;) {
    const page = await r2.list({ prefix: entryPrefix(namespace, key), limit: 1000 });
    if (page.objects.length === 0) return;
    await r2.delete(page.objects.map((o) => o.key));
  }
};

/**
 * Three executions that may write one pull-request namespace commit the same key: two at once, then one later. The
 * first committed manifest stays and every other commit is answered `duplicate`.
 */
const firstCommitWins = async (r2: Bucket) => {
  const run = crypto.randomUUID().slice(0, 8);
  const namespace = pullRequestNamespace(REPO, 41_000 + Math.floor(Math.random() * 1_000_000));
  const key = createHash("sha256").update(`fd-cache-041:${run}`).digest("hex");
  const writer = (name: string): LeaseState => ({
    executionId: `conf-041-${run}-${name}`,
    repo: REPO,
    epoch: 1,
    status: "active",
    namespaces: { read: [namespace], write: namespace },
    executorId: `cf-${name}`,
    executorKind: "cloudflare",
    class: "batch",
    deadlineAt: Date.now() + 3_600_000,
  });
  const writers = [writer("a"), writer("b"), writer("c")] as const;
  const layer = await commitLayers(r2, writers);
  const commit = async (lease: LeaseState) => {
    const body = `store of ${lease.executionId}`;
    const path = `${objectPrefix(namespace, key, lease.executionId, lease.epoch)}store.tar`;
    await r2.put(path, body);
    const exit = await Effect.runPromiseExit(
      commitCacheManifest({
        execution_id: lease.executionId,
        epoch: lease.epoch,
        manifest: {
          key,
          namespace,
          objects: [
            {
              path,
              size: new TextEncoder().encode(body).length,
              sha256: createHash("sha256").update(body).digest("hex"),
            },
          ],
        },
      }).pipe(Effect.provide(layer)),
    );
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
    return exit.value;
  };
  const stored = async () => (await Effect.runPromise(readManifest(r2, namespace, key)))?.manifest;
  try {
    const [a, b] = await Promise.all([commit(writers[0]), commit(writers[1])]);
    expect([a, b].sort()).toEqual(["accepted", "duplicate"]);
    const winner = a === "accepted" ? writers[0] : writers[1];
    expect((await stored())?.writer).toMatchObject({
      execution_id: winner.executionId,
      executor_id: winner.executorId,
    });
    const etag = (await r2.head(manifestPath(namespace, key)))?.etag;
    expect(etag).toBeDefined();

    expect(await commit(writers[2])).toBe("duplicate");
    expect((await r2.head(manifestPath(namespace, key)))?.etag).toBe(etag);
    expect((await stored())?.writer.execution_id).toBe(winner.executionId);
    // The binding's create-only put itself answers null on a key that holds a manifest.
    expect(
      await r2.put(manifestPath(namespace, key), "{}", { onlyIf: { etagDoesNotMatch: "*" } }),
    ).toBeNull();
    expect((await r2.head(manifestPath(namespace, key)))?.etag).toBe(etag);
  } finally {
    await removeEntry(r2, namespace, key);
  }
};

describe("the manifest commit on the control plane's bucket", () => {
  it(
    "[FD-CACHE-041] keeps the first committed manifest for a key and answers every later commit duplicate (Miniflare R2)",
    async () => firstCommitWins(await bucket()),
    60_000,
  );
});

describe.skipIf(!realR2)("the manifest commit on a real R2 bucket", () => {
  let session: { readonly remoteProxyConnectionString: unknown; dispose(): Promise<void> } | undefined;
  let remote: Miniflare | undefined;

  beforeAll(async () => {
    const { startRemoteProxySession } = await import("wrangler");
    const started = await startRemoteProxySession(
      { CACHE: { type: "r2_bucket", bucket_name: REAL_R2.bucket } },
      {
        auth: () => ({
          accountId: REAL_R2.accountId,
          apiToken: { apiToken: REAL_R2.apiToken },
        }),
      },
    );
    session = started;
    remote = new Miniflare({
      modules: true,
      script: "export default { fetch: () => new Response(null, { status: 404 }) };",
      compatibilityDate: "2026-05-01",
      r2Buckets: {
        CACHE: {
          id: REAL_R2.bucket,
          remoteProxyConnectionString: started.remoteProxyConnectionString,
        },
      },
    });
    await remote.ready;
  }, 120_000);

  afterAll(async () => {
    await remote?.dispose();
    await session?.dispose();
  });

  it(
    "[FD-CACHE-041] keeps the first committed manifest for a key and answers every later commit duplicate (real R2)",
    async () => firstCommitWins((await remote!.getR2Bucket("CACHE")) as unknown as Bucket),
    120_000,
  );
});
