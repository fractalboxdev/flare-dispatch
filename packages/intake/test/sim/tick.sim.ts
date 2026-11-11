// The minute tick's units as a V-SIM scenario (specs/intake.md FD-INT-067). A seed fixes the installations'
// repositories, each manifest's entries and schedules, which manifests do not read, each repository's pull requests,
// required sets and check runs, the minutes the platform fires the tick and which firings repeat. Each firing only
// plans and enqueues: every installation's units go to its own unit queue, kept in an in-memory Durable Object
// storage. Each alarm then runs one unit through intake into mameko's admission on a SQLite D1, against the fake's
// GitHub reads, and queues the unit that continues it. The scenario checks that an enqueue reads and writes nothing,
// that every alarm stays within 500 D1 queries and 1,000 subrequests, and that the continuations reach every
// repository: each scheduled (run, repository, minute) has its execution, and each head the sweep must submit has an
// execution for every manifest entry.
// `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts): each seed fails on any violation.
import {
  GithubHttpError,
  type CheckRunSummary,
  type PullSummary,
} from "@fractalboxdev/flare-dispatch-github";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import {
  APP_ID,
  BASE,
  harness,
  manifest,
  NOW,
  repoWithManifest,
  type Harness,
} from "../../src/harness.test-support.ts";
import { cronMatches, parseCron } from "../../src/cron.ts";
import {
  enqueueUnits,
  planTick,
  runQueuedUnit,
  SWEEP_PULLS_PER_INSTALLATION,
  SWEEP_WINDOW_MS,
  type UnitQueueStorage,
} from "../../src/tick.ts";

export interface SimOutcome {
  readonly violations: readonly SimViolation[];
  /** How often each case the scenario exists to reach was reached. */
  readonly reached: Readonly<Record<string, number>>;
  /** Every step, with no execution id in it, so one seed replays to the same trace. */
  readonly trace: readonly string[];
}

/** The bounds FD-INT-067 sets on one unit. */
const D1_QUERY_BOUND = 500;
const SUBREQUEST_BOUND = 1_000;

const SCHEDULES = ["* * * * *", "*/2 * * * *", "*/10 * * * *", "0 * * * *", "3-7 * * * *"];
const RECIPES = ["nightly", "check"];

const pick = <A>(random: () => number, xs: readonly A[]): A =>
  xs[Math.floor(random() * xs.length)]!;

/** A Durable Object's storage in memory; `fire` clears the alarm as the platform does before it runs `alarm()`. */
const memoryStorage = () => {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage: UnitQueueStorage = {
    get: async (key) => structuredClone(data.get(key)),
    put: async (key, value) => void data.set(key, structuredClone(value)),
    getAlarm: async () => alarm,
    setAlarm: async (at) => void (alarm = at),
  };
  return {
    storage,
    fire: () => {
      const at = alarm;
      alarm = null;
      return at;
    },
  };
};

interface Entry {
  readonly recipe: string;
  readonly label: string;
  readonly cron: string;
}

interface SeededRepo {
  readonly name: string;
  readonly installation: number;
  readonly entries: readonly Entry[];
  readonly readable: boolean;
}

/** What one unit spent: D1 statements, and GitHub reads plus workflow starts and alarm deliveries. */
const meter = (h: Harness) => {
  const at = () => ({
    queries: h.db.queries(),
    subrequests: h.reads.calls.length + h.recorded.started.length + h.recorded.alarms.length,
  });
  const start = at();
  return () => {
    const end = at();
    return {
      queries: end.queries - start.queries,
      subrequests: end.subrequests - start.subrequests,
    };
  };
};

/**
 * Two installations with one to five repositories each. A repository's manifest lists one to six entries, or with
 * odds of one in five 25 to 45, each a labelled `nightly` or `check` answering `pull_request` and one seeded cron
 * expression; one manifest in eight does not read. A repository has up to 40 open pull requests (up to 3 under a wide
 * manifest) updated around the 72 h edge, a required set of some entries' check names and this App's check runs on
 * some heads. The platform fires the tick at seeded minutes, at times twice for one minute. After each firing every
 * alarm of both queues runs until the queues are empty.
 */
