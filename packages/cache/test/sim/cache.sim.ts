// The cache's V-SIM scenarios (specs/verification.md § V-SIM). Each scenario takes a seed that fixes every
// interleaving and every step of the clock the cache code reads (`CacheClock`), runs the control plane's cache
// policies against an in-memory bucket that stamps `uploaded` from the same clock, and returns the property violations
// it saw, the cases the seed reached and a trace that replays exactly. R2's own conditional writes are checked against
// Miniflare by the unit suites; here the bucket keeps every run in one process and on one clock.
//
// - `simulateReclaim`: an execution is reclaimed onto other executors and its lease revoked, while the executors of
//   earlier epochs keep asking for URLs, using their compile-cache tokens and committing manifests and artifacts for
//   their uploads (FD-CACHE-051, FD-CACHE-040, FD-CACHE-071), and every executor tries to reach what an earlier epoch
//   left behind (FD-CACHE-002). Each epoch's executor starts its job workspace on one of two hosts that earlier
//   epochs' workspaces may still occupy, and its start record goes through `checkWorkspaceStart` (FD-CACHE-003).
// - `simulateSweep`: entries are committed and read over 40 days while the cache sweep ticks (FD-CACHE-062).
//
// `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts): each seed fails on any violation.
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect, Exit, Layer, Scope } from "effect";
import { CommandExit, GateExec, processGateExec } from "../../../catalog/src/command.ts";
import { checkedOutWorkspace } from "../../../catalog/src/job.ts";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import {
  ARTIFACT_SCHEMA,
  artifactPath,
  beginArtifactUpload,
  commitArtifact,
} from "../../src/artifacts.ts";
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
import { presignForExecution, PresignRefused } from "../../src/presign.ts";
import { sweepCache } from "../../src/sweep.ts";
import {
  checkWorkspaceStart,
  grantCarriesNoWorkspace,
  type WorkspaceStart,
} from "../../src/workspace.ts";
import {
  failureOf,
  layers,
  SECRET,
  signerFor,
  signingKeys,
  world,
  type World,
} from "../../src/support.test-support.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The simulated clock starts here. */
const START = Date.UTC(2026, 0, 1);
/** The longest URL lifetime FD-CACHE-051 allows. */
const URL_LIFETIME_MS = 15 * MINUTE;
/** The TTL FD-CACHE-062 states. */
export const CACHE_TTL_MS = 14 * DAY;

export interface SimOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

let signer: Promise<ManifestSignerService> | undefined;
/** The control plane's manifest signer, built once for every run in the process. */
export const signerOnce = (): Promise<ManifestSignerService> =>
  (signer ??= signingKeys().then((keys) => signerFor(keys.pair.privateKey)));

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
  readonly kind: (typeof KINDS)[number];
  readonly grant: UploadGrant;
  readonly write: string | null;
  readonly workspace: JobWorkspace;
}

/**
 * The gate job workspace an epoch's executor runs in. When its epoch ends the executor either stops, which closes the
 * job's scope and removes the directory; is lost before the release runs, which leaves the directory on the host; or
 * keeps running, writing build output into it.
 */
interface JobWorkspace {
  readonly host: number;
  readonly dir: string;
  readonly scope: Scope.Closeable;
  fate: "current" | "stopped" | "left" | "running";
}

/** The commit every epoch's gate job checks out. */
const SHA = "0123456789abcdef0123456789abcdef01234567";
/** The hosts the executors of one execution share, each with its own `FD_WORKSPACE_ROOT`. */
const HOSTS = 2;

/** The entries in a directory, 0 where it no longer exists. */
const entriesOf = (dir: string): Promise<number> =>
  readdir(dir).then(
    (entries) => entries.length,
    () => 0,
  );

/** The real gate executor, whose workspaces are created and removed on this host's file system. */
const processExec = Effect.runSync(
  Effect.gen(function* () {
    return yield* GateExec;
  }).pipe(Effect.provide(processGateExec)),
);

