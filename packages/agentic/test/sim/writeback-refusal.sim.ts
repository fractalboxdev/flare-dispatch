// The writeback-refusal scenario of the `sim` job (specs/verification.md § V-SIM): one execution concludes `success`
// with a staged write the gate rejects, and its `pr.propose` row drains through mameko's drainer over the control
// plane's D1 tables on a virtual clock. The seed fixes the manifest's defects, the artifact-store and GitHub faults
// before the gate answers, the D1 write failures under the drainer, and whether the artifact store stays down until
// the row expires. The observation is what the execution's dashboard page shows once the row is terminal;
// `checkSeed` asserts it and throws on a violation, as the `sim` job requires of each scenario.
import { drainOnce } from "@fractalboxdev/mameko-coordinator";
import {
  d1OutboxStore,
  insertOutboxRows,
  type D1Like,
} from "@fractalboxdev/mameko-host-cloudflare/d1";
import {
  newRow,
  step,
  EXPIRY_MS,
  CLAIM_TTL_MS,
  type OutboxRow,
} from "@fractalboxdev/mameko-kernel";
import {
  ActuatorRateLimit,
  Actuators,
  actuatorRegistry,
  OutboxStore,
  type IntentRow,
} from "@fractalboxdev/mameko-ports";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import { executionDetail, renderExecutionDetail } from "../../../ops/src/dashboard.ts";
import { sqliteDb } from "../../../ops/src/d1.test-support.ts";
import type { SimScenario } from "../../../ops/src/verification/harness.ts";
import { stagedWriteGate } from "../../src/staged-write/gate.ts";
import {
  refusalReason,
  type GateReason,
  type Manifest,
  type ManifestEntry,
  type WritebackSpec,
} from "../../src/staged-write/manifest.ts";
import {
  applyPrPropose,
  lookupPrPropose,
  StagedWriteReadFailed,
  WritebackRecords,
  type LoadedBlob,
} from "../../src/writeback/applier.ts";
import { BASE_SHA, fakeGitLayer, fakeRepo } from "../../src/writeback/fake-git.test-support.ts";

export const SCENARIO = "writeback-refusal";

const T0 = 1_800_000_000_000;
const EXECUTION = "x-sim";
const ROW_ID = "row-1";
const RUN = "spec-drift-pr";

/** A deterministic generator over 32-bit state (mulberry32): one seed fixes every draw. */
export const prng = (seed: number) => {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), chance: (p: number) => next() < p };
};

const enc = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const writeback: WritebackSpec = {
  branch: "flare-dispatch/spec-drift",
  baseBranch: "main",
  allowlist: ["specs/**"],
  allowSensitivePaths: false,
  allowWorkflows: false,
};

/** One file of the staged write, with the defect it carries, if any. */
interface StagedFile {
  readonly path: string;
  readonly mode: string;
  readonly text: string;
}

const CLEAN: readonly StagedFile[] = [
  { path: "specs/a.md", mode: "100644", text: "# A\n" },
  { path: "specs/b.md", mode: "100644", text: "# B\n" },
];

/** Files each carrying one defect the gate rejects: every one reaches a different reason kind. */
const DEFECTS: readonly StagedFile[] = [
  { path: "runs/x.ts", mode: "100644", text: "export {}\n" },
  { path: "src/app.ts", mode: "100644", text: "export {}\n" },
  { path: "specs/../etc/passwd", mode: "100644", text: "x\n" },
  { path: "specs/link.md", mode: "120000", text: "specs/a.md" },
  { path: ".github/workflows/ci.yml", mode: "100644", text: "on: push\n" },
  { path: "specs/package.json", mode: "100644", text: "{}\n" },
  { path: "specs/key.md", mode: "100644", text: "key AKIAABCDEFGHIJKLMNOP\n" },
  { path: "specs/link-out.md", mode: "100644", text: "see https://evil.example/x\n" },
];

