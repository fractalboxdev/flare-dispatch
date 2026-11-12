// The control plane's local-work side for the local simulations and replays: mameko's D1 tables and the local store's
// over one in-memory SQLite database, FlareDispatch's registration port and `WritebackGate` port over it, a fake GitHub
// repository, and mameko's `onLocalWriteback` and outbox insert for the intents a `local.writeback` request carries.
// Every D1 statement that changes a row, every GitHub call and every outbox row inserted is recorded as an effect.
import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  insertOutboxRows,
  runD1Migrations,
  type D1Like,
  type D1Statement,
} from "@fractalboxdev/mameko-host-cloudflare/d1";
import { newRow, onLocalRegister, onLocalWriteback } from "@fractalboxdev/mameko-kernel";
import { LocalRegistration, WritebackGate, type IntentRow } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { LocalSubmit, localRegistrationLayer } from "../src/local/registration.ts";
import type { WritebackIntent, WritebackRequest } from "../src/local/run-context.ts";
import { LOCAL_STORE_MIGRATIONS, LocalStore, localStoreD1 } from "../src/local/store.ts";
import { CapacityUsage, writebackGateLayer } from "../src/local/writeback-gate.ts";
import type { Manifest, WritebackSpec } from "../src/staged-write/manifest.ts";
import { WritebackRecords, type LoadedBlob } from "../src/writeback/applier.ts";
import { BASE_SHA, fakeGitLayer, fakeRepo } from "../src/writeback/fake-git.test-support.ts";

export const RUN = "spec-drift-pr";
export const SCOPE = "acme/app";
export const LEASE = { leaseId: "L1", epoch: 1 } as const;

export const WRITEBACK: WritebackSpec = {
  branch: "flare-dispatch/spec-drift",
  baseBranch: "main",
  allowlist: ["specs/**"],
  allowSensitivePaths: false,
  allowWorkflows: false,
};

const enc = (text: string) => new TextEncoder().encode(text);
const sha256 = (text: string) => createHash("sha256").update(enc(text)).digest("hex");

/** The staged files every `pr.propose` of these scenarios carries; the gate accepts them. */
export const FILES: Readonly<Record<string, string>> = {
  "specs/a.md": "# A\n",
  "specs/b.md": "# B\n",
};

/** A device-signed draft pull request of `FILES` from the run's bot branch. */
export const MANIFEST: Manifest = {
  branch: WRITEBACK.branch,
  baseBranch: "main",
  baseCommit: BASE_SHA,
  message: "docs(specs): reconcile",
  pr: { title: "Reconcile specs", body: "Drift found.", draft: true, labels: ["device-signed"] },
  entries: Object.entries(FILES).map(([path, text]) => ({
    path,
    mode: "100644",
    digest: sha256(text),
  })),
};

/** One external effect, in the shape the `replay` job counts. */
export interface PlaneEffect {
  readonly kind: "github" | "d1" | "intent";
  readonly key: string;
}

/** A registration payload with the provenance fields `local.register` carries (MAMEKO-LOCAL-069). */
export const registrationPayload = (
  reuseKey: string,
  wants: { readonly reuse: boolean; readonly writeback: boolean },
) => ({
  treeHash: "t1",
  baseCommit: BASE_SHA,
  runDigest: "sha256:run",
  imageDigest: "sha256:img",
  platform: "darwin-arm64",
  inputsDigest: `sha256:in:${reuseKey}`,
  reuseKey,
  scopeId: SCOPE,
  executorId: "dev-1",
  repository: SCOPE,
  ref: "refs/heads/feature",
  inputs: { reuseKey },
  environmentNames: ["CI"],
  wants,
});

/**
 * Intake's local submit as the registration port sees it: `RUN` is the one catalogue run, and a submit keys on the
 * lease, run, tree hash and inputs digest, so a repeated one answers the execution it admitted first.
 */
const localSubmit = () => {
  const admitted = new Map<string, string>();
  return Layer.succeed(LocalSubmit, {
    submit: (lease, run, submission) =>
      Effect.sync(() => {
        if (run !== RUN) return { _tag: "rejected" } as const;
        const key = JSON.stringify([
          lease.leaseId,
          run,
          submission.treeHash,
          submission.inputsDigest,
        ]);
        const executionId = admitted.get(key) ?? `01J${String(admitted.size).padStart(23, "0")}`;
        admitted.set(key, executionId);
        return { _tag: "admitted", executionId } as const;
      }),
  });
};