/**
 * A `GateExec` over the real workspace whose commands the simulation answers. The first command a job runs in its
 * workspace yields the start record: the entries in the directory at that moment, and whether the command fetches the
 * commit. A fetch then places the checkout, as `git` would.
 */
const recordingGateExec = (epoch: number, starts: WorkspaceStart[]) =>
  Layer.succeed(GateExec, {
    ...processExec,
    run: (options) =>
      Effect.promise(async () => {
        const entries = await entriesOf(options.cwd);
        const fetchedCommit = new RegExp(`\\bgit fetch\\b[^&]*--depth 1 origin ${SHA}\\b`).test(
          options.command,
        );
        if (starts.length === 0)
          starts.push({ epoch, entriesAtStart: entries, fetchedCommit, placed: [] });
        if (fetchedCommit) {
          await mkdir(join(options.cwd, ".git"), { recursive: true });
          await writeFile(join(options.cwd, ".git", "HEAD"), SHA);
          await writeFile(join(options.cwd, "package.json"), "{}");
        }
        return { exit: CommandExit.Exited({ code: 0 }), output: new Uint8Array() };
      }),
  });

/** The control plane's artifact tables (D1) in an in-memory SQLite database; `batch` runs in one transaction. */
const sqliteArtifactDb = () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const statement of ARTIFACT_SCHEMA) sqlite.exec(statement);
  const statement = (sql: string, params: readonly SQLInputValue[] = []) => ({
    bind: (...values: SQLInputValue[]) => statement(sql, values),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      sqlite.prepare(sql).run(...params);
      return { results: [], success: true, meta: {} };
    },
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: readonly ReturnType<typeof statement>[]) => {
      sqlite.exec("begin");
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        sqlite.exec("commit");
        return out;
      } catch (e) {
        sqlite.exec("rollback");
        throw e;
      }
    },
  };
  const artifactRows = (executionId: string, epoch: number, name: string) =>
    Number(
      (
        sqlite
          .prepare(
            "select count(*) as n from fd_artifacts where execution_id = ? and epoch = ? and name = ?",
          )
          .get(executionId, epoch, name) as { n: number }
      ).n,
    );
  return {
    db: db as unknown as D1Database,
    artifactRows,
    close: () => sqlite.close(),
  };
};

/** An artifact an executor uploaded through its URL and has not had committed. */
interface ArtifactUpload {
  readonly epoch: number;
  readonly name: string;
  committed: boolean;
}

/** A cache object an executor uploaded through its URL, under entry `entry` of `namespace`. */
interface Upload {
  readonly key: string;
  readonly epoch: number;
  readonly namespace: string;
  readonly entry: string;
  readonly size: number;
  committed: boolean;
}

const hexOf = (random: () => number) =>
  Array.from({ length: 64 }, () => Math.floor(random() * 16).toString(16)).join("");

/**
 * One execution of a pull request, reclaimed onto another executor of a seeded kind at seeded times and sometimes
 * revoked, which leaves no current epoch until the next reclaim. Between those events, the holder of the current
 * epoch or of an earlier one asks `exec.presign` for cache and log `PUT`s, uses its compile-cache token, commits a
 * manifest for its uploads, starts and commits an artifact, or tries to fetch an earlier epoch's uploads and to write a
 * workspace-shaped key. Each epoch's executor checks the commit out in a gate job workspace on a seeded host first.
 */
