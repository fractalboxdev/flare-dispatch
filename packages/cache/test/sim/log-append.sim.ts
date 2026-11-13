// The log-append retry as a V-SIM scenario (specs/provenance.md FD-PROV-041). Each seed countersigns one to four
// statements of repositories that are public, private or of unreadable visibility, and fails each statement's first
// appends a seeded number of times, up to 14, with Rekor's 503, a lost connection or a refused private-log write. A
// driver drains the intents on one simulated clock: at the time the previous drain named as the next due, and at
// seeded times before it. The scenario checks that every failed append is retried, never earlier and never later than
// its delay of 5 s doubling to 10 min, until it succeeds, and that the check summary line shows the statement as
// `log-pending` exactly while no append has succeeded.
//
// `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts): each seed fails on any violation.
import { Effect, Layer, Logger } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import {
  drainLogAppends,
  LOG_PENDING,
  LogAppendFailed,
  LogAppendStatus,
  LogAppendStore,
  RepositoryVisibility,
  statementSummaryLine,
  TransparencyLogs,
  VisibilityUnreadable,
  enqueueLogAppend,
  type LogEntry,
  type LogKind,
} from "../../src/provenance/append.ts";
import { memoryLogAppendStore } from "../../src/provenance/append.test-support.ts";
import { unsignedEnvelope } from "../../src/provenance/dsse.ts";
import { utf8 } from "../../src/crypto.ts";

const START = Date.UTC(2026, 0, 1);
/** FD-PROV-041's delay after the `n`th failed append: 5 s, doubling, at most 10 min. */
const expectedDelay = (n: number) => Math.min(600_000, 5_000 * 2 ** (n - 1));
/** Drops the warning each failed append logs, which every seed would print. */
const Logless = Logger.layer([]);
const VISIBILITIES = ["public", "private", "internal", "unreadable"] as const;
const FAILURES = [
  "rekor answered 503: unavailable",
  "rekor unreachable: connection reset",
  "the private log refused the write: leaf-changed at tlog/private/leaf/000",
] as const;

export interface SimOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

