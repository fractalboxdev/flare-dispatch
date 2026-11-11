// The cache's V-SIM scenarios (specs/verification.md § V-SIM). Each scenario takes a seed that fixes every
// interleaving and every step of the clock the cache code reads (`CacheClock`), runs the control plane's cache
// policies against an in-memory bucket that stamps `uploaded` from the same clock, and returns the property violations
// it saw, the cases the seed reached and a trace that replays exactly. R2's own conditional writes are checked against
// Miniflare by the unit suites; here the bucket keeps every run in one process and on one clock.
//
// - `simulateReclaim`: an execution is reclaimed onto other executors while the executors of earlier epochs keep
//   asking for URLs and using their compile-cache tokens (FD-CACHE-051), and every executor tries to reach what an
//   earlier epoch left behind (FD-CACHE-002).
// - `simulateSweep`: entries are committed and read over 40 days while the cache sweep ticks (FD-CACHE-062).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { compileObjectKey, handleCompileCache } from "../../src/compile-cache.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { leaseCacheFields, type LeaseState, type UploadGrant } from "../../src/lease.ts";
import { logObjectName } from "../../src/logs.ts";
import {
  commitCacheManifest,
  manifestPath,
  objectPrefix,
  type Bucket,
  type ManifestSignerService,
} from "../../src/manifest.ts";
import { protectedCloud, pullRequestNamespace } from "../../src/namespaces.ts";
import { MAX_URL_LIFETIME_MS, presignForExecution, PresignRefused } from "../../src/presign.ts";
import { sweepCache } from "../../src/sweep.ts";
import { grantCarriesNoWorkspace } from "../../src/workspace.ts";
import { failureOf, layers, SECRET, world, type World } from "../../src/support.test-support.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The simulated clock starts here. */
const START = Date.UTC(2026, 0, 1);
/** The TTL FD-CACHE-062 states. */
export const CACHE_TTL_MS = 14 * DAY;