export const simulateReclaim = async (
  seed: number,
  signer: ManifestSignerService,
): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  const executionId = `exec-sim-${seed}`;
  const w: World = world([]);
  w.now = START + Math.floor(random() * HOUR);
  const bucket = simBucket(() => w.now);
  const holders: Holder[] = [];
  /** The epoch the control plane's lease carries; `null` once the lease is revoked, until the next reclaim. */
  let live: number | null = null;
  const uploads: Upload[] = [];
  const artifacts: ArtifactUpload[] = [];
  const artifactDb = sqliteArtifactDb();
  const hostsRoot = await mkdtemp(join(tmpdir(), "fd-sim-hosts-"));
  const hostRoots = Array.from({ length: HOSTS }, (_, i) => join(hostsRoot, `host-${i}`));
  for (const root of hostRoots) await mkdir(root);
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached: Record<string, number> = {
    reclaims: 0,
    revokes: 0,
    stalePresign: 0,
    currentPresign: 0,
    staleToken: 0,
    currentToken: 0,
    staleCommit: 0,
    currentCommit: 0,
    refusedTransfer: 0,
    refusedWorkspaceKey: 0,
    staleArtifactBegin: 0,
    staleArtifactCommit: 0,
    currentArtifactCommit: 0,
    restartedWorkspace: 0,
    leftoverOnHost: 0,
    runningEarlier: 0,
  };
  const flag = (id: string, message: string) =>
    violations.push({ id, message: `seed ${seed} at +${w.now - START} ms: ${message}` });
  const ended = () => (live === null ? "the revoke" : `the reclaim to ${live}`);
  const provide = Effect.provide(layers(w, bucket, signer, artifactDb.db));
  const presign = (
    epoch: number,
    objects: readonly { key: string; method: "GET" | "PUT"; length: number | null }[],
  ) =>
    Effect.runPromiseExit(
      presignForExecution({ execution_id: executionId, epoch, objects }).pipe(provide),
    );

  /** The executor of the epoch that just ended stops, is lost with its workspace left on the host, or keeps running. */
  const endWorkspace = async (h: Holder) => {
    const fate = pick(["stopped", "left", "running"] as const);
    h.workspace.fate = fate;
    if (fate === "stopped") await Effect.runPromise(Scope.close(h.workspace.scope, Exit.void));
    trace.push(`workspace ${h.epoch} ${fate}`);
  };

  /**
   * The new epoch's executor starts a gate job on a seeded host: catalog's `checkedOutWorkspace` with the real
   * workspace under that host's root, which may still hold an earlier epoch's workspace. Its start record goes through
   * `checkWorkspaceStart`.
   */
  const startWorkspace = async (epoch: number): Promise<JobWorkspace> => {
    const host = Math.floor(random() * HOSTS);
    const earlier = holders.filter((h) => h.workspace.fate !== "stopped");
    for (const h of earlier)
      if (h.workspace.host === host && (await entriesOf(h.workspace.dir)) > 0) {
        reached.leftoverOnHost!++;
        break;
      }
    if (earlier.some((h) => h.workspace.fate === "running")) reached.runningEarlier!++;
    const starts: WorkspaceStart[] = [];
    const scope = Effect.runSync(Scope.make());
    const previousRoot = process.env["FD_WORKSPACE_ROOT"];
    process.env["FD_WORKSPACE_ROOT"] = hostRoots[host]!;
    const exit = await Effect.runPromiseExit(
      checkedOutWorkspace({
        repo: `https://github.com/${REPO}.git`,
        sha: SHA,
        ref: "refs/pull/7/head",
      }).pipe(Scope.provide(scope), Effect.provide(recordingGateExec(epoch, starts))),
    ).finally(() => {
      if (previousRoot === undefined) delete process.env["FD_WORKSPACE_ROOT"];
      else process.env["FD_WORKSPACE_ROOT"] = previousRoot;
    });
    const dir = Exit.isSuccess(exit) ? exit.value : "";
    const start = starts[0];
    trace.push(
      `workspace ${epoch} host ${host} ${start === undefined ? "no command" : `${start.entriesAtStart} entries ${start.fetchedCommit ? "fetched" : "not fetched"}`}`,
    );
    if (Exit.isFailure(exit)) flag("FD-CACHE-003", `epoch ${epoch}'s checkout failed`);
    else if (start === undefined)
      flag("FD-CACHE-003", `epoch ${epoch}'s job ran no command in its workspace`);
    else {
      if (epoch > 1) reached.restartedWorkspace!++;
      for (const violation of checkWorkspaceStart(start))
        flag(violation.slice(0, violation.indexOf(":")), violation);
      for (const h of earlier)
        if (h.workspace.dir === dir)
          flag("FD-CACHE-003", `epoch ${epoch} started in epoch ${h.epoch}'s workspace`);
    }
    return { host, dir, scope, fate: "current" };
  };

  const reclaim = async () => {
    const previous = holders.find((h) => h.epoch === live);
    if (previous !== undefined) await endWorkspace(previous);
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
    const workspace = await startWorkspace(epoch);
    holders.push({
      epoch,
      kind: executorKind,
      grant: fields.upload_grant,
      write: fields.cache_namespaces.write,
      workspace,
    });
    if (epoch > 1) reached.reclaims!++;
    live = epoch;
    trace.push(`reclaim ${epoch} ${executorKind}`);
    if (!grantCarriesNoWorkspace(fields.upload_grant, executionId, epoch))
      flag(
        "FD-CACHE-002",
        `epoch ${epoch}'s upload grant names a prefix outside cache, artifacts and logs`,
      );
    for (const earlier of holders.slice(0, -1))
      for (const prefix of [fields.upload_grant.artifact_prefix, fields.upload_grant.log_prefix])
        if (prefix === earlier.grant.artifact_prefix || prefix === earlier.grant.log_prefix)
          flag(
            "FD-CACHE-002",
            `epoch ${epoch} is granted epoch ${earlier.epoch}'s prefix ${prefix}`,
          );
  };

  /**
   * A cache-object or log `PUT` by the holder of `h`'s epoch, after a build step that writes output into its
   * workspace while its executor runs.
   */
  const put = async (h: Holder, step: number) => {
    if (h.workspace.fate === "current" || h.workspace.fate === "running") {
      await mkdir(join(h.workspace.dir, "target"), { recursive: true });
      await writeFile(join(h.workspace.dir, "target", `out-${step}`), `epoch ${h.epoch}`);
    }
    const log = random() < 0.4;
    const namespace = h.write;
    const entry = log || namespace === null ? undefined : hexOf(random);
    const key =
      entry !== undefined && namespace !== null
        ? `${objectPrefix(namespace, entry, executionId, h.epoch)}blob-${step}`
        : log
          ? await logObjectName({
              executionId,
              epoch: h.epoch,
              journalName: `step-${step}`,
              stream: "stdout",
              start: 0,
              end: step,
            })
          : undefined;
    if (key === undefined) return;
    const length = 1 + Math.floor(random() * 512);
    const signedBefore = w.signed.length;
    const exit = await presign(h.epoch, [{ key, method: "PUT", length }]);
    const answer = Exit.isSuccess(exit) ? exit.value : undefined;
    trace.push(
      `put ${h.epoch}/${live ?? "-"} ${log ? "log" : "cache"} ${answer === undefined ? "refused" : "status" in answer ? answer.status : "urls"}`,
    );
    if (h.epoch !== live) {
      reached.stalePresign!++;
      if (answer === undefined || !("status" in answer) || answer.status !== "stale")
        flag(
          "FD-CACHE-051",
          `epoch ${h.epoch}'s URL request after ${ended()} was not answered stale`,
        );
      if (w.signed.length !== signedBefore)
        flag("FD-CACHE-051", `epoch ${h.epoch}'s URL request after ${ended()} got a URL signed`);
      return;
    }
    if (answer === undefined || "status" in answer) {
      flag("FD-CACHE-051", `the current epoch ${h.epoch}'s ${key} PUT was refused`);
      return;
    }
    reached.currentPresign!++;
    for (const url of answer.urls) {
      if (url.expires_at > w.now + URL_LIFETIME_MS)
        flag("FD-CACHE-051", `${url.key} lives ${url.expires_at - w.now} ms, past 15 min`);
      const inEpochPath =
        url.key.startsWith(`logs/${executionId}/${h.epoch}/`) ||
        (h.write !== null &&
          url.key.startsWith(`cache/${h.write}/`) &&
          url.key.slice(`cache/${h.write}/`.length).split("/")[1] === `${executionId}.${h.epoch}`);
      if (!inEpochPath)
        flag("FD-CACHE-051", `${url.key} is outside epoch ${h.epoch}'s object path`);
    }
    // The executor uploads through the URL it was handed.
    await bucket.put(key, "x".repeat(length));
    if (entry !== undefined && namespace !== null)
      uploads.push({ key, epoch: h.epoch, namespace, entry, size: length, committed: false });
  };

  /**
   * The holder of `h`'s epoch commits a manifest for one entry it uploaded and never committed. Before its lease ends
   * the commit is accepted; after a reclaim or a revoke it is `stale` and no manifest is written, so the uploads never
   * become an entry. A device executor's current-epoch commit needs its registered key's signature and is left out.
   */
  const commit = async (h: Holder) => {
    const stale = h.epoch !== live;
    if (!stale && h.kind === "device") return;
    const pending = uploads.filter((u) => u.epoch === h.epoch && !u.committed);
    if (pending.length === 0) return;
    const { namespace, entry } = pick(pending);
    const objects = pending.filter((u) => u.namespace === namespace && u.entry === entry);
    const exit = await Effect.runPromiseExit(
      commitCacheManifest({
        execution_id: executionId,
        epoch: h.epoch,
        manifest: {
          key: entry,
          namespace,
          objects: await Promise.all(
            objects.map(async (u) => ({
              path: u.key,
              size: u.size,
              sha256: await sha256Hex("x".repeat(u.size)),
            })),
          ),
        },
      }).pipe(provide),
    );
    const ack = Exit.isSuccess(exit) ? exit.value : `refused ${String(failureOf(exit))}`;
    const manifest = (await bucket.head(manifestPath(namespace, entry))) !== null;
    trace.push(`commit ${h.epoch}/${live ?? "-"} ${ack}`);
    if (stale) {
      reached.staleCommit!++;
      if (ack !== "stale")
        flag("FD-CACHE-040", `epoch ${h.epoch}'s commit after ${ended()} was answered ${ack}`);
      if (manifest)
        flag(
          "FD-CACHE-051",
          `epoch ${h.epoch}'s uploads under ${entry.slice(0, 8)} became an entry after ${ended()}`,
        );
      return;
    }
    if (ack !== "accepted" || !manifest) {
      flag("FD-CACHE-040", `the current epoch ${h.epoch}'s commit was answered ${ack}`);
      return;
    }
    reached.currentCommit!++;
    for (const u of objects) u.committed = true;
  };

  /**
   * The holder of `h`'s epoch starts an artifact upload and, handed a URL, uploads the body through it. Under an
   * earlier epoch the request is answered `stale` and nothing is signed.
   */
  const beginArtifact = async (h: Holder, step: number) => {
    const name = `report-${step}.html`;
    const body = `<p>epoch ${h.epoch} step ${step}</p>`;
    const signedBefore = w.signed.length;
    const exit = await Effect.runPromiseExit(
      beginArtifactUpload({
        execution_id: executionId,
        epoch: h.epoch,
        name,
        size: body.length,
        sha256: await sha256Hex(body),
        content_type: "text/html",
      }).pipe(provide),
    );
    const answer = Exit.isSuccess(exit) ? exit.value.status : `refused ${String(failureOf(exit))}`;
    trace.push(`artifact-begin ${h.epoch}/${live ?? "-"} ${answer}`);
    if (h.epoch !== live) {
      reached.staleArtifactBegin!++;
      if (answer !== "stale")
        flag(
          "FD-CACHE-051",
          `epoch ${h.epoch}'s artifact upload after ${ended()} was answered ${answer}`,
        );
      if (w.signed.length !== signedBefore)
        flag(
          "FD-CACHE-051",
          `epoch ${h.epoch}'s artifact upload after ${ended()} got a URL signed`,
        );
      return;
    }
    if (answer !== "ok") {
      flag("FD-CACHE-071", `the current epoch ${h.epoch}'s artifact upload was answered ${answer}`);
      return;
    }
    await bucket.put(artifactPath(executionId, h.epoch, name), body);
    artifacts.push({ epoch: h.epoch, name, committed: false });
  };

  /**
   * The holder of `h`'s epoch commits an artifact it uploaded and never had committed. Before its lease ends the commit
   * is accepted and recorded; after a reclaim or a revoke it is `stale` and records no artifact.
   */
  const commitArtifactOf = async (h: Holder) => {
    const pending = artifacts.filter((a) => a.epoch === h.epoch && !a.committed);
    if (pending.length === 0) return;
    const a = pick(pending);
    const stale = h.epoch !== live;
    const exit = await Effect.runPromiseExit(
      commitArtifact(
        { execution_id: executionId, epoch: h.epoch, name: a.name },
        { repo: REPO, private: true },
      ).pipe(provide),
    );
    const ack = Exit.isSuccess(exit) ? exit.value.status : `refused ${String(failureOf(exit))}`;
    const rows = artifactDb.artifactRows(executionId, h.epoch, a.name);
    trace.push(`artifact-commit ${h.epoch}/${live ?? "-"} ${ack}`);
    if (stale) {
      reached.staleArtifactCommit!++;
      if (ack !== "stale")
        flag(
          "FD-CACHE-071",
          `epoch ${h.epoch}'s artifact commit after ${ended()} was answered ${ack}`,
        );
      if (rows !== 0)
        flag("FD-CACHE-071", `epoch ${h.epoch}'s ${a.name} became an artifact after ${ended()}`);
      return;
    }
    if (ack !== "accepted" || rows !== 1) {
      flag("FD-CACHE-071", `the current epoch ${h.epoch}'s artifact commit was answered ${ack}`);
      return;
    }
    reached.currentArtifactCommit!++;
    a.committed = true;
  };

  /**
   * The current holder tries to fetch an upload an earlier epoch never got committed, and to write a workspace-shaped
   * key. An entry an earlier epoch committed while it was current is ordinary cache, readable by a later epoch.
   */
  const transfer = async () => {
    const h = holders.find((x) => x.epoch === live);
    if (h === undefined) return;
    const earlier = uploads.filter((u) => u.epoch < h.epoch && !u.committed);
    if (earlier.length > 0) {
      const u = pick(earlier);
      const exit = await presign(h.epoch, [{ key: u.key, method: "GET", length: null }]);
      trace.push(
        `fetch-earlier ${u.epoch}/${h.epoch} ${Exit.isSuccess(exit) ? "signed" : "refused"}`,
      );
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
    trace.push(`compile ${method} ${h.epoch}/${live ?? "-"} ${status}`);
    if (h.epoch !== live) {
      reached.staleToken!++;
      if (status !== 403)
        flag(
          "FD-CACHE-051",
          `epoch ${h.epoch}'s compile-cache token after ${ended()} answered ${status}`,
        );
      if (
        method === "PUT" &&
        h.write !== null &&
        (await bucket.head(compileObjectKey(h.write, name))) !== null
      )
        flag("FD-CACHE-051", `epoch ${h.epoch}'s stale token wrote ${name}`);
      return;
    }
    reached.currentToken!++;
    if (status === 403)
      flag("FD-CACHE-051", `the current epoch ${h.epoch}'s compile-cache token was refused`);
  };

  /**
   * The control plane revokes the lease: the placement goes, so the lease answers no epoch. The revoked holder at once
   * asks for a URL, uses its token, commits a manifest and an artifact, and every one is refused.
   */
  const revoke = async (step: number) => {
    const revoked = holders.find((h) => h.epoch === live);
    if (revoked === undefined) return;
    w.leases.delete(executionId);
    live = null;
    reached.revokes!++;
    trace.push(`revoke ${revoked.epoch}`);
    await endWorkspace(revoked);
    await put(revoked, step);
    await compile(revoked, step);
    await commit(revoked);
    await commitArtifactOf(revoked);
  };

  const play = async () => {
    await reclaim();
    const steps = 14 + Math.floor(random() * 10);
    for (let step = 1; step <= steps; step++) {
      w.now += Math.floor(random() * 6 * MINUTE);
      const roll = random();
      if (roll < 0.15 && holders.length < 6) {
        await reclaim();
        continue;
      }
      if (roll < 0.2 && live !== null) {
        await revoke(step);
        continue;
      }
      // After a reclaim an executor of an earlier epoch keeps acting about half the time; after a revoke every
      // executor's epoch is an earlier one.
      const current = holders.find((x) => x.epoch === live);
      const earlier = holders.filter((x) => x !== current);
      const h =
        current === undefined || (earlier.length > 0 && random() < 0.5) ? pick(earlier) : current;
      if (roll < 0.45) await put(h, step);
      else if (roll < 0.55) await commit(h);
      else if (roll < 0.63) await beginArtifact(h, step);
      else if (roll < 0.71) await commitArtifactOf(h);
      else if (roll < 0.83) await transfer();
      else await compile(h, step);
    }
  };

  try {
    await play();
  } finally {
    for (const h of holders)
      if (h.workspace.fate !== "stopped")
        await Effect.runPromise(Scope.close(h.workspace.scope, Exit.void));
    await rm(hostsRoot, { recursive: true, force: true });
    artifactDb.close();
  }
  return { violations, reached, trace };
};

