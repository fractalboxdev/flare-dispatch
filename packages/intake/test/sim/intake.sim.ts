// Intake's V-SIM scenarios (specs/intake.md § Admission, § Repo manifests, § Missed webhooks, § Scheduled runs). Each
// scenario takes a seed that fixes every draw: which webhook or dispatch arrives, which one is a redelivery, where
// the D1 admission transaction fails, how a manifest read fails or stalls, which pull requests the sweep finds and
// how often the platform fires one minute's tick. Every request goes through intake's route or dispatch admission
// into mameko's admission on a SQLite D1, the GitHub reads are the fake's, and the clock is the test clock. After
// every step the scenario checks its requirement against a model of what intake has admitted so far.
// `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts): each seed fails on any violation.
import {
  GithubHttpError,
  type CheckRunSummary,
  type PullSummary,
} from "@fractalboxdev/flare-dispatch-github";
import { Effect } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import type { D1Statement } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { admitDispatch, type AuthenticatedDispatch } from "../../src/dispatch.ts";
import {
  APP_ID,
  authenticated,
  BASE,
  harness,
  manifest,
  NOW,
  pullRequestPayload,
  pushPayload,
  REPO,
  repoWithManifest,
  signedWebhook,
  type Harness,
} from "../../src/harness.test-support.ts";
import { MANIFEST_CACHE_MS, MANIFEST_PATH } from "../../src/manifest.ts";
import { handleIntake } from "../../src/routes.ts";
import { releaseHeld } from "../../src/submit.ts";
import { planTick, runTickUnit, SWEEP_WINDOW_MS, type TickUnit } from "../../src/tick.ts";

export interface SimOutcome {
  readonly violations: readonly SimViolation[];
  /** How often each case the scenario exists to reach was reached. */
  readonly reached: Readonly<Record<string, number>>;
  /** Every step, with no execution id in it, so one seed replays to the same trace. */
  readonly trace: readonly string[];
}

const HEADS = ["1", "2", "3", "4"].map((c) => c.repeat(40));
const pick = <A>(random: () => number, xs: readonly A[]): A =>
  xs[Math.floor(random() * xs.length)]!;

/** A webhook through intake's route: its status and JSON body. */
const deliver = async (h: Harness, event: string, payload: unknown, delivery: string) => {
  const r = await h.run(
    handleIntake(await signedWebhook(event, payload, { delivery }), "webhooks/github"),
  );
  if (r === null) throw new Error("the route group served no response");
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

type DispatchAnswer =
  | { readonly ok: true; readonly executionId: string; readonly duplicate: boolean }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly executionId: string | undefined;
    };

/** An authenticated dispatch through intake's admission: what it admitted, or the refusal's status and code. */
const dispatch = (h: Harness, d: AuthenticatedDispatch) =>
  h.run(
    admitDispatch(d).pipe(
      Effect.map((a): DispatchAnswer => ({ ok: true, ...a })),
      Effect.catchTag("IntakeError", (e) =>
        Effect.succeed<DispatchAnswer>({
          ok: false,
          status: e.status,
          code: e.code,
          executionId: e.executionId,
        }),
      ),
    ),
  );

const count = (h: Harness, table: string) =>
  Number(h.rows(`select count(*) as n from ${table}`)[0]!.n);

// ---------------------------------------------------------------------------
// FD-INT-003: redeliveries and reused keys, interleaved across webhook and dispatch paths

/**
 * Pull request and push webhooks for a few heads, each delivered again under a new or the same delivery id, plain and
 * `Idempotency-Key` dispatches whose bodies repeat or differ, clock advances through `lint`'s cooldown window and the
 * releases of held requests. The model keeps the execution each dedup key answered: every later request for that key
 * answers `202` with it and `duplicate: true`, and a reused key with another body answers `409` `conflict` naming it.
 * A held request owns its key until the tick releases it; once its window has ended, a request for the key may be
 * admitted under a new id, and the release then drops the held one. Every key names one execution, admitted or held,
 * apart from such a held request awaiting its release.
 */
