// The deploy suite of `V-DEPLOY` (specs/verification.md § Harness catalog) for the cache sweep's cadence and bound
// (specs/cache-artifacts.md § Retention and sweeps): the committed control-plane template rendered from the
// placeholder overlay arms a cron that fires at least once per hour, and the Worker's scheduled handler on that cron
// runs the cache sweep over the `CACHE` bucket, listing at most 500 pages of 1000 objects and resuming from the key it
// persists between runs.
import { memoryLedgers, SWEEP_STATE_KEY } from "@fractalboxdev/flare-dispatch-cache";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { parseJsonc, placeholderOverlay, renderTemplate } from "@fractalboxdev/flare-dispatch-ops";
import { repositoryRoot, V2_WORKERS } from "@fractalboxdev/flare-dispatch-ops/cli";
import { Effect } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneEnv } from "../../src/config.ts";
import worker from "../../src/worker.ts";

const ROOT = repositoryRoot(import.meta.dirname);
const CONTROL_PLANE = V2_WORKERS.find((w) => w.worker === "control-plane")!;
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

/** The minutes of an hour a cron field names: `*`, `*\/n`, `a-b`, `a-b/n`, a number, or a comma list of them. */
const minutesOf = (field: string): ReadonlySet<number> => {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/") as [string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    const [lo, hi] =
      range === "*"
        ? [0, 59]
        : range.includes("-")
          ? range.split("-").map(Number)
          : [Number(range), Number(range)];
    if (![step, lo, hi].every(Number.isInteger) || step < 1) continue;
    for (let m = lo!; m <= hi! && m <= 59; m += step) out.add(m);
  }
  return out;
};

/** A five-field cron fires at least once in every hour: it names a minute, and every hour of every day. */
const firesEveryHour = (cron: string) => {
  const fields = cron.trim().split(/\s+/);
  return (
    fields.length === 5 && minutesOf(fields[0]!).size > 0 && fields.slice(1).every((f) => f === "*")
  );
};

/**
 * A `CACHE` bucket whose `cache/` prefix holds more than one run can list: every listing there answers 1000 fresh
 * objects, one cache entry each, and a cursor to the next page. Every other prefix, which the artifact and log sweeps
 * read, is empty. It records each `cache/` listing's options and keeps the sweep's state object.
 */
const endlessBucket = () => {
  const lists: { prefix?: string; limit?: number; cursor?: string; startAfter?: string }[] = [];
  const state = new Map<string, { customMetadata: Record<string, string> }>();
  let n = 0;
  const bucket = {
    lists,
    head: async (key: string) => state.get(key) ?? null,
    get: async () => null,
    put: async (
      key: string,
      _body: string,
      options: { customMetadata?: Record<string, string> } = {},
    ) => void state.set(key, { customMetadata: options.customMetadata ?? {} }),
    delete: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) state.delete(k);
    },
    list: async (options: {
      prefix?: string;
      limit?: number;
      cursor?: string;
      startAfter?: string;
    }) => {
      if (options.prefix !== "cache/") return { objects: [], truncated: false };
      lists.push({ ...options });
      const objects = Array.from({ length: options.limit ?? 1000 }, () => ({
        key: `${options.prefix ?? ""}protected/acme/app/cloud/k${String(++n).padStart(9, "0")}/blob`,
        size: 1,
        uploaded: new Date(NOW),
        customMetadata: {},
      }));
      return { objects, truncated: true, cursor: `page-${lists.length}` };
    },
  };
  return bucket;
};

/** The control plane's env for one scheduled run: its D1, the liveness monitor, the cache bucket and its ledgers. */
const envWith = async (bucket: ReturnType<typeof endlessBucket>) => {
  const ledgers = memoryLedgers();
  return {
    PLANE_ID: "flare-dispatch",
    DEPLOYMENT: "production",
    DB: await migratedD1(),
    MONITOR: { idFromName: (name: string) => name, get: () => ({ start: async () => undefined }) },
    CACHE: bucket,
    CACHE_LEDGER: { idFromName: (name: string) => name, get: (id: string) => ledgers(id) },
  } as unknown as ControlPlaneEnv;
};

/** Runs the Worker's scheduled handler once on `cron` at `at` and waits for every promise it hands `waitUntil`. */
const scheduled = async (env: ControlPlaneEnv, cron: string, at: number) => {
  const pending: Promise<unknown>[] = [];
  const failures: string[] = [];
  const log = vi
    .spyOn(console, "error")
    .mockImplementation((...args) => void failures.push(args.map(String).join(" ")));
  try {
    worker.scheduled({ cron, scheduledTime: at } as unknown as ScheduledController, env, {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
    } as unknown as ExecutionContext);
    await Promise.all(pending);
  } finally {
    log.mockRestore();
  }
  return failures;
};

describe("the cache sweep on the deployed control plane", () => {
  it("[FD-CACHE-067] the rendered template's cron fires at least hourly, and its scheduled run lists at most 500 pages of 1000 objects and resumes from the key it persists", async () => {
    const config = parseJsonc(
      await Effect.runPromise(
        renderTemplate(
          "control-plane",
          readFileSync(join(ROOT, CONTROL_PLANE.templatePath), "utf8"),
          placeholderOverlay,
        ),
      ),
    );
    const crons = ((config["triggers"] as { crons?: string[] } | undefined)?.crons ?? []).filter(
      firesEveryHour,
    );
    expect(crons.length).toBeGreaterThan(0);
    const cron = crons[0]!;

    const bucket = endlessBucket();
    const env = await envWith(bucket);

    const first = await scheduled(env, cron, NOW);
    expect(first.filter((f) => f.includes("cache-sweep"))).toEqual([]);
    expect(bucket.lists).toHaveLength(500);
    expect(bucket.lists.every((l) => l.limit === 1000)).toBe(true);
    // The run starts from the beginning and then follows the listing's cursor.
    expect(bucket.lists[0]).not.toHaveProperty("startAfter");
    expect(bucket.lists[0]).not.toHaveProperty("cursor");
    expect(bucket.lists[1]).toMatchObject({ cursor: "page-1" });
    const persisted = (await bucket.head(SWEEP_STATE_KEY))?.customMetadata;
    expect(persisted?.["start_after"]).toMatch(
      /^cache\/protected\/acme\/app\/cloud\/k\d{9}\/blob$/,
    );

    // The next run resumes after the persisted key, and again stops at the page bound.
    const second = await scheduled(env, cron, NOW + 60_000);
    expect(second.filter((f) => f.includes("cache-sweep"))).toEqual([]);
    expect(bucket.lists).toHaveLength(1000);
    expect(bucket.lists[500]).toMatchObject({
      prefix: "cache/",
      startAfter: persisted!["start_after"],
    });
    expect(bucket.lists[500]).not.toHaveProperty("cursor");
    expect((await bucket.head(SWEEP_STATE_KEY))?.customMetadata["start_after"]).not.toBe(
      persisted!["start_after"],
    );
  }, 120_000);
});
