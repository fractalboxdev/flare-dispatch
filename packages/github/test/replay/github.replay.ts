// The `Execution` workflow's GitHub and side outputs as a `V-REPLAY` workflow (specs/github-output.md FD-GH-009,
// FD-GH-078). One run over a SQLite D1 admits two executions with their `cp:check:open` rows, takes the first one's
// `exec.intents` batch (an email, a Slack verdict post and a notice), accepts both epochs, writes both terminal outcomes
// through mameko's `applyOutbox` stage and drains the outbox to quiet through every GitHub actuator onto a fake GitHub,
// a fake mail sender, a fake notice channel and a recording Slack endpoint. The second execution's outcome row goes out
// before its `check.open` row, so its conclusion creates the check run. A second run repeats every step over the same
// D1 and fakes, as an engine that lost its journal entries runs them again.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import {
  actuatorBindings,
  controlPlaneSettings,
  drainOnce,
  executionId,
  ExecutionSteps,
  type ExecutionOutcome,
} from "@fractalboxdev/mameko-coordinator";
import {
  d1OutboxStore,
  insertOutboxRows,
  runD1Migrations,
  type D1Like,
  type D1Statement,
} from "@fractalboxdev/mameko-host-cloudflare/d1";
import { d1StageIntents } from "@fractalboxdev/mameko-host-cloudflare/d1-checkpoints";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import type { ReplayEffect, ReplayWorkflow } from "../../../ops/src/verification/harness.ts";
import { GithubApp } from "../../src/app.ts";
import { fakeSide, fakeWritesLayer } from "../../src/fake-writes.test-support.ts";
import {
  fakeConcludeFacts,
  fakeGithub,
  fakeGithubLayers,
  type FakeGithub,
} from "../../src/fake.test-support.ts";
import { GithubApplierLive } from "../../src/github-applier.ts";
import { ActuatorRateLimitLive, installationQuotaLayer } from "../../src/rate-limit.ts";
import { EmailSender, NoticeChannel, SideOutputConfig } from "../../src/side-ports.ts";

const profile = buildProfile("production");
const settings = controlPlaneSettings(profile);
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const MINUTE_MS = 60_000;
export const SCOPE = "acme/app";
export const SHA = "b".repeat(40);
const EXECUTOR = "cf-1";
const EPOCH = 1;

/** The execution that opens its check run at admission and emits the side outputs. */
export const OPENED = executionId(T0 + 1, () => 0.5);
/** The execution whose outcome row goes out before its `check.open` row, so its conclusion creates the check run. */
export const CONCLUDED_FIRST = executionId(T0 + 2, () => 0.5);
export const checkName = (id: string) => `flare-dispatch/run-${id.slice(-4)}:ci`;

/** The run's `exec.intents` batch: one email, one Slack verdict post and one notice. */
export const SIDE_INTENTS = [
  {
    intent_key: "notify:0",
    kind: "notify.email",
    payload: { to: ["ops@example.com"], subject: "run-0 passed", text: "All checks passed." },
  },
  { intent_key: "notify:1", kind: "notify.slack", payload: { text: "run-0 passed" } },
  {
    intent_key: "notify:2",
    kind: "notice.publish",
    payload: {
      run: "run-0",
      use_case: "verdict",
      dedupe_key: SHA,
      title: "run-0 passed",
      body: "All checks passed.",
    },
  },
] as const;

const SUCCESS: ExecutionOutcome = { _tag: "Success", epoch: EPOCH };

const statement = (
  db: DatabaseSync,
  sql: string,
  params: readonly unknown[] = [],
): D1Statement => ({
  bind: (...values) => statement(db, sql, values),
  run: async () => db.prepare(sql).run(...(params as SQLInputValue[])),
  all: async () => ({ results: db.prepare(sql).all(...(params as SQLInputValue[])) as unknown[] }),
});

/** A D1 over Node's SQLite whose `batch` runs in one transaction, as D1 runs it atomically. */
const sqliteD1 = (): D1Like & { readonly sqlite: DatabaseSync } => {
  const db = new DatabaseSync(":memory:");
  return {
    sqlite: db,
    prepare: (sql) => statement(db, sql),
    batch: async (statements) => {
      db.exec("begin");
      try {
        const out = [];
        for (const s of statements) out.push(await s.all());
        db.exec("commit");
        return out;
      } catch (e) {
        db.exec("rollback");
        throw e;
      }
    },
  };
};