export const simulateRedelivery = async (seed: number): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached = {
    webhookDuplicate: 0,
    crossPath: 0,
    idemDuplicate: 0,
    conflict: 0,
    held: 0,
    lapsed: 0,
  };
  const h = await harness();
  let now = NOW;
  /** The execution each commit-scoped key (`<run>@<sha>`) answers, and the path that admitted it. */
  const commit = new Map<string, { id: string; path: string }>();
  /** Held executions whose key a later request took after their window ended; the next release drops them. */
  const replaced = new Set<string>();
  /** The execution and body sha each Idempotency-Key answered first. */
  const idem = new Map<string, { id: string; sha: string }>();
  const deliveries: { event: string; payload: unknown; delivery: string }[] = [];
  let next = 0;
  const fail = (step: string, message: string) =>
    violations.push({ id: "FD-INT-003", message: `${step}: ${message}` });

  /** Whether `id` is held and its window ended by now. */
  const lapsed = (id: string) =>
    h
      .rows("select not_before from intake_held where execution_id = ?", id)
      .some((r) => Number(r.not_before) <= now);
  /** The model's executions for `keys` before a request: each one's owner, and whether that owner's window lapsed. */
  const before = (keys: readonly string[]) =>
    keys.map((k) => {
      const was = commit.get(k);
      return { key: k, was, lapsed: was !== undefined && lapsed(was.id) };
    });

  /** Checks one answer for the keys `before` read against the model, and records the executions it answered. */
  const expect = (
    step: string,
    path: string,
    known: ReturnType<typeof before>,
    ids: readonly string[],
    duplicate: boolean,
  ) => {
    if (ids.length !== known.length) return fail(step, `answered ${ids.length} of ${known.length}`);
    const dup = known.map(({ key, was, lapsed }, i) => {
      const id = ids[i]!;
      if (was === undefined) commit.set(key, { id, path });
      else if (was.id === id) {
        if (was.path !== path) reached.crossPath++;
        return true;
      } else if (lapsed) {
        replaced.add(was.id);
        commit.set(key, { id, path });
        reached.lapsed++;
      } else fail(step, `${key} answered another execution than the one it names`);
      return false;
    });
    const all = dup.every((d) => d);
    if (duplicate !== all)
      fail(
        step,
        `duplicate: ${duplicate} where ${all ? "every" : "not every"} key named its execution`,
      );
  };

  const webhook = async (step: string) => {
    // A redelivery repeats an earlier event under its own delivery id or under a new one, as GitHub's redeliver and
    // retry do; a fresh event is a pull request or a push for a seeded head.
    const prior = deliveries.length > 0 && random() < 0.5 ? pick(random, deliveries) : undefined;
    const fresh = () => {
      const head = pick(random, HEADS);
      const push = random() < 0.3;
      const event = {
        event: push ? "push" : "pull_request",
        payload: push ? pushPayload("refs/heads/feature", head) : pullRequestPayload({ head }),
        delivery: `d-${++next}`,
      };
      deliveries.push(event);
      return event;
    };
    const sent =
      prior === undefined
        ? fresh()
        : random() < 0.5
          ? prior
          : { ...prior, delivery: `d-${++next}` };
    const again = prior !== undefined;
    const sha =
      sent.event === "push"
        ? (sent.payload as { after: string }).after
        : (sent.payload as { pull_request: { head: { sha: string } } }).pull_request.head.sha;
    const known = before(
      sent.event === "push" ? [`check@${sha}`] : [`check@${sha}`, `lint@${sha}`],
    );
    const r = await deliver(h, sent.event, sent.payload, sent.delivery);
    if (r.status !== 202) return fail(step, `a webhook answered ${r.status}`);
    const duplicate = r.body.duplicate === true;
    if (duplicate) reached.webhookDuplicate++;
    expect(step, "webhook", known, r.body.executions as string[], duplicate);
    trace.push(`${sent.event} ${sha[0]} again=${again} duplicate=${duplicate}`);
  };

  const plain = async (step: string) => {
    const sha = pick(random, HEADS);
    const known = before([`check@${sha}`]);
    const r = await dispatch(h, authenticated({ sha }));
    if (!r.ok) return fail(step, `a dispatch answered ${r.status} ${r.code}`);
    expect(step, "dispatch", known, [r.executionId], r.duplicate);
    trace.push(`dispatch ${sha[0]} duplicate=${r.duplicate}`);
  };

  const keyed = async (step: string) => {
    const key = pick(random, ["build-1", "build-2"]);
    const sha = pick(random, HEADS.slice(0, 2));
    const r = await dispatch(
      h,
      authenticated({
        inputs: { sha },
        idempotency: { key, body: { inputs: { sha }, label: "ci" } },
      }),
    );
    const first = idem.get(key);
    trace.push(`keyed ${key} ${sha[0]} ${r.ok ? `duplicate=${r.duplicate}` : r.code}`);
    if (first === undefined) {
      if (!r.ok || r.duplicate) return fail(step, `a new key ${key} did not admit`);
      idem.set(key, { id: r.executionId, sha });
    } else if (first.sha === sha) {
      if (!r.ok || !r.duplicate || r.executionId !== first.id)
        return fail(
          step,
          `a reused ${key} with its body did not answer its execution as duplicate`,
        );
      reached.idemDuplicate++;
    } else {
      if (r.ok || r.status !== 409 || r.code !== "conflict" || r.executionId !== first.id)
        return fail(
          step,
          `a reused ${key} with another body did not answer 409 conflict naming it`,
        );
      reached.conflict++;
    }
  };

  for (let step = 0; step < 36; step++) {
    const s = `step ${step}`;
    const r = random();
    if (r < 0.5) await webhook(s);
    else if (r < 0.62) await plain(s);
    else if (r < 0.76) await keyed(s);
    else if (r < 0.9) {
      const ms = 5_000 + Math.floor(random() * 30_000);
      await h.adjust(ms);
      now += ms;
      trace.push(`advance ${ms}`);
    } else {
      const report = await h.run(releaseHeld());
      trace.push(`release ${JSON.stringify(report)} held=${count(h, "intake_held")}`);
    }
    reached.held = Math.max(reached.held, count(h, "intake_held"));
    // A replaced held request leaves at its release and is never admitted.
    for (const id of replaced) {
      if (h.executions().some((e) => e.id === id)) fail(s, `a replaced held request was admitted`);
      if (h.rows("select 1 from intake_held where execution_id = ?", id).length === 0)
        replaced.delete(id);
    }
    // Every key the model knows names one execution, admitted or held, and no request wrote another.
    const written = count(h, "executions") + count(h, "intake_held") - replaced.size;
    if (written !== commit.size + idem.size)
      fail(s, `${written} executions for ${commit.size + idem.size} keys`);
  }
  return { violations, reached, trace };
};