/** A seeded PRNG (mulberry32): one seed fixes every draw. */
export const seededRandom = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const kept = readFileSync(join(import.meta.dirname, "seeds.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as { scenario: string; seed: number });

/** 100 seeds per scenario plus every kept seed (specs/verification.md § V-SIM). */
export const seeds = (scenario: string): readonly number[] => [
  ...Array.from({ length: 100 }, (_, i) => i + 1),
  ...kept.filter((k) => k.scenario === scenario).map((k) => k.seed),
];

export interface Violation {
  readonly id: string;
  readonly message: string;
}

export interface SimOutcome {
  readonly violations: readonly Violation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

const encoder = new TextEncoder();

interface Stored {
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly uploaded: number;
  readonly customMetadata: Record<string, string>;
  readonly httpMetadata: R2HTTPMetadata;
}

const objectOf = (key: string, s: Stored) => ({
  key,
  version: s.etag,
  size: s.bytes.byteLength,
  etag: s.etag,
  httpEtag: `"${s.etag}"`,
  uploaded: new Date(s.uploaded),
  customMetadata: s.customMetadata,
  httpMetadata: s.httpMetadata,
  checksums: {},
  storageClass: "Standard",
  writeHttpMetadata: () => undefined,
});

const bodyOf = (key: string, s: Stored) => ({
  ...objectOf(key, s),
  get body() {
    return new Response(s.bytes).body!;
  },
  bodyUsed: false,
  text: async () => new TextDecoder().decode(s.bytes),
  arrayBuffer: async () => s.bytes.slice().buffer,
  bytes: async () => s.bytes.slice(),
  json: async () => JSON.parse(new TextDecoder().decode(s.bytes)) as unknown,
  blob: async () => new Blob([s.bytes]),
});

/**
 * An R2 bucket in memory on the simulated clock: key-sorted listing with `prefix`, `startAfter`, `limit` and a cursor,
 * and the two conditional puts the cache uses (`etagDoesNotMatch: "*"` and `etagMatches`), answering `null` when the
 * condition fails as R2 does. Multipart uploads are outside the scenarios.
 */
export const simBucket = (now: () => number): Bucket => {
  const objects = new Map<string, Stored>();
  let version = 0;
  const bytesOf = async (value: unknown): Promise<Uint8Array> => {
    if (value === null || value === undefined) return new Uint8Array();
    if (typeof value === "string") return encoder.encode(value);
    if (value instanceof Uint8Array) return value.slice();
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
  };
  const bucket = {
    head: async (key: string) => {
      const s = objects.get(key);
      return s === undefined ? null : objectOf(key, s);
    },
    get: async (key: string) => {
      const s = objects.get(key);
      return s === undefined ? null : bodyOf(key, s);
    },
    put: async (key: string, value: unknown, options?: R2PutOptions) => {
      const bytes = await bytesOf(value);
      const existing = objects.get(key);
      const onlyIf = options?.onlyIf as R2Conditional | undefined;
      if (onlyIf?.etagDoesNotMatch === "*" && existing !== undefined) return null;
      if (onlyIf?.etagMatches !== undefined && existing?.etag !== onlyIf.etagMatches) return null;
      const stored: Stored = {
        bytes,
        etag: `v${++version}`,
        uploaded: now(),
        customMetadata: { ...options?.customMetadata },
        httpMetadata: (options?.httpMetadata ?? {}) as R2HTTPMetadata,
      };
      objects.set(key, stored);
      return objectOf(key, stored);
    },
    delete: async (keys: string | string[]) => {
      for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key);
    },
    list: async (options?: R2ListOptions) => {
      const prefix = options?.prefix ?? "";
      const after = options?.cursor ?? options?.startAfter;
      const limit = options?.limit ?? 1000;
      const keys = [...objects.keys()]
        .filter((k) => k.startsWith(prefix) && (after === undefined || k > after))
        .sort();
      const page = keys.slice(0, limit);
      const truncated = keys.length > limit;
      return {
        objects: page.map((k) => objectOf(k, objects.get(k)!)),
        delimitedPrefixes: [],
        truncated,
        ...(truncated ? { cursor: page.at(-1)! } : {}),
      };
    },
    createMultipartUpload: () => Promise.reject(new Error("no multipart upload in the simulation")),
    resumeMultipartUpload: () => {
      throw new Error("no multipart upload in the simulation");
    },
  };
  return bucket as unknown as Bucket;
};

const ORIGIN = "https://ci.example.com";
const REPO = "acme/widgets";
const KINDS = ["cloudflare", "aws", "device", "gha"] as const;
/** Keys an executor might use to hand its checkout, workspace or build output to the next one. */
const WORKSPACE_KEYS = (executionId: string, epoch: number) => [
  `workspace/${executionId}/${epoch}/src.tar`,
  `checkout/${executionId}/${epoch}/repo.tar`,
  `target/${executionId}/${epoch}/release.tar`,
  `artifacts/${executionId}/${epoch}/workspace.tar`,
  `cache/${pullRequestNamespace(REPO, 7)}/workspace.tar`,
];

interface Holder {
  readonly epoch: number;
  readonly grant: UploadGrant;
  readonly write: string | null;
}

const hexOf = (random: () => number) =>
  Array.from({ length: 64 }, () => Math.floor(random() * 16).toString(16)).join("");

/**
 * One execution of a pull request, reclaimed onto another executor of a seeded kind at seeded times. Between
 * reclaims, the holder of the current epoch or of an earlier one asks `exec.presign` for cache and log `PUT`s, uses
 * its compile-cache token, or tries to fetch an earlier epoch's uploads and to write a workspace-shaped key.
 */
export const simulateReclaim = async (seed: number, signer: ManifestSignerService): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  const executionId = `exec-sim-${seed}`;
  const w: World = world([]);
  w.now = START + Math.floor(random() * HOUR);
  const bucket = simBucket(() => w.now);
  const holders: Holder[] = [];
  const uploads: { readonly key: string; readonly epoch: number }[] = [];
  const violations: Violation[] = [];
  const trace: string[] = [];
  const reached: Record<string, number> = {
    reclaims: 0,
    stalePresign: 0,
    currentPresign: 0,
    staleToken: 0,
    currentToken: 0,
    refusedTransfer: 0,
    refusedWorkspaceKey: 0,
  };
  const flag = (id: string, message: string) =>
    violations.push({ id, message: `seed ${seed} at +${w.now - START} ms: ${message}` });
  const current = () => holders.at(-1)!;
  const presign = (
    epoch: number,
    objects: readonly { key: string; method: "GET" | "PUT"; length: number | null }[],
  ) =>
    Effect.runPromiseExit(
      presignForExecution({ execution_id: executionId, epoch, objects }).pipe(
        Effect.provide(layers(w, bucket, signer)),
      ),
    );

  const reclaim = async () => {
    const epoch = holders.length + 1;
    const executorKind = pick(KINDS);
    const deadlineAt = w.now + 3 * HOUR;
    const fields = await leaseCacheFields(
      {
        repo: REPO,
        executionId,
        class: "interactive",
        constraints: [],
        trigger: { _tag: "PullRequest", number: 7 },
      },
      { epoch, executorKind, deadlineAt },
      { publicOrigin: ORIGIN, tokenSecret: SECRET },
    );
    const lease: LeaseState = {
      executionId,
      repo: REPO,
      epoch,
      status: "active",
      namespaces: fields.cache_namespaces,
      executorId: `${executorKind}-${epoch}`,
      executorKind,
      class: "interactive",
      deadlineAt,
    };
    w.leases.set(executionId, lease);
    holders.push({ epoch, grant: fields.upload_grant, write: fields.cache_namespaces.write });
    if (epoch > 1) reached.reclaims!++;
    trace.push(`reclaim ${epoch} ${executorKind}`);
    if (!grantCarriesNoWorkspace(fields.upload_grant, executionId, epoch))
      flag("FD-CACHE-002", `epoch ${epoch}'s upload grant names a prefix outside cache, artifacts and logs`);
    for (const earlier of holders.slice(0, -1))
      for (const prefix of [fields.upload_grant.artifact_prefix, fields.upload_grant.log_prefix])
        if (prefix === earlier.grant.artifact_prefix || prefix === earlier.grant.log_prefix)
          flag("FD-CACHE-002", `epoch ${epoch} is granted epoch ${earlier.epoch}'s prefix ${prefix}`);
  };

  /** A cache-object or log `PUT` by the holder of `h`'s epoch. */
  const put = async (h: Holder, step: number) => {
    const log = random() < 0.4;
    const key = log
      ? await logObjectName({
          executionId,
          epoch: h.epoch,
          journalName: `step-${step}`,
          stream: "stdout",
          start: 0,
          end: step,
        })
      : h.write === null
        ? undefined
        : `${objectPrefix(h.write, hexOf(random), executionId, h.epoch)}blob-${step}`;
    if (key === undefined) return;
    const length = 1 + Math.floor(random() * 512);
    const signedBefore = w.signed.length;
    const exit = await presign(h.epoch, [{ key, method: "PUT", length }]);
    const answer = Exit.isSuccess(exit) ? exit.value : undefined;
    const stale = h.epoch !== current().epoch;
    trace.push(`put ${h.epoch}/${current().epoch} ${log ? "log" : "cache"} ${answer === undefined ? "refused" : "status" in answer ? answer.status : "urls"}`);
    if (stale) {
      reached.stalePresign!++;
      if (answer === undefined || !("status" in answer) || answer.status !== "stale")
        flag("FD-CACHE-051", `epoch ${h.epoch}'s URL request after the reclaim to ${current().epoch} was not answered stale`);
      if (w.signed.length !== signedBefore)
        flag("FD-CACHE-051", `epoch ${h.epoch}'s URL request after the reclaim got a URL signed`);
      return;
    }
    if (answer === undefined || "status" in answer) {
      flag("FD-CACHE-051", `the current epoch ${h.epoch}'s ${key} PUT was refused`);
      return;
    }
    reached.currentPresign!++;
    for (const url of answer.urls) {
      if (url.expires_at > w.now + MAX_URL_LIFETIME_MS)
        flag("FD-CACHE-051", `${url.key} lives ${url.expires_at - w.now} ms, past 15 min`);
      const inEpochPath =
        url.key.startsWith(`logs/${executionId}/${h.epoch}/`) ||
        (h.write !== null &&
          url.key.startsWith(`cache/${h.write}/`) &&
          url.key.slice(`cache/${h.write}/`.length).split("/")[1] === `${executionId}.${h.epoch}`);
      if (!inEpochPath) flag("FD-CACHE-051", `${url.key} is outside epoch ${h.epoch}'s object path`);
    }
    // The executor uploads through the URL it was handed.
    await bucket.put(key, "x".repeat(length));
    if (!log) uploads.push({ key, epoch: h.epoch });
  };

  /** The current holder tries to fetch an earlier epoch's upload, and to write a workspace-shaped key. */
  const transfer = async () => {
    const h = current();
    const earlier = uploads.filter((u) => u.epoch < h.epoch);
    if (earlier.length > 0) {
      const u = pick(earlier);
      const exit = await presign(h.epoch, [{ key: u.key, method: "GET", length: null }]);
      trace.push(`fetch-earlier ${u.epoch}/${h.epoch} ${Exit.isSuccess(exit) ? "signed" : "refused"}`);
      if (Exit.isSuccess(exit) || !(failureOf(exit) instanceof PresignRefused))
        flag("FD-CACHE-002", `epoch ${h.epoch} was handed epoch ${u.epoch}'s upload ${u.key}`);
      else reached.refusedTransfer!++;
    }
    const key = pick(WORKSPACE_KEYS(executionId, pick(holders).epoch));
    const method = pick(["GET", "PUT"] as const);
    const exit = await presign(h.epoch, [{ key, method, length: method === "PUT" ? 64 : null }]);
    trace.push(`workspace-key ${method} ${Exit.isSuccess(exit) ? "signed" : "refused"}`);
    if (Exit.isSuccess(exit) || !(failureOf(exit) instanceof PresignRefused))
      flag("FD-CACHE-002", `epoch ${h.epoch} got a ${method} URL for ${key}`);
    else reached.refusedWorkspaceKey!++;
  };

  /** A compile-cache request with the token of `h`'s epoch, the route mounted as the control plane mounts it. */
  const compile = async (h: Holder, step: number) => {
    const cc = h.grant.compile_cache;
    if (cc === null) return;
    const method = pick(["GET", "PUT"] as const);
    const name = `obj-${seed}-${step}`;
    const response = await handleCompileCache(
      new Request(`${cc.endpoint}/${name}`, {
        method,
        headers: {
          authorization: `Bearer ${cc.token}`,
          ...(method === "PUT" ? { "content-length": "3" } : {}),
        },
        ...(method === "PUT" ? { body: "abc" } : {}),
      }),
      {
        bucket,
        ledgers: w.ledgers,
        secret: SECRET,
        now: () => w.now,
        lease: async () => {
          const lease = w.leases.get(executionId);
          return lease === undefined ? null : { epoch: lease.epoch, terminal: false };
        },
      },
    );
    const status = response?.status ?? 0;
    trace.push(`compile ${method} ${h.epoch}/${current().epoch} ${status}`);
    if (h.epoch !== current().epoch) {
      reached.staleToken!++;
      if (status !== 403)
        flag("FD-CACHE-051", `epoch ${h.epoch}'s compile-cache token after the reclaim answered ${status}`);
      if (method === "PUT" && h.write !== null && (await bucket.head(compileObjectKey(h.write, name))) !== null)
        flag("FD-CACHE-051", `epoch ${h.epoch}'s stale token wrote ${name}`);
      return;
    }
    reached.currentToken!++;
    if (status === 403)
      flag("FD-CACHE-051", `the current epoch ${h.epoch}'s compile-cache token was refused`);
  };

  await reclaim();
  const steps = 14 + Math.floor(random() * 10);
  for (let step = 1; step <= steps; step++) {
    w.now += Math.floor(random() * 6 * MINUTE);
    const roll = random();
    if (roll < 0.15 && holders.length < 6) {
      await reclaim();
      continue;
    }
    // An executor of an earlier epoch keeps acting about half the time after a reclaim.
    const h = holders.length > 1 && random() < 0.5 ? pick(holders.slice(0, -1)) : current();
    if (roll < 0.55) await put(h, step);
    else if (roll < 0.75) await transfer();
    else await compile(h, step);
  }
  return { violations, reached, trace };
};

/**
 * Up to eight entries committed over the first 20 days and read at seeded times through `exec.presign`, which
 * refreshes `last_read_at`, while the cache sweep ticks every 6 to 30 hours for 40 days. Some ticks land exactly on,
 * or 1 ms past, an entry's TTL. Before each tick the scenario reads every entry's `last_read_at`, and after it checks
 * that the sweep deleted exactly the entries whose `last_read_at` is older than the TTL, each with all its objects.
 */
export const simulateSweep = async (seed: number, signer: ManifestSignerService): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  const ttlMs = CACHE_TTL_MS;
  const namespaces = [pullRequestNamespace(REPO, 7), protectedCloud(REPO)];
  const reader: LeaseState = {
    executionId: "exec-reader",
    repo: REPO,
    epoch: 1,
    status: "active",
    namespaces: { read: namespaces, write: null },
    executorId: "cf-reader",
    executorKind: "cloudflare",
    class: "interactive",
    deadlineAt: START + 365 * DAY,
  };
  const w: World = world([reader]);
  w.now = START;
  const bucket = simBucket(() => w.now);
  const violations: Violation[] = [];
  const trace: string[] = [];
  const reached: Record<string, number> = { expired: 0, kept: 0, refreshed: 0, boundary: 0, ticks: 0 };
  const flag = (message: string) =>
    violations.push({ id: "FD-CACHE-062", message: `seed ${seed} at +${w.now - START} ms: ${message}` });
  const entries: { namespace: string; key: string; objects: string[]; gone: boolean }[] = [];
  const total = 3 + Math.floor(random() * 6);
  const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect);
  const provide = Effect.provide(layers(w, bucket, signer));
  const lastReadOf = async (e: { namespace: string; key: string }) =>
    Number((await bucket.head(manifestPath(e.namespace, e.key)))?.customMetadata?.last_read_at);

  const commit = async () => {
    const i = entries.length;
    const namespace = pick(namespaces);
    const key = await sha256Hex(`${seed}-${i}`);
    const writer = `exec-writer-${i}`;
    w.leases.set(writer, {
      ...reader,
      executionId: writer,
      executorId: `cf-${i}`,
      namespaces: { read: [], write: namespace },
    });
    const objects = [];
    for (let n = 0; n < 1 + Math.floor(random() * 3); n++) {
      const path = `${objectPrefix(namespace, key, writer, 1)}part-${n}`;
      const body = `entry ${i} part ${n}`;
      await bucket.put(path, body);
      objects.push({ path, size: body.length, sha256: await sha256Hex(body) });
    }
    const exit = await run(
      commitCacheManifest({ execution_id: writer, epoch: 1, manifest: { key, namespace, objects } }).pipe(provide),
    );
    trace.push(`commit ${i} ${Exit.isSuccess(exit) ? exit.value : "refused"}`);
    entries.push({ namespace, key, objects: objects.map((o) => o.path), gone: false });
  };

  const read = async () => {
    const live = entries.filter((e) => !e.gone);
    if (live.length === 0) return;
    const e = pick(live);
    const before = await lastReadOf(e);
    const exit = await run(
      presignForExecution({
        execution_id: reader.executionId,
        epoch: 1,
        objects: [{ key: pick(e.objects), method: "GET", length: null }],
      }).pipe(provide),
    );
    const after = await lastReadOf(e);
    trace.push(`read ${entries.indexOf(e)} ${Exit.isSuccess(exit) ? "signed" : "refused"} ${after - START}`);
    if (after !== before) reached.refreshed!++;
  };

  const tick = async () => {
    const live = entries.filter((e) => !e.gone);
    const lastRead = new Map<(typeof live)[number], number>();
    for (const e of live) lastRead.set(e, await lastReadOf(e));
    // The sweep runs with its defaults, as the control plane's tick runs it.
    const result = await sweepCache(bucket, w.now, {
      ledgers: w.ledgers,
      pullRequestClosedAt: async () => null,
    });
    reached.ticks!++;
    trace.push(`tick ${w.now - START} deleted ${result.deletedObjects}`);
    for (const e of live) {
      const age = w.now - lastRead.get(e)!;
      const expired = age > ttlMs;
      if (age === ttlMs || age === ttlMs + 1) reached.boundary!++;
      const manifest = (await bucket.head(manifestPath(e.namespace, e.key))) !== null;
      const objects = await Promise.all(e.objects.map(async (p) => (await bucket.head(p)) !== null));
      if (expired) {
        if (manifest || objects.some(Boolean))
          flag(`entry ${e.key.slice(0, 8)} last read ${age} ms ago, past the ${ttlMs} ms TTL, was not deleted whole`);
        else reached.expired!++;
        e.gone = true;
      } else if (!manifest || objects.some((o) => !o)) {
        flag(`entry ${e.key.slice(0, 8)} last read ${age} ms ago, within the ${ttlMs} ms TTL, lost its manifest or an object`);
        e.gone = true;
      } else reached.kept!++;
    }
  };

  while (w.now < START + 40 * DAY) {
    const live = entries.filter((e) => !e.gone);
    // Some ticks land exactly on, or 1 ms past, the TTL of the entry read longest ago.
    if (live.length > 0 && random() < 0.25) {
      const oldest = Math.min(...(await Promise.all(live.map(lastReadOf))));
      const at = oldest + ttlMs + pick([0, 1]);
      if (at > w.now) w.now = at;
      else w.now += (6 + Math.floor(random() * 24)) * HOUR;
    } else w.now += (6 + Math.floor(random() * 24)) * HOUR;
    if (entries.length < total && w.now < START + 20 * DAY && random() < 0.5) await commit();
    for (let r = Math.floor(random() * 3); r > 0; r--) if (random() < 0.4) await read();
    await tick();
  }
  return { violations, reached, trace };
};