/**
 * Up to eight entries committed over the first 20 days and read at seeded times through `exec.presign`, which
 * refreshes `last_read_at`, while the cache sweep ticks every 6 to 30 hours for 40 days. Some ticks land exactly on,
 * or 1 ms past, an entry's TTL. Before each tick the scenario reads every entry's `last_read_at`, and after it checks
 * that the sweep deleted exactly the entries whose `last_read_at` is older than the TTL, each with all its objects.
 */
export const simulateSweep = async (
  seed: number,
  signer: ManifestSignerService,
): Promise<SimOutcome> => {
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
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached: Record<string, number> = {
    expired: 0,
    kept: 0,
    refreshed: 0,
    boundary: 0,
    ticks: 0,
  };
  const flag = (message: string) =>
    violations.push({
      id: "FD-CACHE-062",
      message: `seed ${seed} at +${w.now - START} ms: ${message}`,
    });
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
      commitCacheManifest({
        execution_id: writer,
        epoch: 1,
        manifest: { key, namespace, objects },
      }).pipe(provide),
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
    trace.push(
      `read ${entries.indexOf(e)} ${Exit.isSuccess(exit) ? "signed" : "refused"} ${after - START}`,
    );
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
      const objects = await Promise.all(
        e.objects.map(async (p) => (await bucket.head(p)) !== null),
      );
      if (expired) {
        if (manifest || objects.some(Boolean))
          flag(
            `entry ${e.key.slice(0, 8)} last read ${age} ms ago, past the ${ttlMs} ms TTL, was not deleted whole`,
          );
        else reached.expired!++;
        e.gone = true;
      } else if (!manifest || objects.some((o) => !o)) {
        flag(
          `entry ${e.key.slice(0, 8)} last read ${age} ms ago, within the ${ttlMs} ms TTL, lost its manifest or an object`,
        );
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

/** The scenarios the `sim` job runs, 100 seeds each on a pull request and 10,000 nightly (FD-VER-024). */
export const scenarios: readonly SimScenario[] = [
  {
    name: "reclaim",
    ids: ["FD-CACHE-051", "FD-CACHE-040", "FD-CACHE-071", "FD-CACHE-002", "FD-CACHE-003"],
    run: async (seed) =>
      throwOnViolations((await simulateReclaim(seed, await signerOnce())).violations),
  },
  {
    name: "sweep",
    ids: ["FD-CACHE-062"],
    run: async (seed) =>
      throwOnViolations((await simulateSweep(seed, await signerOnce())).violations),
  },
];