// ---------------------------------------------------------------------------
// FD-INT-004: the D1 admission transaction fails

/**
 * Pull request webhooks and dispatches for a few heads, where a seeded share of admission transactions fails at a
 * seeded statement inside the batch, as D1 fails one. A request whose transaction failed answers `503`
 * `intake_unavailable` and leaves no execution, dedup key, placement or intake record; the next delivery of the same
 * commit admits it, and every commit holds at most one execution.
 */
export const simulateAdmissionFailure = async (seed: number): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached = { unavailable: 0, admittedAfter: 0 };
  const h = await harness({
    repos: {
      [REPO]: repoWithManifest(
        manifest([{ recipe: "check", label: "ci", triggers: ["pull_request", "dispatch"] }]),
      ),
    },
  });
  // The next `faults` batches fail at one statement; the SQLite batch rolls the whole transaction back.
  let faults = 0;
  const batch = h.db.batch;
  h.db.batch = (statements: D1Statement[]) => {
    if (faults === 0) return batch(statements);
    faults--;
    const at = Math.floor(random() * statements.length);
    return batch(
      statements.map((s, i) =>
        i === at
          ? { ...s, all: () => Promise.reject(new Error("D1_ERROR: storage operation failed")) }
          : s,
      ),
    );
  };
  /** The execution each head admitted, and heads whose last request failed. */
  const admitted = new Map<string, string>();
  const failed = new Set<string>();
  let next = 0;
  const fail = (step: string, message: string) =>
    violations.push({ id: "FD-INT-004", message: `${step}: ${message}` });
  const rows = () =>
    ["executions", "dedup_keys", "placements", "intake_records"].map((t) => count(h, t)).join(",");

  for (let step = 0; step < 30; step++) {
    const s = `step ${step}`;
    const head = pick(random, HEADS);
    const viaWebhook = random() < 0.6;
    faults = random() < 0.4 ? 1 : 0;
    const armed = faults > 0;
    const before = rows();
    const answer = viaWebhook
      ? await deliver(h, "pull_request", pullRequestPayload({ head }), `d-${++next}`).then((r) =>
          r.status === 202
            ? { ok: true as const, id: (r.body.executions as string[])[0], dup: r.body.duplicate }
            : { ok: false as const, status: r.status, code: r.body.error },
        )
      : await dispatch(h, authenticated({ sha: head })).then((r) =>
          r.ok
            ? { ok: true as const, id: r.executionId, dup: r.duplicate }
            : { ok: false as const, status: r.status, code: r.code },
        );
    // A fault the admission transaction did not reach leaves nothing to check for it.
    const hit = armed && faults === 0;
    faults = 0;
    trace.push(
      `${viaWebhook ? "webhook" : "dispatch"} ${head[0]} fault=${hit} ${answer.ok ? `dup=${answer.dup === true}` : answer.status}`,
    );
    if (!answer.ok) {
      if (answer.status !== 503 || answer.code !== "intake_unavailable")
        fail(s, `a failed admission answered ${answer.status} ${String(answer.code)}`);
      if (!hit) fail(s, `a request with no D1 fault answered ${answer.status}`);
      if (rows() !== before) fail(s, `a failed admission wrote rows: ${before} -> ${rows()}`);
      if (!admitted.has(head)) failed.add(head);
      reached.unavailable++;
      continue;
    }
    const was = admitted.get(head);
    if (was === undefined) {
      if (answer.dup === true) fail(s, `the first admission of ${head[0]} answered duplicate`);
      if (failed.delete(head)) reached.admittedAfter++;
      admitted.set(head, answer.id!);
    } else if (answer.dup !== true || answer.id !== was)
      fail(s, `${head[0]} answered another execution than the one it admitted`);
    if (count(h, "executions") !== admitted.size)
      fail(s, `${count(h, "executions")} executions for ${admitted.size} heads`);
  }
  return { violations, reached, trace };
};