/** Everything the run's outputs reached outside D1, in order, with the step that was running. */
export interface Sent {
  readonly step: string;
  readonly to: "email" | "slack" | "notice";
  readonly ref: string;
}

const unused = () => Effect.die("not used by these outputs");

/** The control plane of one replay workflow: one D1, one fake GitHub, the delivery fakes and one `TestClock`. */
export const plane = async () => {
  const db = sqliteD1();
  await runD1Migrations(db);
  const gh: FakeGithub = fakeGithub();
  const sent: Sent[] = [];
  let step = "none";
  const record = (to: Sent["to"], ref: string) => void sent.push({ step, to, ref });

  const ports = Layer.mergeAll(
    fakeGithubLayers(gh),
    fakeConcludeFacts(gh),
    fakeWritesLayer(fakeSide()),
    Layer.succeed(GithubApp, {
      jwt: unused(),
      token: unused,
      installationFor: unused,
      evictInstallation: unused,
      evictRepositories: unused,
      installations: unused(),
      rest: unused,
    }),
    Layer.succeed(SideOutputConfig, {
      appBot: {
        login: "flare-dispatch[bot]",
        name: "flare-dispatch[bot]",
        email: "bot@example.com",
      },
      slack: { url: "https://hooks.example.com/verdicts", secret: "slack-secret" },
      fetch: (async (_: unknown, init?: RequestInit) => {
        record("slack", new Headers(init?.headers).get("x-flare-dispatch-delivery") ?? "");
        return new Response("ok");
      }) as typeof fetch,
    }),
    Layer.succeed(EmailSender, {
      send: (m) =>
        Effect.sync(
          () => (record("email", m.messageId), { _tag: "sent" as const, ref: m.messageId }),
        ),
    }),
    Layer.succeed(NoticeChannel, {
      publish: (n) =>
        Effect.sync(
          () => (record("notice", n.deliveryId), { _tag: "sent" as const, ref: n.deliveryId }),
        ),
    }),
  );
  const layer = Layer.mergeAll(
    d1OutboxStore(db),
    d1ExecutionSteps(db, { ...settings.execution, meteredCost: () => Effect.succeed(0) }),
    GithubApplierLive.pipe(Layer.provide(ports)),
    ActuatorRateLimitLive.pipe(Layer.provide(Layer.merge(installationQuotaLayer(), ports))),
    TestClock.layer(),
  );
  const runtime = ManagedRuntime.make(layer);
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    runtime.runPromise(effect);
  let now = T0;
  await run(TestClock.setTime(now));
  const actuatorOf = actuatorBindings(profile.intent_kinds);
  const rows = <R>(sql: string) => db.sqlite.prepare(sql).all() as R[];
  const during = async <A>(name: string, f: () => Promise<A>) => {
    step = name;
    try {
      return await f();
    } finally {
      step = "none";
    }
  };

  return {
    db,
    gh,
    sent,
    rows,
    /** Admission's rows: the execution, its epoch-1 placement and its `cp:check:open` row. */
    admit: (id: string) =>
      during("admit", async () => {
        db.sqlite
          .prepare(
            `insert into executions (id, scope_id, run, class, status, enqueued_at)
             values (?, ?, ?, 'required', 'running', ?) on conflict (id) do nothing`,
          )
          .run(id, SCOPE, `run-${id.slice(-4)}`, T0);
        db.sqlite
          .prepare(
            `insert into placements (execution_id, state, epoch, executor_id) values (?, 'leased', ?, ?)
             on conflict (execution_id) do nothing`,
          )
          .run(id, EPOCH, EXECUTOR);
        const entry = profile.intent_kinds["check.open"]!;
        const payload = { name: checkName(id), head_sha: SHA };
        await insertOutboxRows(db, [
          {
            id: `${id}:cp:check:open`,
            limitKey: SCOPE,
            tier: entry.delivery_tier,
            priority: entry.priority ?? 0,
            classRank: profile.classes.find((c) => c.name === "required")?.rank ?? 0,
            drawsReserve: true,
            intent: {
              executionId: id,
              scopeId: SCOPE,
              intentKey: "cp:check:open",
              kind: "check.open",
              payload,
              payloadDigest: JSON.stringify(payload),
              effectClass: entry.effect_class,
              attempts: 0,
            },
            row: newRow({ effectClass: entry.effect_class, insertedAt: now }),
          },
        ]);
        gh.facts.set(id, {
          name: checkName(id),
          headSha: SHA,
          attempt: 1,
          detailsUrl: undefined,
          details: {
            class: "required",
            executor_kind: "cloudflare",
            placement_reason: "cloud entry won",
            queue_age_ms: 0,
            reserved_micro_usd: 0,
            settled_micro_usd: 0,
          },
          recorded: null,
        });
      }),
    /** The executor channel stages the run's `exec.intents` batch under the epoch's lease. */
    stage: (id: string, intents: typeof SIDE_INTENTS) =>
      during("stage", () =>
        run(
          d1StageIntents(db, {
            executionId: id,
            epoch: EPOCH,
            executorId: EXECUTOR,
            intents,
            effectClassOf: (kind) =>
              Object.hasOwn(settings.channel.intentKinds, kind)
                ? settings.channel.intentKinds[kind]
                : undefined,
          }),
        ),
      ),
    /** The channel accepts the epoch's `exec.result`. */
    accept: (id: string) =>
      during("accept", async () => {
        db.sqlite
          .prepare(
            "update placements set state = 'accepted', accepted_epoch = ? where execution_id = ? and state = 'leased'",
          )
          .run(EPOCH, id);
      }),
    /** The workflow's `apply-outbox` stage for the accepted outcome. */
    terminal: (id: string, outcome: ExecutionOutcome = SUCCESS) =>
      during("terminal", () => run(ExecutionSteps.use((s) => s.applyOutbox(id, outcome, EPOCH)))),
    /** Outbox passes a minute apart until no row is left to send. */
    drainAll: () =>
      during("drain", async () => {
        for (let pass = 0; pass < 20; pass++) {
          await run(
            drainOnce({ now, token: (id) => `tok-${id}-${now}`, random: () => 0.5, actuatorOf }),
          );
          const [{ n }] = rows<{ n: number }>(
            "select count(*) as n from outbox where state in ('pending', 'in_flight', 'ambiguous')",
          ) as [{ n: number }];
          if (n === 0) return;
          now += MINUTE_MS;
          await run(TestClock.setTime(now));
        }
        throw new Error("the outbox did not go quiet");
      }),
    dispose: () => runtime.dispose(),
  };
};

