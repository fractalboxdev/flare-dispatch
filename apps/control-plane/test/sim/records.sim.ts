// The verdict records of a deploy whose overlay sets `records.url`, as a V-SIM scenario (specs/github-output.md § Job
// and verdict records, FD-GH-094, FD-GH-102). A seed fixes the number of executions, each one's check label, the epoch
// of its latest lease grant, the tick it ends on and its outcome, and how the records endpoint answers its record:
// accepted, refused with a `400`, or a `503` before it accepts. Every execution lives in mameko's store on a SQLite D1
// with intake's records beside it; terminal writes run mameko's `applyOutbox` stage, and each minute runs the
// operability package's tick, whose drain sends the outbox through the GitHub actuators to a fake GitHub and the
// records endpoint. The scenario checks after every tick that only terminal executions have a `verdict.record` row and
// each has at most one, and at the end that each execution has exactly one, keyed `verdict-record:<execution_id>` on
// the `records` key with its outcome, that each refused record raised one `record-undelivered` page naming its
// execution and no other record raised one, and that the execution row and its check run's conclusion stayed as the
// terminal write and the conclusion left them.
import {
  ActuatorRateLimitLive,
  checkConclusion,
  GithubApp,
  GithubApplierLive,
  installationQuotaLayer,
  SideOutputConfig,
  verdictOf,
} from "@fractalboxdev/flare-dispatch-github";
import {
  fakeGithub,
  fakeGithubLayers,
  fakeSide,
  fakeWritesLayer,
} from "@fractalboxdev/flare-dispatch-github/testing";
import { d1IntakeStore, IntakeStore } from "@fractalboxdev/flare-dispatch-intake";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { minuteTick, type TickDeps } from "@fractalboxdev/flare-dispatch-ops";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { ExecutionSteps, type ExecutionOutcome } from "@fractalboxdev/mameko-coordinator";
import { insertOutboxRows } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { AlarmPort, type Alarm } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../../packages/ops/src/verification/harness.ts";
import { executionConfig } from "../../src/config.ts";
import { concludeFactsLayer } from "../../src/github.ts";
import { envOf, record, type TestD1 } from "../conclude.test-support.ts";

const RUN = "offload-test";
const SHA = "b".repeat(40);
const SCOPE = "acme/app";
const RECORDS_URL = "https://records.example.com/hook";
const MINUTE_MS = 60_000;
export const profile = buildProfile("production", 2, { records: true });

const OUTCOMES: readonly ExecutionOutcome[] = [
  { _tag: "Success", epoch: 1 },
  { _tag: "Failure", reason: "test: 2 failed", epoch: 1 },
  { _tag: "Failure", reason: "capacity: no executor", epoch: null },
  { _tag: "Skipped", detail: "nothing-to-lint", epoch: 1 },
  { _tag: "Cancelled", cause: "operator-cancel" },
];

/** How the records endpoint answers one execution's record. */
type Answer = "accept" | "refuse" | "retry";
const ANSWERS: readonly Answer[] = ["accept", "refuse", "retry"];

export interface RecordsOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

const terminalWrite = (db: TestD1, executionId: string, outcome: ExecutionOutcome) =>
  Effect.runPromise(
    ExecutionSteps.use((steps) => steps.applyOutbox(executionId, outcome, null)).pipe(
      Effect.provide(
        d1ExecutionSteps(db, { ...executionConfig(profile), meteredCost: () => Effect.succeed(0) }),
      ),
    ),
  );

/** One admitted execution: its intake record, mameko's execution row, its leased placement and its `cp:check:open`. */
const seed = async (db: TestD1, id: string, label: string, epoch: number, now: number) => {
  await Effect.runPromise(
    IntakeStore.use((s) => s.put(record(id, { run: RUN, label, sha: SHA }))).pipe(
      Effect.provide(d1IntakeStore(db)),
    ),
  );
  db.sqlite
    .prepare(
      `insert into executions (id, scope_id, run, class, status, enqueued_at)
       values (?, ?, ?, 'required', 'running', ?)`,
    )
    .run(id, SCOPE, RUN, now);
  db.sqlite
    .prepare(
      `insert into placements (execution_id, state, epoch, leased_epoch) values (?, 'leased', ?, ?)`,
    )
    .run(id, epoch, epoch);
  const payload = { name: `flare-dispatch/${RUN}:${label}`, head_sha: SHA };
  await insertOutboxRows(db, [
    {
      id: `${id}:cp:check:open`,
      limitKey: SCOPE,
      tier: "effect",
      priority: 0,
      classRank: 1,
      drawsReserve: false,
      intent: {
        executionId: id,
        scopeId: SCOPE,
        intentKey: "cp:check:open",
        kind: "check.open",
        payload,
        payloadDigest: JSON.stringify(payload),
        effectClass: "adoptable",
        attempts: 0,
      },
      row: newRow({ effectClass: "adoptable", insertedAt: now }),
    },
  ]);
};

