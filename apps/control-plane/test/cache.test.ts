import {
  cacheNamespaces,
  compileObjectKey,
  logObjectName,
  executionNamespace,
  manifestPath,
  memoryLedgers,
  objectPrefix,
  protectedCloud,
  pullRequestNamespace,
  type CacheLedgerApi,
} from "@fractalboxdev/flare-dispatch-cache";
import {
  d1IntakeStore,
  IntakeStore,
  type IntakeRecord,
} from "@fractalboxdev/flare-dispatch-intake";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CacheReads, cacheReads, type CacheEnv } from "../src/cache.ts";
import {
  cacheSweeps,
  LEDGER_END_BATCH,
  migrateCache,
  NEWLY_TERMINAL,
} from "../src/cache-retention.ts";
import { cacheExecutionOf, leaseCacheAt } from "../src/cache-execution.ts";
import type { ControlPlaneEnv } from "../src/config.ts";

const record = (cacheTrigger: IntakeRecord["cacheTrigger"]): IntakeRecord => ({
  executionId: "e-1",
  trigger: "webhook",
  run: "check",
  label: null,
  repo: "Acme/App",
  sha: "a".repeat(40),
  ref: "refs/heads/main",
  inputs: {},
  className: "required",
  labels: [],
  attempt: 1,
  familyRoot: "e-1",
  installation: null,
  caller: null,
  notBefore: null,
  spendLine: null,
  placementConstraint: null,
  cacheTrigger,
  eligibleKinds: null,
  repositoryPublic: null,
  inputAssociations: [],
  createdAt: 0,
});

describe("the cache execution of an intake record", () => {
  it("[FD-CACHE-019] a pull request's execution writes its own pr/<repo>/<number> namespace", () => {
    const pr = cacheExecutionOf(record({ _tag: "PullRequest", number: 41 }));
    for (const kind of ["cloudflare", "aws", "device"] as const)
      expect(cacheNamespaces(pr, kind).write).toBe(pullRequestNamespace("acme/app", 41));
    // FD-CACHE-021: on `gha` the execution writes its own execution namespace.
    expect(cacheNamespaces(pr, "gha").write).toBe(executionNamespace("acme/app", "e-1"));
  });

  it("[FD-CACHE-017] a push to the default branch writes the protected-cloud tier on a cloud executor", () => {
    const push = cacheExecutionOf(
      record({ _tag: "Push", ref: "refs/heads/main", protected: true }),
    );
    expect(cacheNamespaces(push, "cloudflare").write).toBe(protectedCloud("acme/app"));
    const other = cacheExecutionOf(record({ _tag: "Other" }));
    expect(cacheNamespaces(other, "cloudflare").write).toBeNull();
  });
});

/** A development deployment whose captured repository, `Acme/App`, has the given confidentiality mode. */
const developmentOf = (confidentiality: string) => ({
  DEPLOYMENT: "development",
  FD_DEV_REPOSITORY: JSON.stringify({
    repository: "Acme/App",
    installation: 1,
    default_branch: "main",
    head: "a".repeat(40),
    files: {},
    confidentiality,
  }),
});

describe("a lease's cache fields under the repository's confidentiality mode", () => {
  const leaseOn = (confidentiality: string) =>
    leaseCacheAt(
      {
        PUBLIC_ORIGIN: "https://cp.example",
        COMPILE_CACHE_SECRET: "secret",
        ...developmentOf(confidentiality),
      },
      record({ _tag: "PullRequest", number: 41 }),
      { epoch: 1, kind: "device" },
      1_900_000_000_000,
    );

  it("[FD-CACHE-008] a confidential-compute repository's lease names no L2 namespace and carries no compile-cache token", async () => {
    const confidential = await leaseOn("confidential-compute");
    expect(confidential.cache_namespaces).toEqual({ read: [], write: null });
    expect(confidential.upload_grant.cache_prefix).toBeNull();
    expect(confidential.upload_grant.compile_cache).toBeNull();
    // The same execution on a repository of any other mode reads and writes L2.
    for (const mode of ["non-confidential", "unclassified", "confidential-model"]) {
      const open = await leaseOn(mode);
      expect(open.cache_namespaces.write).toBe(pullRequestNamespace("acme/app", 41));
      expect(open.upload_grant.compile_cache?.token).toMatch(/^cc3\./);
    }
  });
});

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