/** What the seed fixes for one run of the scenario. */
export interface Plan {
  readonly files: readonly StagedFile[];
  readonly branch: string;
  /** Failed artifact-store reads before the store answers; Infinity keeps it down until the row expires. */
  readonly artifactOutages: number;
  /** GitHub answers 502 to the first base-commit read; a manifest with no line-scoped reason makes none. */
  readonly githubFault: boolean;
  /** The ordinals of outbox writes under the drainer whose D1 transaction fails. */
  readonly d1Faults: ReadonlySet<number>;
}

export const plan = (seed: number): Plan => {
  const r = prng(seed);
  const defects = DEFECTS.filter(() => r.chance(0.35));
  if (defects.length === 0) defects.push(DEFECTS[r.int(DEFECTS.length)]!);
  const files = [...CLEAN, ...defects];
  // Shuffle so the first reason kind varies with the seed.
  for (let i = files.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [files[i], files[j]] = [files[j]!, files[i]!];
  }
  const d1Faults = new Set<number>();
  for (let i = 0; i < 6; i++) if (r.chance(0.15)) d1Faults.add(i);
  return {
    files,
    branch: r.chance(0.25) ? "main" : writeback.branch,
    artifactOutages: r.chance(0.2) ? Number.POSITIVE_INFINITY : r.int(4),
    githubFault: r.chance(0.5),
    d1Faults,
  };
};

const manifestOf = (p: Plan): Manifest => ({
  branch: p.branch,
  baseBranch: "main",
  baseCommit: BASE_SHA,
  message: "docs(specs): reconcile",
  pr: { title: "Reconcile specs", body: "Drift found.", draft: true, labels: ["spec-drift"] },
  entries: p.files.map((f): ManifestEntry => ({
    path: f.path,
    mode: f.mode as ManifestEntry["mode"],
    digest: sha256(enc(f.text)),
  })),
});

const blobsOf = (p: Plan, entries: readonly ManifestEntry[]): LoadedBlob[] =>
  entries.flatMap((e) => {
    const f = p.files.find((x) => x.path === e.path);
    if (f === undefined) return [];
    const bytes = enc(f.text);
    return [{ path: f.path, digest: sha256(bytes), size: bytes.length, text: f.text, bytes }];
  });

/** The gate's reasons for the plan's manifest, from the gate alone: what the page must list. */
export const expectedReasons = (p: Plan): readonly GateReason[] => {
  const m = manifestOf(p);
  const verdict = stagedWriteGate(m, writeback, true, {
    blobs: blobsOf(p, m.entries),
    baseText: () => null,
    issuedCredentials: [],
    githubHost: "github.com",
  });
  return "reasons" in verdict ? verdict.reasons : [];
};

/** A D1 binding whose outbox writes fail at the planned ordinals, as a failed D1 transaction does. */
const faultyD1 = (db: D1Like, faults: ReadonlySet<number>) => {
  let writes = 0;
  const wrap = (sql: string, s: ReturnType<D1Like["prepare"]>): ReturnType<D1Like["prepare"]> => {
    const guard = <A>(f: () => Promise<A>) => {
      if (!/^\s*update outbox/i.test(sql)) return f();
      const ordinal = writes++;
      return faults.has(ordinal) ? Promise.reject(new Error("D1_ERROR: injected")) : f();
    };
    return {
      bind: (...values) => wrap(sql, s.bind(...values)),
      run: () => guard(() => s.run()),
      all: () => guard(() => s.all()),
    };
  };
  return { ...db, prepare: (sql: string) => wrap(sql, db.prepare(sql)) } as D1Like;
};

/** What the dashboard shows once the row is terminal, with what the run touched to get there. */
export interface Observation {
  readonly rowState: string;
  readonly lastError: string | null;
  readonly verdict: string;
  readonly page: string;
  readonly githubCalls: readonly string[];
  readonly endedAt: number;
}