export type Plane = Awaited<ReturnType<typeof plane>>;

/** Every row the workflow's steps write, keyed by table and key, with its full content. */
const snapshot = (p: Plane): ReadonlyMap<string, string> =>
  new Map(
    (
      [
        ["outbox", "id"],
        ["executions", "id"],
        ["placements", "execution_id"],
        ["staged_intents", "execution_id || '/' || intent_key"],
      ] as const
    ).flatMap(([table, key]) =>
      p
        .rows<{ k: string }>(`select ${key} as k, * from ${table}`)
        .map((r) => [`${table} ${r.k}`, JSON.stringify(r)] as const),
    ),
  );

/** One run of both executions' outputs, over `journal` or a fresh plane. */
export const lifecycle = async (journal: Plane | null) => {
  const p = journal ?? (await plane());
  const calls = p.gh.calls.length;
  const before = snapshot(p);

  await p.admit(OPENED);
  await p.drainAll();
  await p.stage(OPENED, SIDE_INTENTS);
  await p.accept(OPENED);
  await p.terminal(OPENED);
  await p.admit(CONCLUDED_FIRST);
  await p.accept(CONCLUDED_FIRST);
  await p.terminal(CONCLUDED_FIRST);
  await p.drainAll();

  const after = snapshot(p);
  const effects: ReplayEffect[] = [
    ...p.gh.calls.slice(calls).map((call): ReplayEffect => ({ kind: "github", key: call })),
    ...[...after]
      .filter(([key, row]) => before.get(key) !== row)
      .map(([key]): ReplayEffect => ({ kind: "d1", key })),
    ...[...after.keys()]
      .filter((key) => key.startsWith("outbox ") && !before.has(key))
      .map((key): ReplayEffect => ({ kind: "intent", key })),
  ];
  return { journal: p, effects };
};

export const workflows: readonly ReplayWorkflow<Plane>[] = [
  {
    name: "execution-github-outputs",
    ids: ["FD-GH-009", "FD-GH-078"],
    run: async (journal) => {
      const out = await lifecycle(journal);
      if (journal !== null) await out.journal.dispose();
      return out;
    },
  },
];