// ---------------------------------------------------------------------------
// FD-INT-019: the manifest read fails with a 5xx or stalls past 10 s

/** Lets the route's fiber run until it suspends: a few macrotask turns of the event loop. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * Waits until the route has called `key` more than `before` times, then settles, so the read's sleep and its 10 s
 * timeout are on the test clock before the clock moves. A clock advanced before they register never fires them.
 */
const started = async (calls: readonly string[], key: string, before: number) => {
  const count = () => calls.filter((c) => c === key).length;
  for (let i = 0; i < 10_000 && count() <= before; i++)
    await new Promise((r) => setTimeout(r, 0));
  await settle();
};

/**
 * Pull request webhooks whose manifest read answers at once, fails with a GitHub `5xx`, answers slowly within 10 s or
 * stalls past 10 s, pushes to the base branch that move the manifest's commit, and clock advances through the 10 min
 * manifest cache. The model keeps the cache. A read that fails or stalls submits nothing and records one `shed` row
 * with reason `manifest: unreadable`, and a stalled read gives up at 10 s, not before; a read that answers within
 * 10 s submits the run.
 */
export const simulateManifestRead = async (seed: number): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached = { failed: 0, stalled: 0, slow: 0, cached: 0 };
  const text = manifest([{ recipe: "check", label: "ci", triggers: ["pull_request"] }]);
  const h = await harness({ repos: { [REPO]: repoWithManifest(text) } });
  const repo = h.reads.repos[REPO]!;
  const fileKey = `file ${REPO}`;
  /** When each base commit's manifest was last read, as the 10 min cache keeps it. */
  const cache = new Map<string, number>();
  const admitted = new Set<string>();
  let now = NOW;
  let next = 0;
  let bases = 0;
  const fail = (step: string, message: string) =>
    violations.push({ id: "FD-INT-019", message: `${step}: ${message}` });

  for (let step = 0; step < 30; step++) {
    const s = `step ${step}`;
    const r = random();
    if (r < 0.15) {
      // A push to `main` moves the base commit the next pull request reads its manifest at.
      const base = (++bases).toString(16).padStart(40, "e");
      repo.branches.main = base;
      repo.files[`${base}:${MANIFEST_PATH}`] = text;
      trace.push(`base ${bases}`);
      continue;
    }
    if (r < 0.3) {
      const ms = Math.floor(random() * 6 * 60_000);
      await h.adjust(ms);
      now += ms;
      trace.push(`advance ${ms}`);
      continue;
    }
    const base = repo.branches.main!;
    const at = cache.get(base);
    const cached = at !== undefined && now - at < MANIFEST_CACHE_MS;
    const mode = pick(random, ["ok", "5xx", "slow", "stall"] as const);
    const delay =
      mode === "slow"
        ? 1 + Math.floor(random() * 9_000)
        : mode === "stall"
          ? 10_001 + Math.floor(random() * 50_000)
          : 0;
    if (mode === "5xx")
      h.reads.failures.set(
        fileKey,
        new GithubHttpError({
          status: 500 + Math.floor(random() * 5),
          message: "server error",
          rateLimited: false,
        }),
      );
    if (delay > 0) h.reads.delays.set(fileKey, delay);
    const head = pick(random, HEADS);
    const sheds = h.sheds().length;
    const executions = h.executions().length;
    const reads = h.reads.calls.filter((c) => c === fileKey).length;
    let done = false;
    const answer = deliver(h, "pull_request", pullRequestPayload({ head }), `d-${++next}`).then(
      (a) => ((done = true), a),
    );
    let elapsed = 0;
    if (!cached && delay > 0) {
      await started(h.reads.calls, fileKey, reads);
      // The read is in flight: a slow one answers at its delay, a stalled one is given up on at 10 s.
      const until = Math.min(delay, 10_000);
      await h.adjust(until - 1);
      await settle();
      if (done) fail(s, `a manifest read that waits ${delay} ms ended ${until - 1} ms in`);
      await h.adjust(1);
      elapsed = until;
    }
    const reply = await answer;
    now += elapsed;
    h.reads.failures.delete(fileKey);
    h.reads.delays.delete(fileKey);
    const unreadable = !cached && (mode === "5xx" || mode === "stall");
    trace.push(`deliver ${head[0]} ${mode} cached=${cached} unreadable=${unreadable}`);
    if (reply.status !== 202) fail(s, `a webhook answered ${reply.status}`);
    const newSheds = h.sheds().slice(sheds);
    if (unreadable) {
      if (mode === "stall") reached.stalled++;
      else reached.failed++;
      if (h.executions().length !== executions) fail(s, `an unreadable manifest submitted a run`);
      if ((reply.body.executions as unknown[] | undefined)?.length !== 0)
        fail(s, `an unreadable manifest answered executions`);
      if (
        newSheds.length !== 1 ||
        newSheds[0]!.reason !== "manifest: unreadable" ||
        newSheds[0]!.scope_id !== REPO ||
        newSheds[0]!.run !== null
      )
        fail(s, `an unreadable manifest recorded ${JSON.stringify(newSheds)}`);
      continue;
    }
    if (cached) reached.cached++;
    else {
      if (mode === "slow") reached.slow++;
      cache.set(base, now - elapsed);
    }
    if (newSheds.length > 0) fail(s, `a readable manifest recorded ${JSON.stringify(newSheds)}`);
    admitted.add(head);
    if (h.executions().length !== admitted.size)
      fail(s, `${h.executions().length} executions for ${admitted.size} admitted heads`);
  }
  return { violations, reached, trace };
};