/** Runs the scenario for one seed: drains the row on the virtual clock until it is terminal. */
export const runScenario = async (seed: number): Promise<Observation> => {
  const p = plan(seed);
  const r = prng(seed ^ 0x5eed);
  const t = await sqliteDb();
  try {
    await t.db
      .prepare(
        "insert into executions (id, scope_id, run, class, status, enqueued_at) values (?, 'acme/app', ?, 'batch', 'success', ?)",
      )
      .bind(EXECUTION, RUN, T0)
      .run();
    const intent: IntentRow = {
      executionId: EXECUTION,
      scopeId: "acme/app",
      intentKey: "cp:pr:propose",
      kind: "pr.propose",
      payload: {
        executionId: EXECUTION,
        run: RUN,
        repo: { owner: "acme", name: "app" },
        manifest: manifestOf(p),
      },
      payloadDigest: "d",
      effectClass: "adoptable",
      attempts: 0,
    };
    await insertOutboxRows(t.db, [
      {
        id: ROW_ID,
        limitKey: "7",
        tier: "effect",
        priority: 0,
        classRank: 3,
        drawsReserve: false,
        intent,
        row: newRow({ effectClass: "adoptable", insertedAt: T0 }),
      },
    ]);

    const repo = fakeRepo();
    // GitHub answers 502 to the first base-commit read, the one the gate makes for a line-scoped reason.
    if (p.githubFault) repo.failNext = { call: "fileAt", status: 502 };
    let artifactReads = 0;
    const records = Layer.succeed(WritebackRecords, {
      blobs: (_x, entries) =>
        Effect.suspend(() =>
          artifactReads++ < p.artifactOutages
            ? Effect.fail(new StagedWriteReadFailed({ source: "artifacts", detail: "unavailable" }))
            : Effect.succeed(blobsOf(p, entries)),
        ),
      modelCalls: () => Effect.succeed(true),
      issuedCredentials: () => Effect.succeed([]),
    });
    const git = fakeGitLayer(repo);
    const config = {
      writebackFor: (run: string) => (run === RUN ? { writeback, declaresModel: true } : undefined),
      appLogin: "flare-dispatch[bot]",
    };
    const services = Layer.merge(git, records);
    const application = Layer.mergeAll(
      Layer.succeed(
        Actuators,
        actuatorRegistry({
          prPropose: {
            apply: (row) => applyPrPropose(config)(row).pipe(Effect.provide(services)),
            lookup: (row) => lookupPrPropose(row).pipe(Effect.provide(git)),
          },
        }),
      ),
      Layer.succeed(ActuatorRateLimit, {
        acquire: () => Effect.succeed({ _tag: "granted" as const, permitId: "p" }),
        release: () => Effect.void,
      }),
    );
    const faulty = faultyD1(t.db, p.d1Faults);
    const store = <A>(f: (s: OutboxStore["Service"]) => Effect.Effect<A>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* f(yield* OutboxStore);
        }).pipe(Effect.provide(d1OutboxStore(t.db))),
      );
    const read = () => store((s) => s.get(ROW_ID));
    const terminal = (row: OutboxRow) =>
      ["applied", "voided", "refused", "expired"].includes(row.state);

    let now = T0;
    let row = (await read())!.row;
    while (!terminal(row)) {
      if (now - row.insertedAt >= EXPIRY_MS) {
        // The undelivered-intent expiry of MAMEKO-OUT-019, as the kernel's step fixes it.
        const expired = step(row, { _tag: "expire", now });
        await store((s) => s.compareAndSet(ROW_ID, row, expired.row));
      } else {
        // A pass a D1 failure ends is lost, as the minute tick logs it and runs again.
        await Effect.runPromise(
          drainOnce({
            now,
            token: () => `tok-${now}`,
            random: r.next,
            actuatorOf: { "pr.propose": "prPropose" },
          }).pipe(Effect.provide(Layer.merge(d1OutboxStore(faulty), application))),
        ).catch(() => undefined);
      }
      row = (await read())!.row;
      const due =
        row.state === "in_flight" ? (row.claimExpiresAt ?? now + CLAIM_TTL_MS) : row.nextAttemptAt;
      now = Math.min(
        Math.max(now + 60_000, due),
        Math.max(now + 60_000, row.insertedAt + EXPIRY_MS),
      );
    }

    const detail = await executionDetail(t.db, EXECUTION);
    return {
      rowState: row.state,
      lastError: row.lastError,
      verdict: detail!.execution.status,
      page: renderExecutionDetail(detail!, null),
      githubCalls: [...repo.calls],
      endedAt: now,
    };
  } finally {
    await t.dispose();
  }
};