/** The verb and table of a statement that writes, or null for a read. */
const writeOf = (sql: string): string | null => {
  const verb = /^\s*(insert|update|delete)\b/i.exec(sql)?.[1]?.toLowerCase();
  if (verb === undefined) return null;
  const table =
    verb === "update" ? /^\s*update\s+(\w+)/i.exec(sql) : /\b(?:into|from)\s+(\w+)/i.exec(sql);
  return `${verb} ${table?.[1] ?? "?"}`;
};

/** A D1 binding over one SQLite database that records each statement that changes a row. */
const recordingD1 = (sqlite: DatabaseSync, effects: PlaneEffect[], fail: { on: boolean }) => {
  const changes = () =>
    (sqlite.prepare("select total_changes() as n").get() as { n: number | bigint }).n;
  const statement = (sql: string, params: readonly unknown[] = []): D1Statement => {
    const exec = <A>(f: () => A): A => {
      const write = writeOf(sql);
      if (fail.on && write !== null) throw new Error("D1_ERROR: injected");
      const before = changes();
      const out = f();
      if (write !== null && changes() !== before)
        effects.push({ kind: "d1", key: `${write} ${JSON.stringify(params)}` });
      return out;
    };
    return {
      bind: (...values) => statement(sql, values),
      run: async () => exec(() => sqlite.prepare(sql).run(...(params as SQLInputValue[]))),
      all: async () => ({
        results: exec(() => sqlite.prepare(sql).all(...(params as SQLInputValue[]))) as unknown[],
      }),
    };
  };
  const db: D1Like = {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      sqlite.exec("begin");
      try {
        const out = [];
        for (const s of statements) out.push(await s.all());
        sqlite.exec("commit");
        return out;
      } catch (e) {
        sqlite.exec("rollback");
        throw e;
      }
    },
  };
  return db;
};

/** The `local.writeback.ack` the control plane answers for the gate's decision. */
export interface WritebackAck {
  readonly type: "local.writeback.ack";
  readonly status: "accepted" | "rejected";
}

export type RegisterAnswer =
  | { readonly type: "local.registered"; readonly execution_id: string; readonly nonce: string }
  | { readonly type: "local.registered"; readonly status: "lease_stale" | "rejected" };