const unused = () => Effect.die("not used by a check or record row");

export const simulateRecords = async (seedValue: number): Promise<RecordsOutcome> => {
  const random = seededRandom(seedValue);
  const pick = <A>(xs: readonly A[]): A => xs[Math.floor(random() * xs.length)]!;
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached: Record<string, number> = {
    accept: 0,
    refuse: 0,
    retry: 0,
    endedTogether: 0,
    concluded: 0,
  };
  const db = await migratedD1();
  const gh = fakeGithub();
  const pages: Alarm[] = [];
  const answers = new Map<string, Answer>();
  const sent = new Map<string, number>();

  const recordsFetch = (async (_url: unknown, init?: RequestInit) => {
    const { execution_id: id } = JSON.parse(String(init?.body)) as { execution_id: string };
    const n = (sent.get(id) ?? 0) + 1;
    sent.set(id, n);
    const answer = answers.get(id);
    const status = answer === "refuse" ? 400 : answer === "retry" && n === 1 ? 503 : 202;
    return new Response(null, { status });
  }) as typeof fetch;
  const ports = Layer.mergeAll(
    fakeGithubLayers(gh),
    concludeFactsLayer(envOf(db)),
    fakeWritesLayer(fakeSide()),
    installationQuotaLayer(),
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
      slack: undefined,
      records: { url: RECORDS_URL, secret: "records-secret" },
      fetch: recordsFetch,
    }),
  );
  const deps: TickDeps = {
    profile,
    alarmPort: Layer.succeed(AlarmPort, {
      deliver: (alarm) => Effect.sync(() => void pages.push(alarm)),
    }),
    appliers: Layer.merge(GithubApplierLive, ActuatorRateLimitLive).pipe(Layer.provide(ports)),
    webhookSilentHours: 24,
  };
  const env = {
    DB: db,
    MONITOR: { idFromName: (n: string) => n, get: () => ({ start: async () => {} }) },
  };
  const recordRows = () =>
    db.sqlite
      .prepare(
        `select execution_id, scope_id, intent_key, limit_key, state, payload_json from outbox
         where kind = 'verdict.record'`,
      )
      .all() as {
      execution_id: string | null;
      scope_id: string;
      intent_key: string;
      limit_key: string;
      state: string;
      payload_json: string;
    }[];
  const executionRow = (id: string) =>
    db.sqlite.prepare("select status, reason, finished_at from executions where id = ?").get(id);

  // The terminal writes stamp rows with the store's clock, so every tick runs after them.
  let clock = Date.now() + 1_000;
  const tick = async () => {
    clock += MINUTE_MS;
    await Effect.runPromise(minuteTick(env, deps, clock));
    const terminal = new Set(
      (
        db.sqlite
          .prepare("select id from executions where status not in ('pending', 'running')")
          .all() as { id: string }[]
      ).map((r) => r.id),
    );
    const perExecution = new Map<string, number>();
    for (const r of recordRows()) {
      const id = (JSON.parse(r.payload_json) as { execution_id: string }).execution_id;
      perExecution.set(id, (perExecution.get(id) ?? 0) + 1);
      if (!terminal.has(id))
        violations.push({ id: "FD-GH-094", message: `${id} has a verdict.record before it ended` });
    }
    for (const [id, n] of perExecution)
      if (n > 1)
        violations.push({ id: "FD-GH-094", message: `${id} has ${n} verdict.record rows` });
  };

  const count = 2 + Math.floor(random() * 6);
  const executions: {
    id: string;
    label: string;
    epoch: number;
    outcome: ExecutionOutcome;
    endsAt: number;
    after?: unknown;
  }[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `exec-${i}`;
    const label = `j${i}`;
    const epoch = 1 + Math.floor(random() * 2);
    await seed(db, id, label, epoch, clock);
    const answer = pick(ANSWERS);
    answers.set(id, answer);
    reached[answer]!++;
    executions.push({
      id,
      label,
      epoch,
      outcome: pick(OUTCOMES),
      endsAt: Math.floor(random() * 4),
    });
    trace.push(`${id} ${answer}`);
  }
  for (let minute = 0; minute < 4; minute++) {
    const ending = executions.filter((e) => e.endsAt === minute);
    if (ending.length > 1) reached.endedTogether!++;
    for (const e of ending) {
      await terminalWrite(db, e.id, e.outcome);
      e.after = executionRow(e.id);
      trace.push(`${e.id} ${e.outcome._tag} at ${minute}`);
    }
    await tick();
  }
  // Enough minutes for the drain to send each record, a retried one after its back-off.
  for (let minute = 0; minute < 30; minute++) {
    await tick();
    const open = db.sqlite
      .prepare(
        "select count(*) as n from outbox where state in ('pending', 'in_flight', 'ambiguous')",
      )
      .get() as { n: number };
    if (open.n === 0) break;
  }

  const rows = recordRows();
  const undelivered = pages.filter((a) => a.name === "record-undelivered");
  for (const e of executions) {
    const mine = rows.filter((r) => r.intent_key === `ops:verdict-record:${e.id}`);
    const expectedVerdict = verdictOf(e.outcome);
    const conclusion = checkConclusion(expectedVerdict).conclusion;
    if (mine.length !== 1) {
      violations.push({
        id: "FD-GH-094",
        message: `${e.id} has ${mine.length} verdict.record rows keyed verdict-record:${e.id}`,
      });
      continue;
    }
    const row = mine[0]!;
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (
      row.execution_id !== null ||
      row.scope_id !== SCOPE ||
      row.limit_key !== "records" ||
      payload.execution_id !== e.id ||
      payload.verdict !== expectedVerdict._tag ||
      payload.epoch !== e.epoch ||
      payload.check_name !== `flare-dispatch/${RUN}:${e.label}` ||
      (payload.conclusion !== null && payload.conclusion !== conclusion)
    )
      violations.push({
        id: "FD-GH-094",
        message: `${e.id}'s verdict.record is ${JSON.stringify({ ...row, payload })}`,
      });
    if (payload.conclusion !== null) reached.concluded!++;
    const answer = answers.get(e.id)!;
    const expectedState = answer === "refuse" ? "refused" : "applied";
    if (row.state !== expectedState)
      violations.push({
        id: "FD-GH-102",
        message: `${e.id}'s record answered ${answer} ended ${row.state}`,
      });
    const paged = undelivered.filter(
      (a) => (a.detail as { execution_id?: string } | null)?.execution_id === e.id,
    );
    const pagesExpected = answer === "refuse" ? 1 : 0;
    if (paged.length !== pagesExpected || paged.some((a) => a.severity !== "page"))
      violations.push({
        id: "FD-GH-102",
        message: `${e.id}'s record answered ${answer} raised ${JSON.stringify(paged)}`,
      });
    // The record's fate changes neither the execution's verdict nor its check run's conclusion.
    if (JSON.stringify(executionRow(e.id)) !== JSON.stringify(e.after))
      violations.push({
        id: "FD-GH-102",
        message: `${e.id}'s execution row changed from ${JSON.stringify(e.after)} to ${JSON.stringify(executionRow(e.id))}`,
      });
    const runs = gh.runs.filter((r) => r.external_id === e.id);
    if (runs.length !== 1 || runs[0]!.conclusion !== conclusion)
      violations.push({
        id: "FD-GH-102",
        message: `${e.id}'s check runs ended ${JSON.stringify(runs.map((r) => r.conclusion))}, not ${conclusion}`,
      });
  }
  trace.push(`pages ${undelivered.length}`);
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: "verdict-records",
    ids: ["FD-GH-094", "FD-GH-102"],
    run: async (seedValue) => throwOnViolations((await simulateRecords(seedValue)).violations),
  },
];