// ---------------------------------------------------------------------------
// FD-INT-032: the missed-webhook sweep

const REQUIRED_NAMES = ["flare-dispatch/check:ci", "flare-dispatch/lint", "ci/build"];
/** Installation 7 serves two repositories, so its 100-pull-request cap spans them; 8 serves one. */
const SWEEP_REPOS: Record<string, number> = { "acme/app": 7, "acme/lib": 7, "acme/tool": 8 };

/**
 * Three repositories over two installations, each with 20 to 120 open pull requests updated at seeded times around the
 * 72 h edge, required sets per base branch, and check runs of this App and of another on their heads. Minute ticks move
 * the clock by a minute, ten minutes or hours, and between ticks heads gain check runs. Every planned unit runs, and so
 * does each unit that continues it. The model answers which heads a sweep submits: in each installation, the first 100
 * open pull requests updated in the last 72 h whose head lacks this App's check run for a `flare-dispatch/` name of its
 * base branch's required set. A sweep runs at every tenth minute and at no other, and submits a `webhook` trigger for
 * exactly those heads.
 */
export const simulateSweep = async (seed: number): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached = { sweeps: 0, submitted: 0, capped: 0, aged: 0, covered: 0, continued: 0 };
  const text = manifest([{ recipe: "check", label: "ci", triggers: ["pull_request"] }]);
  let heads = 0;
  const repos = Object.fromEntries(
    Object.keys(SWEEP_REPOS).map((name) => {
      const required = {
        main: REQUIRED_NAMES.filter(() => random() < 0.6),
        release: REQUIRED_NAMES.filter(() => random() < 0.3),
      };
      const pulls: PullSummary[] = [];
      const checkRuns: Record<string, CheckRunSummary[]> = {};
      const n = 20 + Math.floor(random() * 101);
      for (let i = 0; i < n; i++) {
        const sha = (++heads).toString(16).padStart(40, "0");
        const edge = random();
        // A third near the 72 h edge, either side of it; the rest anywhere in the last 90 h.
        const ago =
          edge < 0.33
            ? SWEEP_WINDOW_MS + (random() < 0.5 ? -1 : 1) * Math.floor(1 + random() * 600_000)
            : Math.floor(random() * 90 * 3_600_000);
        pulls.push({
          number: i + 1,
          updated_at: new Date(NOW - ago).toISOString(),
          head: { sha, ref: `f${i}`, repo: { full_name: name } },
          base: { ref: random() < 0.75 ? "main" : "release", repo: { full_name: name } },
        });
        checkRuns[sha] = REQUIRED_NAMES.filter(() => random() < 0.4).map((check, j) => ({
          id: heads * 10 + j,
          name: check,
          external_id: "x",
          app: { id: random() < 0.8 ? APP_ID : 1 },
        }));
      }
      return [
        name,
        repoWithManifest(text, {
          branches: { main: BASE, release: BASE },
          required,
          pulls,
          checkRuns,
        }),
      ];
    }),
  );
  const h = await harness({ repos, installations: SWEEP_REPOS });
  const fail = (step: string, message: string) =>
    violations.push({ id: "FD-INT-032", message: `${step}: ${message}` });

  /** The heads a sweep of `installation` at `now` submits, by the model. */
  const expected = (installation: number, now: number) => {
    const out = new Set<string>();
    let seen = 0;
    for (const name of Object.keys(SWEEP_REPOS).filter((r) => SWEEP_REPOS[r] === installation)) {
      const r = h.reads.repos[name]!;
      const recent = r.pulls.filter((p) => now - Date.parse(p.updated_at) <= SWEEP_WINDOW_MS);
      const taken = recent.slice(0, Math.max(0, 100 - seen));
      if (taken.length < recent.length) reached.capped++;
      reached.aged += r.pulls.length - recent.length;
      seen += taken.length;
      for (const p of taken) {
        const required = (r.required[p.base.ref] ?? []).filter((n) =>
          n.startsWith("flare-dispatch/"),
        );
        const ours = (r.checkRuns[p.head.sha] ?? []).filter((c) => c.app?.id === APP_ID);
        if (required.length === 0) continue;
        if (required.every((n) => ours.some((c) => c.name === n))) reached.covered++;
        else out.add(`${name}@${p.head.sha}`);
      }
    }
    return out;
  };

  let now = NOW;
  for (let step = 0; step < 14; step++) {
    const s = `step ${step}`;
    const units: TickUnit[] = [...planTick(now, [7, 8])];
    const sweeps = units.filter((u) => u._tag === "sweep");
    const due = new Date(now).getUTCMinutes() % 10 === 0;
    if (sweeps.length !== (due ? 2 : 0))
      fail(s, `minute ${new Date(now).getUTCMinutes()} planned ${sweeps.length} sweeps`);
    const want = new Map([7, 8].map((i) => [i, due ? expected(i, now) : new Set<string>()]));
    const got = new Map([7, 8].map((i) => [i, new Set<string>()]));
    for (let unit = units.shift(); unit !== undefined; unit = units.shift()) {
      const result = await h.run(runTickUnit(unit));
      if (result.next !== null) {
        units.push(result.next);
        reached.continued++;
      }
      if (unit._tag !== "sweep") continue;
      for (const id of result.outcome.executions) {
        const record = h.rows(
          "select repo, sha, trigger from intake_records where execution_id = ?",
          id,
        )[0];
        if (record === undefined) fail(s, `the sweep answered an execution with no record`);
        else {
          if (record.trigger !== "webhook")
            fail(s, `the sweep submitted a ${String(record.trigger)} trigger`);
          got.get(unit.installation)!.add(`${String(record.repo)}@${String(record.sha)}`);
        }
      }
    }
    for (const i of [7, 8]) {
      const w = [...want.get(i)!].sort();
      const g = [...got.get(i)!].sort();
      if (JSON.stringify(w) !== JSON.stringify(g))
        fail(
          s,
          `installation ${i} submitted ${g.length} heads where ${w.length} lack a required check run`,
        );
      reached.submitted += g.length;
    }
    if (due) reached.sweeps++;
    trace.push(
      `tick ${new Date(now).toISOString()} sweeps=${sweeps.length} submitted=${[...got.values()].reduce((n, g) => n + g.size, 0)}`,
    );
    // Between ticks a few heads gain a check run, of this App or of another.
    for (const r of Object.values(h.reads.repos))
      for (const p of r.pulls)
        if (random() < 0.05)
          (r.checkRuns[p.head.sha] ??= []).push({
            id: 0,
            name: pick(random, REQUIRED_NAMES),
            external_id: "y",
            app: { id: random() < 0.7 ? APP_ID : 1 },
          });
    const jump = random();
    const ms =
      jump < 0.35 ? 60_000 : jump < 0.75 ? 10 * 60_000 : Math.ceil(random() * 12) * 3_600_000;
    await h.adjust(ms);
    now += ms;
  }
  return { violations, reached, trace };
};