export const simulateTickUnits = async (seed: number): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached = {
    alarms: 0,
    continued: 0,
    d1Bound: 0,
    subrequestBound: 0,
    midPull: 0,
    laterRepository: 0,
    refired: 0,
    unreadable: 0,
  };
  const fail = (step: string, message: string) =>
    violations.push({ id: "FD-INT-067", message: `${step}: ${message}` });

  const seeded: SeededRepo[] = [];
  const repos: Record<string, ReturnType<typeof repoWithManifest>> = {};
  let heads = 0;
  for (const installation of [7, 8]) {
    const count = 1 + Math.floor(random() * 5);
    for (let r = 0; r < count; r++) {
      const name = `acme${installation}/r${r}`;
      const wide = random() < 0.2;
      const n = wide ? 25 + Math.floor(random() * 21) : 1 + Math.floor(random() * 6);
      const entries = Array.from({ length: n }, (_, i) => ({
        recipe: pick(random, RECIPES),
        label: `e${i}`,
        cron: pick(random, SCHEDULES),
      }));
      const readable = random() >= 0.125;
      const names = entries.map((e) => `flare-dispatch/${e.recipe}:${e.label}`);
      const required = names.filter(() => random() < 0.3);
      const pulls: PullSummary[] = [];
      const checkRuns: Record<string, CheckRunSummary[]> = {};
      const p = Math.floor(random() * (wide ? 4 : 41));
      for (let i = 0; i < p; i++) {
        const sha = (++heads).toString(16).padStart(40, "0");
        const ago =
          random() < 0.2
            ? SWEEP_WINDOW_MS + (random() < 0.5 ? -1 : 1) * Math.floor(1 + random() * 1_200_000)
            : Math.floor(random() * 60 * 3_600_000);
        pulls.push({
          number: i + 1,
          updated_at: new Date(NOW - ago).toISOString(),
          head: { sha, ref: `f${i}`, repo: { full_name: name } },
          base: { ref: "main", repo: { full_name: name } },
        });
        checkRuns[sha] = required
          .filter(() => random() < 0.5)
          .map((check, j) => ({
            id: heads * 100 + j,
            name: check,
            external_id: "x",
            app: { id: APP_ID },
          }));
      }
      repos[name] = repoWithManifest(
        manifest(
          entries.map((e) => ({
            recipe: e.recipe,
            label: e.label,
            triggers: ["pull_request", "cron"],
            schedules: [{ cron: e.cron }],
          })),
        ),
        {
          branches: { main: BASE },
          required: { main: required },
          pulls,
          checkRuns,
        },
      );
      seeded.push({ name, installation, entries, readable });
    }
  }
  const h = await harness({
    repos,
    installations: Object.fromEntries(seeded.map((r) => [r.name, r.installation])),
  });
  for (const r of seeded)
    if (!r.readable)
      h.reads.failures.set(
        `file ${r.name}`,
        new GithubHttpError({
          status: 502,
          message: "Bad Gateway",
          rateLimited: false,
        }),
      );
  const queues = new Map([7, 8].map((i) => [i, memoryStorage()]));

  /** The cron dedup keys a minute's tick must create: one per (recipe, readable repository) a schedule matches. */
  const cronKeys = (at: number) =>
    seeded
      .filter((r) => r.readable)
      .flatMap((r) =>
        RECIPES.filter((recipe) =>
          r.entries.some((e) => e.recipe === recipe && cronMatches(parseCron(e.cron)!, at)),
        ).map((recipe) => `${recipe}:${r.name}:cron:${new Date(at).toISOString()}`),
      );
  /** The (repository, head, label) triples a sweep at `now` must submit. */
  const sweepTriples = (now: number) => {
    const out: string[] = [];
    for (const installation of [7, 8]) {
      let seen = 0;
      for (const r of seeded.filter((x) => x.installation === installation)) {
        const repo = h.reads.repos[r.name]!;
        const recent = repo.pulls
          .filter((p) => now - Date.parse(p.updated_at) <= SWEEP_WINDOW_MS)
          .slice(0, Math.max(0, SWEEP_PULLS_PER_INSTALLATION - seen));
        seen += recent.length;
        const required = repo.required["main"] ?? [];
        if (!r.readable || required.length === 0) continue;
        for (const p of recent) {
          const ours = (repo.checkRuns[p.head.sha] ?? []).filter((c) => c.app?.id === APP_ID);
          if (required.every((n) => ours.some((c) => c.name === n))) continue;
          for (const e of r.entries) out.push(`${r.name}@${p.head.sha}#${e.label}`);
        }
      }
    }
    return out;
  };

  const wantCron = new Set<string>();
  const wantSweep = new Set<string>();
  let now = NOW;
  const fired: number[] = [];
  const ticks = 4 + Math.floor(random() * 4);
  for (let t = 0; t < ticks; t++) {
    // A repeated firing of an earlier minute, or the next minute's.
    const again = fired.length > 0 && random() < 0.25;
    const at = again ? pick(random, fired) : now;
    if (again) reached.refired++;
    else fired.push(at);
    const s = `tick ${t} ${new Date(at).toISOString()}`;
    const enqueued = meter(h);
    for (const [installation, q] of queues)
      await h.run(enqueueUnits(q.storage, planTick(at, [installation]), now));
    const cost = enqueued();
    if (cost.queries !== 0 || cost.subrequests !== 0)
      fail(
        s,
        `the tick's enqueue made ${cost.queries} D1 queries and ${cost.subrequests} subrequests`,
      );
    for (const k of cronKeys(at)) wantCron.add(k);
    if (new Date(at).getUTCMinutes() % 10 === 0)
      for (const k of sweepTriples(now)) wantSweep.add(k);

    let alarms = 0;
    for (const [installation, q] of queues) {
      while (q.fire() !== null) {
        if (++alarms > 400) {
          fail(s, `installation ${installation}'s queue did not drain in 400 alarms`);
          break;
        }
        const spent = meter(h);
        const ran = await h.run(runQueuedUnit(q.storage, now));
        const used = spent();
        reached.alarms++;
        if (ran === null) continue;
        if (ran._tag === "Failed") {
          fail(s, `a ${ran.unit._tag} unit of installation ${installation} failed`);
          continue;
        }
        if (used.queries > D1_QUERY_BOUND)
          fail(s, `a ${ran.unit._tag} unit made ${used.queries} D1 queries`);
        if (used.subrequests > SUBREQUEST_BOUND)
          fail(s, `a ${ran.unit._tag} unit made ${used.subrequests} subrequests`);
        if (ran.unit.repoIndex > 0 && ran.result.outcome.executions.length > 0)
          reached.laterRepository++;
        const next = ran.result.next;
        if (next !== null) {
          reached.continued++;
          if (ran.result.stoppedAt === "d1-queries") reached.d1Bound++;
          if (ran.result.stoppedAt === "subrequests") reached.subrequestBound++;
          if (next._tag === "sweep" && (next.submitted ?? 0) > 0) reached.midPull++;
        }
      }
    }
    trace.push(`${s} again=${again} alarms=${alarms}`);
    if (!again) {
      const ms = random() < 0.5 ? 60_000 : (10 - (new Date(now).getUTCMinutes() % 10)) * 60_000;
      await h.adjust(ms);
      now += ms;
    }
  }
  reached.unreadable = seeded.filter((r) => !r.readable).length;

  const haveCron = new Set(
    h
      .rows("select canonical from dedup_keys where canonical like '%:cron:%'")
      .map((r) => r.canonical as string),
  );
  for (const k of wantCron) if (!haveCron.has(k)) fail("end", `no execution for ${k}`);
  for (const k of haveCron)
    if (!wantCron.has(k)) fail("end", `${k} has an execution no schedule matches`);
  const haveSweep = new Set(
    h
      .rows("select repo, sha, label from intake_records where trigger = 'webhook'")
      .map((r) => `${String(r.repo)}@${String(r.sha)}#${String(r.label)}`),
  );
  const missing = [...wantSweep].filter((k) => !haveSweep.has(k));
  if (missing.length > 0)
    fail("end", `${missing.length} sweep submissions never made, first ${missing[0]}`);
  const extra = [...haveSweep].filter((k) => !wantSweep.has(k));
  if (extra.length > 0)
    fail("end", `${extra.length} sweep submissions not expected, first ${extra[0]}`);
  trace.push(`cron=${haveCron.size} sweep=${haveSweep.size}`);
  return { violations, reached, trace };
};

/** Every scenario of this file, by name, as the test and the `sim` job run them. */
export const simulations: Readonly<Record<string, (seed: number) => Promise<SimOutcome>>> = {
  "tick-units": simulateTickUnits,
};

export const scenarios: readonly SimScenario[] = [
  {
    name: "tick-units",
    ids: ["FD-INT-067"],
    run: async (seed) => throwOnViolations((await simulateTickUnits(seed)).violations),
  },
];
