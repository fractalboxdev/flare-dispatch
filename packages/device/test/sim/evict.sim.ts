// The device extension's V-SIM scenario for L1 eviction under the free-disk floor (specs/verification.md § V-SIM).
// A seed fixes a workload of `cache.put` and `cache.get` lines and the disk the device's other files use; whenever free
// disk falls below the floor, the scenario plays the device executor (MAMEKO-EXEC-123) and sends
// `cache.evict(floor - free)` over the extension interface, then checks the answer against L1's files on disk and a
// model of the read order. `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts).
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import { answerLine, type ExtensionState } from "../../src/extension.ts";
import { L1 } from "../../src/l1.ts";

/**
 * The simulated device's disk, scaled down so L1's files stay small: the floor plays the role of the 20 GiB default
 * and the disk that of the device's capacity. L1's cap stays above everything the workload writes, so only
 * `cache.evict` removes entries.
 */
export const DISK = {
  totalBytes: 96 * 1024,
  floorBytes: 24 * 1024,
  l1CapBytes: 1024 * 1024,
} as const;

const NAMESPACES = ["protected/acme/widgets/device", "pr/acme/widgets/7"] as const;

export interface EvictOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

/** The bytes of L1's files on disk, read from the directory rather than from L1's own count. */
const filesOnDisk = (root: string): Map<string, number> => {
  const files = new Map<string, number>();
  for (const dir of readdirSync(root))
    for (const file of readdirSync(join(root, dir)))
      files.set(`${decodeURIComponent(dir)}/${file}`, statSync(join(root, dir, file)).size);
  return files;
};

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** L1's file for a key: `<namespace>/<sha256(key)>`, as `filesOnDisk` names it. */
const fileOf = (namespace: string, key: string) =>
  `${namespace}/${createHash("sha256").update(key).digest("hex")}`;

export const simulateEviction = (seed: number): EvictOutcome => {
  const random = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  const root = mkdtempSync(join(tmpdir(), "fd-l1-sim-"));
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached: Record<string, number> = { evictions: 0, partial: 0, emptied: 0 };
  try {
    const state: ExtensionState = {
      planeId: "plane-sim",
      l1: new L1(root, DISK.l1CapBytes),
      content: new Map(),
      readable: new Set(),
      writable: new Set(),
    };
    let id = 0;
    const send = (message: Record<string, unknown>) =>
      answerLine(state, JSON.stringify({ id: String(++id), ...message })) as Record<
        string,
        unknown
      > | null;
    send({
      type: "proxies",
      lease: {
        execution_id: "exec-1",
        cache_namespaces: { read: [...NAMESPACES], write: NAMESPACES[0] },
      },
    });
    send({
      type: "proxies",
      lease: {
        execution_id: "exec-2",
        cache_namespaces: { read: [...NAMESPACES], write: NAMESPACES[1] },
      },
    });
    /** Entries from least to most recently read; a put counts as a read, as L1 records it. */
    let order: { namespace: string; key: string; file: string }[] = [];
    let otherBytes = Math.floor(random() * DISK.totalBytes * 0.5);
    const steps = 40 + Math.floor(random() * 40);
    for (let step = 1; step <= steps; step++) {
      // The device's other files grow and shrink.
      otherBytes = Math.max(
        0,
        Math.min(DISK.totalBytes, otherBytes + Math.floor((random() - 0.45) * 8 * 1024)),
      );
      const roll = random();
      if (roll < 0.6) {
        const namespace = pick(NAMESPACES);
        const key = `k-${Math.floor(random() * 30)}`;
        const bytes = new Uint8Array(1 + Math.floor(random() * 3 * 1024)).fill(step % 251);
        const reply = send({ type: "cache.put", namespace, key, bytes: b64(bytes) });
        trace.push(`put ${namespace} ${key} ${bytes.byteLength} ${String(reply?.type)}`);
        order = order.filter((e) => !(e.namespace === namespace && e.key === key));
        order.push({ namespace, key, file: fileOf(namespace, key) });
      } else if (order.length > 0) {
        const e = pick(order);
        const reply = send({ type: "cache.get", namespace: e.namespace, key: e.key });
        trace.push(`get ${e.namespace} ${e.key} ${reply?.bytes === null ? "miss" : "hit"}`);
        if (reply?.bytes !== null) order = [...order.filter((o) => o !== e), e];
      }
      const before = filesOnDisk(root);
      const used = [...before.values()].reduce((s, n) => s + n, 0);
      const free = DISK.totalBytes - otherBytes - used;
      if (free >= DISK.floorBytes) continue;
      const target = DISK.floorBytes - free;
      const reply = send({ type: "cache.evict", target_bytes: target });
      const after = filesOnDisk(root);
      const freedOnDisk = used - [...after.values()].reduce((s, n) => s + n, 0);
      const freed = reply?.freed_bytes;
      reached.evictions!++;
      trace.push(`evict ${target} ${String(freed)}`);
      const flag = (message: string) =>
        violations.push({ id: "FD-CACHE-010", message: `seed ${seed} step ${step}: ${message}` });
      if (reply?.type !== "cache.evict.ok") {
        flag(`cache.evict answered ${String(reply?.type)}`);
        continue;
      }
      if (freed !== freedOnDisk)
        flag(`cache.evict answered ${String(freed)} freed, but ${freedOnDisk} bytes left the disk`);
      if (after.size === 0 && target > used) reached.emptied!++;
      else if (after.size > 0) reached.partial!++;
      if (freedOnDisk < target && after.size > 0)
        flag(`freed ${freedOnDisk} of ${target} bytes and stopped with ${after.size} entries left`);
      const evicted = order.filter((e) => !after.has(e.file));
      const kept = order.filter((e) => after.has(e.file));
      // Least recently read first: every evicted entry precedes every kept one in the read order.
      if (
        evicted.length > 0 &&
        kept.length > 0 &&
        order.indexOf(evicted.at(-1)!) > order.indexOf(kept[0]!)
      )
        flag(`evicted ${evicted.at(-1)!.key} while the less recently read ${kept[0]!.key} stayed`);
      // It stops once the target is freed: without the last entry it evicted, it would have fallen short.
      const last = evicted.at(-1);
      if (last !== undefined && freedOnDisk - before.get(last.file)! >= target)
        flag(
          `evicted ${last.key} after ${freedOnDisk - before.get(last.file)!} of ${target} bytes were already freed`,
        );
      order = kept;
    }
    return { violations, reached, trace };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

/** The scenario the `sim` job runs, 100 seeds on a pull request and 10,000 nightly (FD-VER-024). */
export const scenarios: readonly SimScenario[] = [
  {
    name: "evict",
    ids: ["FD-CACHE-010"],
    run: async (seed) => throwOnViolations(simulateEviction(seed).violations),
  },
];