/**
 * A bucket over a map: the `list` and `delete` the log sweep calls, the `head`, `get` and key-ordered `list` the cache
 * sweep calls, and `put` to seed it. Every object is uploaded at `NOW`.
 */
const memoryBucket = () => {
  const objects = new Map<string, { body: string; customMetadata: Record<string, string> }>();
  const head = (key: string) => {
    const o = objects.get(key);
    return o === undefined
      ? null
      : { key, size: o.body.length, uploaded: new Date(NOW), customMetadata: o.customMetadata };
  };
  return {
    objects,
    put: async (
      key: string,
      body: string,
      options: { customMetadata?: Record<string, string> } = {},
    ) => void objects.set(key, { body, customMetadata: options.customMetadata ?? {} }),
    head: async (key: string) => head(key),
    get: async (key: string) => {
      const o = head(key);
      return o === null ? null : { ...o, text: async () => objects.get(key)!.body };
    },
    list: async ({ prefix, startAfter }: { prefix?: string; startAfter?: string }) => ({
      objects: [...objects.keys()]
        .filter((k) => k.startsWith(prefix ?? "") && (startAfter === undefined || k > startAfter))
        .sort()
        .map((key) => head(key)!),
      truncated: false,
    }),
    delete: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
};

/** The control plane's D1 with an execution per id, recorded by intake under `acme/app`. */
const plane = async (deploy: Partial<ControlPlaneEnv> = {}) => {
  const db = await migratedD1();
  const ledgers = memoryLedgers();
  const ends: string[] = [];
  let failNextEnd = false;
  const failing = new Set<string>();
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string): CacheLedgerApi => {
      const ledger = ledgers(id);
      return {
        ...ledger,
        end: async (request) => {
          if (failNextEnd || failing.has(request.executionId)) {
            failNextEnd = false;
            throw new Error("ledger unreachable");
          }
          ends.push(request.executionId);
          return ledger.end(request);
        },
      };
    },
  };
  const bucket = memoryBucket();
  const env = {
    DB: db,
    CACHE: bucket,
    CACHE_LEDGER: namespace,
    ...deploy,
  } as unknown as ControlPlaneEnv & CacheEnv;
  const execution = async (id: string, status: string, finishedAt: number | null) => {
    await db
      .prepare(
        `insert into executions (id, scope_id, run, class, status, enqueued_at, deadline_at, finished_at)
         values (?, 'acme/app', 'check', 'required', ?, ?, ?, ?)`,
      )
      .bind(id, status, NOW - 40 * DAY, NOW + DAY, finishedAt)
      .run();
    await db
      .prepare(
        `insert into intake_records (execution_id, trigger, run, repo, sha, ref, inputs_json, class, labels_json,
           attempt, family_root, created_at)
         values (?, 'webhook', 'check', 'Acme/App', ?, 'refs/heads/main', '{}', 'required', '[]', 1, ?, ?)`,
      )
      .bind(id, "a".repeat(40), id, NOW - 40 * DAY)
      .run();
  };
  const step = (name: string, now = NOW) => {
    const found = cacheSweeps(env)(now).find((s) => s.step === name);
    if (found === undefined) throw new Error(`no ${name} step`);
    return Effect.runPromise(found.effect);
  };
  return {
    env,
    db,
    bucket,
    ends,
    ledger: ledgers("acme/app"),
    failNextEnd: () => void (failNextEnd = true),
    failing,
    execution,
    step,
  };
};

const reserve = (executionId: string, bytes: number) => ({
  executionId,
  bytes,
  expiresAt: NOW + DAY,
});