export const simulateLogAppend = async (seed: number): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const pick = <A>(xs: readonly A[]): A => xs[Math.floor(random() * xs.length)]!;
  const violations: SimViolation[] = [];
  const reached: Record<string, number> = {};
  const reach = (k: string) => (reached[k] = (reached[k] ?? 0) + 1);
  const trace: string[] = [];
  const violate = (message: string) => violations.push({ id: "FD-PROV-041", message });

  let now = START;
  const store = memoryLogAppendStore();
  // Each statement's planned failures, and the times of its append attempts.
  const plan = new Map<string, number>();
  const attempts = new Map<string, number[]>();
  const indexes: Record<LogKind, number> = { rekor: 0, private: 0 };
  const attempt = (log: LogKind, envelopeJson: string): Effect.Effect<LogEntry, LogAppendFailed> =>
    Effect.suspend(() => {
      const digest = [...store.intents.values()].find(
        (i) => i.envelope === envelopeJson,
      )!.envelopeDigest;
      const times = attempts.get(digest) ?? [];
      times.push(now);
      attempts.set(digest, times);
      if (times.length <= (plan.get(digest) ?? 0)) {
        const message = pick(FAILURES);
        trace.push(
          `${now - START} ${log} attempt ${times.length} of ${digest.slice(7, 15)} fails: ${message}`,
        );
        return Effect.fail(new LogAppendFailed({ log, message }));
      }
      trace.push(
        `${now - START} ${log} attempt ${times.length} of ${digest.slice(7, 15)} succeeds`,
      );
      return Effect.succeed({
        log,
        logIndex: indexes[log]++,
        entryId: `${log}-${digest.slice(7, 15)}`,
        integratedTime: now,
      });
    });

  const layer = Layer.mergeAll(
    Layer.succeed(LogAppendStore, store),
    Layer.succeed(RepositoryVisibility, {
      of: (repository: string) => {
        const visibility = repository.split("/")[1]!;
        return visibility === "unreadable"
          ? Effect.fail(new VisibilityUnreadable({ repository, message: "502 Bad Gateway" }))
          : Effect.succeed(visibility);
      },
    }),
    Layer.succeed(TransparencyLogs, {
      rekor: (json: string) => attempt("rekor", json),
      private: (json: string) => attempt("private", json),
    }),
  );
  const run = <A, E>(
    effect: Effect.Effect<A, E, LogAppendStore | RepositoryVisibility | TransparencyLogs>,
  ) => Effect.runPromise(Effect.provide(effect, Layer.merge(layer, Logless)));

  const statements = 1 + Math.floor(random() * 4);
  for (let s = 0; s < statements; s++) {
    const visibility = pick(VISIBILITIES);
    const envelope = {
      ...unsignedEnvelope(utf8(JSON.stringify({ seed, s }))),
      signatures: [
        { keyid: "device-1", sig: "AA==" },
        { keyid: "prov-1", sig: "AQ==" },
      ],
    };
    const { digest, log } = await run(
      enqueueLogAppend(
        { envelope, executionId: `exec-${s}`, repository: `acme/${visibility}`, verifiers: [] },
        now,
      ),
    );
    reach(log);
    const failures = Math.floor(random() * 15);
    plan.set(digest, failures);
    if (failures > 0) reach("failedFirst");
    now += Math.floor(random() * 3_000);
  }

  /** The summary line shows `log-pending` exactly while no append of the statement has succeeded. */
  const checkSummaries = () => {
    for (const intent of store.intents.values()) {
      const line = statementSummaryLine(intent);
      const logged = LogAppendStatus.$is("Logged")(intent.status);
      if (logged === line.includes(LOG_PENDING))
        violate(
          `at ${now - START} the summary of ${intent.envelopeDigest} reads "${line}" while ${logged ? "logged" : "pending"}`,
        );
      if (!logged) reach("pendingShown");
    }
  };

  // The driver: drains at the time the previous drain named, or earlier, until every statement is logged.
  let nextDueAt: number | null = now;
  for (let step = 0; nextDueAt !== null && step < 400; step++) {
    const early = random() < 0.3 && nextDueAt > now;
    now = early ? now + Math.floor(random() * (nextDueAt - now)) : Math.max(now, nextDueAt);
    const before = new Map([...attempts].map(([d, t]) => [d, t.length]));
    const drained = await run(drainLogAppends(now));
    if (early) {
      reach("earlyDrain");
      const attempted = [...attempts].filter(([d, t]) => t.length > (before.get(d) ?? 0));
      for (const [digest, times] of attempted) {
        const previous = times.at(-2);
        if (previous !== undefined && now - previous < expectedDelay(times.length - 1))
          violate(
            `${digest} was attempted ${now - previous} ms after its failure ${times.length - 1}, before its delay`,
          );
      }
    }
    nextDueAt = drained.nextDueAt;
    checkSummaries();
  }

  // Every statement is logged after exactly its planned failures plus one attempt, each retry at its delay.
  for (const [digest, failures] of plan) {
    const intent = store.intents.get(digest)!;
    if (!LogAppendStatus.$is("Logged")(intent.status)) {
      violate(`${digest} is still pending after ${attempts.get(digest)?.length ?? 0} attempts`);
      continue;
    }
    const times = attempts.get(digest) ?? [];
    if (times.length !== failures + 1)
      violate(`${digest} took ${times.length} attempts for ${failures} failures`);
    for (let n = 1; n < times.length; n++) {
      const gap = times[n]! - times[n - 1]!;
      const delay = expectedDelay(n);
      if (gap !== delay)
        violate(`${digest} retry ${n} came ${gap} ms after failure ${n}, not ${delay} ms`);
      reach("retries");
      if (delay === 600_000) reach("cappedDelay");
    }
  }
  return { violations, reached, trace };
};

/** The scenario the `sim` job runs, 100 seeds on a pull request and 10,000 nightly (FD-VER-024). */
export const scenarios: readonly SimScenario[] = [
  {
    name: "log-append",
    ids: ["FD-PROV-041"],
    run: async (seed) => throwOnViolations((await simulateLogAppend(seed)).violations),
  },
];
