import {
  cacheNamespaces,
  executionNamespace,
  memoryLedgers,
  protectedCloud,
  pullRequestNamespace,
  type CacheLedgerApi,
} from "@fractalboxdev/flare-dispatch-cache";
import type { IntakeRecord } from "@fractalboxdev/flare-dispatch-intake";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { CacheEnv } from "../src/cache.ts";
import { cacheSweeps } from "../src/cache-retention.ts";
import { cacheExecutionOf } from "../src/cache-execution.ts";
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

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

/** A bucket over a map: the `list` and `delete` the log sweep calls, and `put` to seed it. */
const memoryBucket = () => {
  const objects = new Map<string, string>();
  return {
    objects,
    put: async (key: string, body: string) => void objects.set(key, body),
    list: async ({ prefix }: { prefix?: string }) => ({
      objects: [...objects.keys()].filter((k) => k.startsWith(prefix ?? "")).map((key) => ({ key })),
      truncated: false,
    }),
    delete: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
};

/** The control plane's D1 with an execution per id, recorded by intake under `acme/app`. */
const plane = async () => {
  const db = await migratedD1();
  const ledgers = memoryLedgers();
  const ends: string[] = [];
  let failNextEnd = false;
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string): CacheLedgerApi => {
      const ledger = ledgers(id);
      return {
        ...ledger,
        end: async (request) => {
          if (failNextEnd) {
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
    db,
    bucket,
    ends,
    ledger: ledgers("acme/app"),
    failNextEnd: () => void (failNextEnd = true),
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
    expect(await p.ledger.reserve(reserve("e-done", 1))).toMatchObject({ ok: false, reason: "ended" });
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