describe("the cache's minute-tick steps", () => {
  it("[FD-CACHE-055] the tick releases a newly terminal execution's unused reservations and its ledger refuses later ones", async () => {
    const p = await plane();
    await p.execution("e-done", "running", null);
    await p.execution("e-live", "running", null);
    await p.ledger.reserve(reserve("e-done", 300));
    await p.ledger.commit({ executionId: "e-done", bytes: 100 });
    await p.ledger.reserve(reserve("e-live", 50));
    // Neither execution is terminal: the step ends no ledger record.
    expect(await p.step("ledger-end")).toEqual({ ended: 0, failed: 0 });
    expect(await p.ledger.usage()).toEqual({ stored: 100, pending: 250 });

    await p.db
      .prepare("update executions set status = 'success', finished_at = ? where id = 'e-done'")
      .bind(NOW - 60_000)
      .run();
    expect(await p.step("ledger-end")).toEqual({ ended: 1, failed: 0 });
    // The 200 unused bytes of e-done are released; e-live's reservation stays.
    expect(await p.ledger.usage()).toEqual({ stored: 100, pending: 50 });
    expect(await p.ledger.reserve(reserve("e-done", 1))).toMatchObject({
      ok: false,
      reason: "ended",
    });
    expect((await p.ledger.reserve(reserve("e-live", 1))).ok).toBe(true);

    // A later pass calls no ledger again for an execution it already ended.
    expect(await p.step("ledger-end", NOW + 60_000)).toEqual({ ended: 0, failed: 0 });
    expect(p.ends).toEqual(["e-done"]);
  });

  it("[FD-CACHE-055] a ledger call that fails is retried on the next pass", async () => {
    const p = await plane();
    await p.execution("e-cancelled", "cancelled", NOW - 1000);
    await p.ledger.reserve(reserve("e-cancelled", 70));
    p.failNextEnd();
    expect(await p.step("ledger-end")).toEqual({ ended: 0, failed: 1 });
    expect(await p.ledger.usage()).toEqual({ stored: 0, pending: 70 });
    expect(await p.step("ledger-end", NOW + 60_000)).toEqual({ ended: 1, failed: 0 });
    expect(await p.ledger.usage()).toEqual({ stored: 0, pending: 0 });
  });

  it("[FD-CACHE-055] executions whose ledger call keeps failing wait behind every execution not yet tried", async () => {
    const p = await plane();
    for (let i = 0; i < LEDGER_END_BATCH; i++) {
      const id = `e-stuck-${String(i).padStart(3, "0")}`;
      await p.execution(id, "failure", NOW - 10_000 + i);
      p.failing.add(id);
    }
    await p.execution("e-new", "success", NOW - 1000);
    // The oldest ends fill the first batch and all fail; e-new is past the batch.
    expect(await p.step("ledger-end")).toEqual({ ended: 0, failed: LEDGER_END_BATCH });
    // The next pass tries e-new before any execution that already failed.
    expect(await p.step("ledger-end", NOW + 60_000)).toEqual({
      ended: 1,
      failed: LEDGER_END_BATCH - 1,
    });
    expect(p.ends).toEqual(["e-new"]);
  });

  it("[FD-CACHE-055] the ledger-end select seeks executions by finished_at rather than scanning them", async () => {
    const db = await migratedD1();
    await migrateCache(db);
    const plan = (
      db.sqlite.prepare(`explain query plan ${NEWLY_TERMINAL}`).all(0) as { detail: string }[]
    ).map((row) => row.detail);
    expect(plan).toContain("SEARCH e USING INDEX cache_ledger_end_finished (finished_at>?)");
    expect(plan.filter((detail) => detail.startsWith("SCAN"))).toEqual([]);
  });

  it("[FD-CACHE-064] the cache sweep deletes a pull request's namespace 24 h after intake recorded its close", async () => {
    const p = await plane();
    const key = "0".repeat(64);
    /** A committed entry in pull request `number`'s namespace, read just now. */
    const entry = async (number: number) => {
      const namespace = pullRequestNamespace("acme/app", number);
      const path = `${objectPrefix(namespace, key, "e-1", 1)}obj`;
      await p.bucket.put(path, "x");
      await p.bucket.put(
        manifestPath(namespace, key),
        JSON.stringify({ key, namespace, objects: [{ path, size: 1, sha256: key }] }),
        { customMetadata: { last_read_at: String(NOW) } },
      );
      return path;
    };
    const [open, recent, closed] = [await entry(41), await entry(42), await entry(43)];
    const compile = compileObjectKey(pullRequestNamespace("acme/app", 43), "cc");
    await p.bucket.put(compile, "y");
    const close = (number: number, at: number) =>
      Effect.runPromise(
        IntakeStore.use((s) => s.pullRequestClosed("Acme/App", number, at)).pipe(
          Effect.provide(d1IntakeStore(p.db)),
        ),
      );
    await close(42, NOW - 23 * 3600 * 1000);
    await close(43, NOW - 25 * 3600 * 1000);

    expect(await p.step("cache-sweep")).toMatchObject({ closedPullRequests: 2 });
    const left = [...p.bucket.objects.keys()];
    expect(left).toContain(open);
    expect(left).toContain(recent);
    expect(left).not.toContain(closed);
    expect(left).not.toContain(manifestPath(pullRequestNamespace("acme/app", 43), key));
    expect(left).not.toContain(compile);
  });

  it("[FD-CACHE-089] the log sweep deletes an execution's logs 30 days after its finished_at, with no reservation", async () => {
    const p = await plane();
    await p.execution("e-old", "failure", NOW - 31 * DAY);
    await p.execution("e-recent", "success", NOW - 29 * DAY);
    await p.execution("e-running", "running", null);
    const log = (id: string) => `logs/${id}/1/${"0".repeat(24)}/stdout-0-1.ndjson`;
    for (const id of ["e-old", "e-recent", "e-running"]) await p.bucket.put(log(id), "{}");

    expect(await p.step("log-sweep")).toMatchObject({ deleted: 1 });
    expect([...p.bucket.objects.keys()].sort()).toEqual([log("e-recent"), log("e-running")]);
    expect(await p.step("log-sweep", NOW + 2 * DAY)).toMatchObject({ deleted: 1 });
    expect([...p.bucket.objects.keys()]).toEqual([log("e-running")]);
  });
});