/** The text of each list item in the page's reason lists, unescaped. */
const listed = (page: string) =>
  [...page.matchAll(/<li class="mono">([^<]*)<\/li>/g)].map((m) =>
    m[1]!
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&"),
  );

/** The GitHub calls that write; a refused row makes none. */
const WRITES = new Set([
  "createBlob",
  "createTree",
  "createCommit",
  "createRef",
  "updateRef",
  "createPull",
  "updatePull",
  "addLabels",
  "closePull",
]);

/** One reason as `refusalReason` lists it. */
const reasonText = (r: GateReason) => refusalReason([r]).split("; ")[1]!;

/** The paths a seed took through the faults, for a run over many seeds to show it reached each. */
export interface SeedOutcome {
  readonly rowState: string;
  /** A lookup follows only a claim whose answer a D1 failure lost. */
  readonly d1LostAnswer: boolean;
  /** A second base-commit read follows only a GitHub 502. */
  readonly github502: boolean;
}

/**
 * Runs one seed and asserts FD-AGT-018 on it, throwing on a violation: the row ends refused with every gate reason
 * (or expired under a permanent artifact-store outage), the page lists each reason, no GitHub write happens, and
 * the verdict stays success (MAMEKO-OUT-015).
 */
export const checkSeed = async (seed: number): Promise<SeedOutcome> => {
  const p = plan(seed);
  const reasons = expectedReasons(p);
  const o = await runScenario(seed);
  const at = `seed ${seed}`;
  assert.ok(reasons.length > 0, `${at}: the plan carries no defect the gate rejects`);
  assert.equal(o.verdict, "success", at);
  assert.deepEqual(
    o.githubCalls.filter((c) => WRITES.has(c)),
    [],
    at,
  );
  const outcome = {
    rowState: o.rowState,
    d1LostAnswer: o.githubCalls.includes("refSha"),
    github502: o.githubCalls.filter((c) => c === "fileAt").length > 1,
  };
  if (p.artifactOutages === Number.POSITIVE_INFINITY) {
    assert.equal(o.rowState, "expired", at);
    assert.equal(o.lastError, "writeback: read artifacts", at);
    assert.ok(
      o.page.includes('<td class="notify">expired</td>'),
      `${at}: page shows no expired row`,
    );
    assert.ok(
      o.page.includes('<span class="mono">writeback: read artifacts</span>'),
      `${at}: page shows no last error of the expired row`,
    );
    return outcome;
  }
  assert.equal(o.rowState, "refused", at);
  assert.equal(o.lastError, refusalReason(reasons), at);
  assert.ok(o.page.includes('<td class="notify">refused</td>'), `${at}: page shows no refused row`);
  assert.ok(
    o.page.includes(`writeback: ${reasons[0]!.kind}<ul`),
    `${at}: page shows no first reason kind ${reasons[0]!.kind}`,
  );
  assert.deepEqual(listed(o.page), reasons.map(reasonText), at);
  return outcome;
};

export const scenarios: readonly SimScenario[] = [
  {
    name: SCENARIO,
    ids: ["FD-AGT-018"],
    run: async (seed) => {
      await checkSeed(seed);
    },
  },
];