// ---------------------------------------------------------------------------
// FD-INT-053: the platform fires one minute's tick more than once

const SCHEDULES = ["* * * * *", "*/2 * * * *", "*/5 * * * *", "0 * * * *", "3-7 * * * *"];
const TICK_REPOS: Record<string, number> = { "acme/app": 7, "acme/lib": 7 };

/**
 * Two repositories whose manifests schedule `nightly` and `lint` on seeded cron expressions. The platform fires each
 * minute's tick one to three times, and some duplicates arrive minutes late, after later minutes' ticks; between ticks
 * some executions finish. Every firing's units run, and so does each unit that continues one. For each (run,
 * repository, scheduled minute) that a schedule matches there is exactly one execution, and a repeated firing answers
 * that execution as a duplicate.
 */
export const simulateDoubleTick = async (seed: number): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached = { refired: 0, late: 0, matched: 0 };
  const schedulesOf = new Map<string, Map<string, string[]>>();
  const repos = Object.fromEntries(
    Object.keys(TICK_REPOS).map((name) => {
      const runs = new Map<string, string[]>();
      for (const run of ["nightly", "lint"])
        runs.set(
          run,
          SCHEDULES.filter(() => random() < 0.4),
        );
      schedulesOf.set(name, runs);
      const entries = [...runs].map(([recipe, crons]) => ({
        recipe,
        triggers: ["cron"],
        schedules: crons.map((cron) => ({ cron })),
      }));
      return [name, repoWithManifest(manifest(entries))];
    }),
  );
  const h = await harness({ repos, installations: TICK_REPOS });
  const fail = (step: string, message: string) =>
    violations.push({ id: "FD-INT-053", message: `${step}: ${message}` });

  /** Whether a five-field expression of SCHEDULES matches `minute` past the hour; every one has `*` for the rest. */
  const matches = (cron: string, minute: number) => {
    const field = cron.split(" ")[0]!;
    if (field === "*") return true;
    if (field.startsWith("*/")) return minute % Number(field.slice(2)) === 0;
    if (field.includes("-")) {
      const [a, b] = field.split("-").map(Number);
      return minute >= a! && minute <= b!;
    }
    return minute === Number(field);
  };
  /** The (run, repository, minute) keys a minute's tick must create. */
  const expectedAt = (at: number) =>
    [...schedulesOf].flatMap(([repo, runs]) =>
      [...runs]
        .filter(([, crons]) => crons.some((c) => matches(c, new Date(at).getUTCMinutes())))
        .map(([run]) => `${run}:${repo}:cron:${new Date(at).toISOString()}`),
    );
  const want = new Set<string>();
  const fired = new Set<number>();

  const fire = async (s: string, at: number) => {
    const again = fired.has(at);
    fired.add(at);
    const units: TickUnit[] = planTick(at, [7]).filter((u) => u._tag === "schedules");
    const answered: string[] = [];
    let duplicate = true;
    for (let unit = units.shift(); unit !== undefined; unit = units.shift()) {
      const result = await h.run(runTickUnit(unit));
      if (result.next !== null) units.push(result.next);
      answered.push(...result.outcome.executions);
      if (result.outcome.executions.length > 0 && !result.outcome.duplicate) duplicate = false;
    }
    for (const k of expectedAt(at)) want.add(k);
    if (again) {
      reached.refired++;
      if (answered.length > 0 && !duplicate)
        fail(s, `a repeated tick for ${new Date(at).toISOString()} admitted`);
    }
    trace.push(`fire ${new Date(at).toISOString()} again=${again} answered=${answered.length}`);
  };

  const minute0 = Date.UTC(2026, 10, 4, 12, 0, 0);
  const late: number[] = [];
  for (let m = 0; m < 16; m++) {
    const s = `minute ${m}`;
    const at = minute0 + m * 60_000;
    const times = 1 + Math.floor(random() * 3);
    for (let i = 0; i < times; i++) await fire(s, at);
    if (random() < 0.4) late.push(at);
    // A duplicate of an earlier minute arrives after this minute's tick.
    if (late.length > 0 && random() < 0.5) {
      reached.late++;
      await fire(s, late.splice(Math.floor(random() * late.length), 1)[0]!);
    }
    // Some executions finish between ticks.
    for (const e of h.executions())
      if (e.status === "pending" && random() < 0.3)
        h.db.sqlite
          .prepare("update executions set status = 'success' where id = ?")
          .run(e.id as string);
    await h.adjust(60_000);
    const keys = h.rows(
      "select d.canonical, count(e.id) as n from dedup_keys d left join executions e on e.id = d.execution_id group by d.canonical",
    );
    const have = new Map(keys.map((k) => [k.canonical as string, Number(k.n)]));
    for (const k of want) if (have.get(k) !== 1) fail(s, `${k} has ${have.get(k) ?? 0} executions`);
    for (const k of have.keys())
      if (!want.has(k)) fail(s, `${k} has an execution no schedule matches`);
    if (count(h, "executions") !== want.size)
      fail(
        s,
        `${count(h, "executions")} executions for ${want.size} scheduled (run, repository, minute) keys`,
      );
  }
  reached.matched = want.size;
  return { violations, reached, trace };
};

/** Every scenario of this file, by name, as the test and the `sim` job run them. */
export const simulations: Readonly<Record<string, (seed: number) => Promise<SimOutcome>>> = {
  redelivery: simulateRedelivery,
  "admission-failure": simulateAdmissionFailure,
  "manifest-read": simulateManifestRead,
  sweep: simulateSweep,
  "double-tick": simulateDoubleTick,
};

const IDS: Readonly<Record<string, string>> = {
  redelivery: "FD-INT-003",
  "admission-failure": "FD-INT-004",
  "manifest-read": "FD-INT-019",
  sweep: "FD-INT-032",
  "double-tick": "FD-INT-053",
};

export const scenarios: readonly SimScenario[] = Object.entries(simulations).map(
  ([name, simulate]) => ({
    name,
    ids: [IDS[name]!],
    run: async (seed) => throwOnViolations((await simulate(seed)).violations),
  }),
);