describe("the log route under the repository's confidentiality mode", () => {
  /** Reads an execution's aggregate logs through the router's `CacheReads`, after its executor wrote one segment. */
  const readLogs = async (confidentiality: string, format: string) => {
    const p = await plane(developmentOf(confidentiality) as Partial<ControlPlaneEnv>);
    await p.execution("e-logs", "success", NOW);
    await p.db
      .prepare(
        "insert into placements (execution_id, state, epoch, executor_id) values ('e-logs', 'accepted', 1, 'dev-7')",
      )
      .run();
    const name = await logObjectName({
      executionId: "e-logs",
      epoch: 1,
      journalName: "step:build",
      stream: "stdout",
      start: 0,
      end: 1,
    });
    await p.bucket.put(name!, `${JSON.stringify({ line: "the build's private output" })}\n`, {
      customMetadata: { executor_id: "dev-7", executor_kind: "device" },
    });
    const response = await Effect.runPromise(
      CacheReads.use((reads) =>
        reads.logs(
          new Request(`http://x/v1/executions/e-logs/logs?format=${format}`),
          "e-logs",
          undefined,
        ),
      ).pipe(Effect.provide(cacheReads(p.env))),
    );
    return response.text();
  };

  it("[FD-CACHE-088] a confidential-compute repository's log viewer shows the executor and execution as a pointer and fetches no log content", async () => {
    for (const format of ["html", "ndjson", "text"]) {
      const body = await readLogs("confidential-compute", format);
      expect(body).toContain('"executionId":"e-logs"');
      expect(body).toContain('"executorId":"dev-7"');
      expect(body).not.toContain("private output");
    }
    // A repository of any other mode reads the segment the executor wrote.
    expect(await readLogs("non-confidential", "text")).toBe("the build's private output");
  });
});