/** The control plane's local-work side over one fresh database. */
export const localPlane = async (opts: { readonly rate?: number } = {}) => {
  const sqlite = new DatabaseSync(":memory:");
  const effects: PlaneEffect[] = [];
  const fail = { on: false };
  const db = recordingD1(sqlite, effects, fail);
  await runD1Migrations(db);
  for (const m of LOCAL_STORE_MIGRATIONS) for (const sql of m.sql) sqlite.exec(sql);
  effects.length = 0;

  const repo = fakeRepo();
  const store = localStoreD1(db);
  const records = Layer.succeed(WritebackRecords, {
    blobs: (_x, entries) =>
      Effect.succeed(
        entries.flatMap((e): LoadedBlob[] => {
          const text = FILES[e.path];
          if (text === undefined) return [];
          const bytes = enc(text);
          return [{ path: e.path, digest: sha256(text), size: bytes.length, text, bytes }];
        }),
      ),
    modelCalls: () => Effect.succeed(false),
    modelEntries: () => Effect.succeed([]),
    issuedCredentials: () => Effect.succeed([]),
  });
  const usage = Layer.succeed(CapacityUsage, { modelCalls: () => Effect.succeed(false) });
  const deps = Layer.mergeAll(store, records, usage, fakeGitLayer(repo));
  const registration = localRegistrationLayer.pipe(
    Layer.provide(Layer.merge(store, localSubmit())),
  );
  const gate = writebackGateLayer({
    writebackFor: (run: string) => (run === RUN ? WRITEBACK : undefined),
    ...(opts.rate === undefined ? {} : { rate: opts.rate }),
  }).pipe(Layer.provide(deps));

  const githubFrom = (at: number): PlaneEffect[] =>
    repo.calls.slice(at).map((call) => ({ kind: "github", key: call }));

  /**
   * `local.register` under the lease: mameko answers `lease_stale` for a lease that is not current and asks the
   * registration port otherwise (MAMEKO-PROTO-082).
   */
  const register = async (
    leaseCurrent: boolean,
    payload: unknown,
    run: string = RUN,
  ): Promise<RegisterAnswer> => {
    const answer = leaseCurrent
      ? await Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* LocalRegistration).register(LEASE, run, payload);
          }).pipe(Effect.provide(registration)),
        )
      : { _tag: "rejected" as const };
    return onLocalRegister({ leaseCurrent, registration: payload, provenance: null }, () =>
      answer._tag === "accepted"
        ? { _tag: "Accepted", executionId: answer.executionId, nonce: answer.nonce }
        : { _tag: "Rejected" },
    );
  };

  /** Records a registered execution's verdict, as `capacity.settle` reports it. */
  const conclude = (executionId: string, outcome: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* LocalStore).recordOutcome(executionId, outcome);
      }).pipe(Effect.provide(store)),
    );

  const rowOf = (executionId: string, i: WritebackIntent) => {
    const intent: IntentRow = {
      executionId,
      scopeId: SCOPE,
      intentKey: i.intent_key,
      kind: i.kind,
      payload: i.payload,
      payloadDigest: sha256(JSON.stringify(i.payload)),
      effectClass: "adoptable",
      attempts: 0,
    };
    return {
      id: `${executionId}/${i.intent_key}`,
      limitKey: "7",
      tier: "effect" as const,
      priority: 0,
      classRank: 3,
      drawsReserve: false,
      intent,
      row: newRow({ effectClass: "adoptable", insertedAt: 0 }),
    };
  };

  /** The intent keys the outbox holds for an execution. */
  const held = (executionId: string): ReadonlySet<string> =>
    new Set(
      (
        sqlite.prepare("select intent_key from outbox where execution_id = ?").all(executionId) as {
          intent_key: string;
        }[]
      ).map((r) => r.intent_key),
    );

  /**
   * The control plane receives one `local.writeback`: the `WritebackGate` port decides it, mameko's `onLocalWriteback`
   * answers the gate's decision for the request's intents, and mameko inserts the accepted intents as outbox rows of
   * the execution (MAMEKO-PROTO-083).
   */
  const receive = async (request: WritebackRequest): Promise<WritebackAck> => {
    const accepted = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* WritebackGate).decide(request.execution_id, request.intents);
      }).pipe(Effect.provide(gate)),
    );
    const out = onLocalWriteback(
      { executionId: request.execution_id, intents: request.intents },
      () => accepted,
    );
    if (out.insert !== null) {
      const before = held(request.execution_id);
      await insertOutboxRows(
        db,
        out.insert.intents.map((i) => rowOf(out.insert.executionId, i)),
      );
      for (const key of held(request.execution_id))
        if (!before.has(key))
          effects.push({ kind: "intent", key: `${request.execution_id}/${key}` });
    }
    return { type: "local.writeback.ack", status: out.status };
  };

  /** Every (execution id, intent key) the outbox holds, sorted. */
  const outbox = () =>
    (
      sqlite
        .prepare(
          "select execution_id, intent_key, kind from outbox order by execution_id, intent_key",
        )
        .all() as { execution_id: string; intent_key: string; kind: string }[]
    ).map((r) => ({ executionId: r.execution_id, intentKey: r.intent_key, kind: r.kind }));

  /** The registration records the local store holds, keyed by execution id. */
  const registrations = () =>
    new Map(
      (
        sqlite
          .prepare(
            "select execution_id, reuse_key, wants_reuse, wants_writeback from fd_local_registrations",
          )
          .all() as {
          execution_id: string;
          reuse_key: string;
          wants_reuse: number;
          wants_writeback: number;
        }[]
      ).map((r) => [
        r.execution_id,
        { reuseKey: r.reuse_key, reuse: r.wants_reuse === 1, writeback: r.wants_writeback === 1 },
      ]),
    );

  return {
    effects,
    fail,
    repo,
    githubFrom,
    register,
    conclude,
    receive,
    outbox,
    registrations,
    close: () => sqlite.close(),
  };
};

export type LocalPlane = Awaited<ReturnType<typeof localPlane>>;
