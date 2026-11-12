import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordingAlarms, sqliteDb, type TestDb } from "../d1.test-support.ts";
import { raiseOnce, resolveAlarm } from "../raise.ts";
import {
  axiomFindings,
  axiomsProgram,
  forbiddenTerms,
  proofCounts,
  regressionsAppendOnly,
  theoremNames,
  toolchainPinned,
} from "./formal.ts";
import { killLineAlarms, phaseGate, type PhaseGateInput } from "./phase-gate.ts";
import {
  fetchPhaseGateRecords,
  GATE_WINDOW_MS,
  liveAlarmPhases,
  pageAlarmRecords,
  phaseGateRecords,
  type PhaseGateRecords as Records,
} from "./records.ts";
import { allRequirements, type Requirement } from "./spec-tags.ts";

const ROOT = join(import.meta.dirname, "../../../..");

describe("formal gate", () => {
  it("[FD-VER-014] formal/lean-toolchain pins one exact Lean release", () => {
    expect(toolchainPinned(readFileSync(join(ROOT, "formal/lean-toolchain"), "utf8"))).toBe(true);
    expect(toolchainPinned("leanprover/lean4:stable")).toBe(false);
    expect(toolchainPinned("leanprover/lean4:v4.35.0-rc1")).toBe(false);
  });

  it("[FD-VER-015] sorry, admit, native_decide or an axiom declaration fails naming file and line; comments do not", () => {
    const text = [
      "-- sorry in a comment is fine",
      "/- admit here too -/",
      "theorem a : True := by sorry",
      "axiom choice' : False",
      "theorem b : 2 = 2 := by native_decide",
    ].join("\n");
    expect(forbiddenTerms("formal/X.lean", text).map((f) => [f.line, f.message])).toEqual([
      [3, "sorry in a formal/ file"],
      [4, "axiom in a formal/ file"],
      [5, "native_decide in a formal/ file"],
    ]);
    expect(
      forbiddenTerms(
        "formal/FdFormal/Basic.lean",
        readFileSync(join(ROOT, "formal/FdFormal/Basic.lean"), "utf8"),
      ),
    ).toEqual([]);
  });

  it("[FD-VER-016] a theorem whose axioms go beyond propext, Classical.choice and Quot.sound fails", () => {
    expect(theoremNames("namespace A\ntheorem t : True := trivial\nend A")).toEqual(["A.t"]);
    expect(axiomsProgram("FdFormal", ["A.t"])).toBe("import FdFormal\n#print axioms A.t");
    const output = [
      "'A.t' depends on axioms: [propext, Classical.choice, Quot.sound]",
      "'A.u' depends on axioms: [propext, sorryAx]",
      "'A.v' does not depend on any axioms",
    ].join("\n");
    expect(axiomFindings(output).map((f) => f.message)).toEqual(["A.u depends on axiom sorryAx"]);
  });

  it("[FD-VER-018] a proof counts only while its theorem passes and every assumption test of its row passes", () => {
    const passing = new Set(["FD-AGT-009", "FD-AGT-012"]);
    expect(
      proofCounts({
        theoremPassed: true,
        assumptionTests: ["FD-AGT-009", "FD-AGT-012"],
        passingTests: passing,
      }),
    ).toBe(true);
    expect(
      proofCounts({
        theoremPassed: true,
        assumptionTests: ["FD-AGT-009", "FD-AGT-013"],
        passingTests: passing,
      }),
    ).toBe(false);
    expect(proofCounts({ theoremPassed: false, assumptionTests: [], passingTests: passing })).toBe(
      false,
    );
  });

  it("[FD-VER-022] a pull request that removes or changes a regression line fails; appending passes", () => {
    const base = '{"seed":1}\n{"seed":2}\n';
    expect(regressionsAppendOnly(base, `${base}{"seed":3}\n`)).toEqual([]);
    expect(regressionsAppendOnly(base, '{"seed":1}\n')).toHaveLength(1);
    expect(regressionsAppendOnly(base, '{"seed":1}\n{"seed":9}\n')).toHaveLength(1);
  });
});

const req = (id: string, phase: number, tags: string[]): Requirement => ({
  id,
  area: id.split("-")[1]!,
  number: Number(id.split("-")[2]),
  phase,
  tags,
  sentence: "The x must y.",
  file: "operability.md",
  line: 1,
});

const gate = (over: Partial<PhaseGateInput> = {}): PhaseGateInput => ({
  from: 0,
  to: 1,
  requirements: [
    req("FD-OPS-053", 0, ["V-UNIT"]),
    req("FD-OPS-038", 0, ["V-LIVE"]),
    req("FD-OPS-071", 1, ["V-UNIT"]),
  ],
  passing: [{ id: "FD-OPS-053", tag: "V-UNIT", file: "x.test.ts" }],
  nightly: { conf: true, sim: true, "e2e-local": true, diff: true },
  measures: [{ name: "warm-run", holds: true, detail: "" }],
  alarms: [],
  killLines: [],
  windowEnd: 10 * 86_400_000,
  ...over,
});
const checks = (i: PhaseGateInput) => phaseGate(i).map((f) => f.check);

describe("phase gate", () => {
  it("[FD-VER-026] every requirement of phase n or lower needs a passing entry per tag, V-LIVE and V-MEASURE aside", () => {
    expect(phaseGate(gate())).toEqual([]);
    expect(phaseGate(gate({ passing: [] })).map((f) => f.message)).toEqual([
      "FD-OPS-053 has no passing V-UNIT entry",
    ]);
    expect(checks(gate({ to: 2 }))).toEqual(["FD-VER-026"]);
  });

  it("[FD-VER-027] the nightly conf, sim, e2e-local and diff runs must have passed", () => {
    expect(
      phaseGate(gate({ nightly: { conf: true, sim: false, diff: true } })).map((f) => f.message),
    ).toEqual(["nightly sim failed", "nightly e2e-local has no record"]);
  });

  it("[FD-VER-028] every V-MEASURE threshold of gate n must hold, read from the control plane's record", () => {
    expect(
      checks(gate({ measures: [{ name: "warm-run", holds: false, detail: "22% faster" }] })),
    ).toEqual(["FD-VER-028"]);
    expect(checks(gate({ measures: null }))).toEqual(["FD-VER-028"]);
  });

  it("[FD-VER-029] a V-LIVE page alarm unresolved for more than 24 h in the window fails", () => {
    const day = 86_400_000;
    expect(
      checks(
        gate({
          alarms: [{ name: "canary-missed", requirementPhase: 0, raisedAt: 0, resolvedAt: day }],
        }),
      ),
    ).toEqual([]);
    expect(
      checks(
        gate({
          alarms: [
            { name: "canary-missed", requirementPhase: 0, raisedAt: 0, resolvedAt: day + 1 },
          ],
        }),
      ),
    ).toEqual(["FD-VER-029"]);
    expect(
      checks(gate({ alarms: [{ name: "x", requirementPhase: 0, raisedAt: 0, resolvedAt: null }] })),
    ).toEqual(["FD-VER-029"]);
  });

  it("[FD-VER-030] a crossed kill line raises kill-line naming the risk, the metric, its value and the threshold", () => {
    expect(
      killLineAlarms([
        {
          risk: "warm state",
          metric: "median time to verdict",
          value: 0.2,
          threshold: 0.3,
          crossed: true,
        },
        { risk: "toil", metric: "interventions", value: 0, threshold: 1, crossed: false },
      ]),
    ).toEqual([
      {
        name: "kill-line",
        severity: "notify",
        dedupeKey: "kill-line:warm state",
        detail: {
          risk: "warm state",
          metric: "median time to verdict",
          value: 0.2,
          threshold: 0.3,
        },
      },
    ]);
  });

  it("[FD-VER-031] an unresolved kill-line notification fails the gate for every phase above the current one", () => {
    expect(checks(gate({ killLines: ["warm state"] }))).toEqual(["FD-VER-031"]);
    expect(checks(gate({ killLines: null }))).toEqual(["FD-VER-031"]);
  });
});

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

describe("phase-gate records from the control plane", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await sqliteDb();
  });
  afterEach(() => t.dispose());

  let n = 0;
  /** One finished execution and its accepted placement: `ms` from enqueue to verdict, accepted on `kind`. */
  const verdict = async (
    run: string,
    kind: string,
    ms: number,
    over: { cls?: string; finishedAt?: number; status?: string } = {},
  ) => {
    const id = `e${n++}`;
    const finishedAt = over.finishedAt ?? NOW - DAY;
    await t.db
      .prepare(
        "insert into executions (id, scope_id, run, class, status, enqueued_at, finished_at) values (?, 'acme/app', ?, ?, ?, ?, ?)",
      )
      .bind(id, run, over.cls ?? "required", over.status ?? "success", finishedAt - ms, finishedAt)
      .run();
    await t.db
      .prepare(
        "insert into placements (execution_id, state, epoch, accepted_kind) values (?, 'accepted', 1, ?)",
      )
      .bind(id, kind)
      .run();
  };
  const cacheLookups = () =>
    t.db
      .prepare(
        `create table if not exists cache_lookups (execution_id text not null, executor_kind text not null,
         level text not null, tier text, hit integer not null, bytes integer not null, at integer not null)`,
      )
      .run();
  const lookup = (kind: string, hit: boolean, at = NOW - DAY) =>
    t.db
      .prepare(
        "insert into cache_lookups (execution_id, executor_kind, level, tier, hit, bytes, at) values ('e', ?, 'L2', ?, ?, 0, ?)",
      )
      .bind(kind, hit ? "repo" : null, hit ? 1 : 0, at)
      .run();
  const records = (gate = 0, now = NOW) => Effect.runPromise(phaseGateRecords(t.db, gate, now));
  const measure = (r: Records, name: string) => r.measures.find((m) => m.name === name)!;
  const page = (name: string) => ({
    name,
    severity: "page" as const,
    dedupeKey: name,
    detail: null,
  });
  const alarms = recordingAlarms();
  const raise = (name: string, at: number) =>
    Effect.runPromise(raiseOnce(t.db, page(name), at).pipe(Effect.provide(alarms.layer)));
  const resolve = (name: string, at: number) =>
    Effect.runPromise(resolveAlarm(t.db, page(name), at).pipe(Effect.provide(alarms.layer)));

  it("[FD-VER-028] gate 0's warm-run threshold reads each required run's median time to verdict per executor kind from the executions table", async () => {
    // check: device median 60 s against the best cloud setup's 100 s (aws), 40% below.
    for (const ms of [50_000, 60_000, 70_000]) await verdict("check", "device", ms);
    for (const ms of [100_000, 100_000, 120_000]) await verdict("check", "aws", ms);
    for (const ms of [150_000, 160_000]) await verdict("check", "cloudflare", ms);
    // Outside the window, another class, or no verdict: not read.
    await verdict("check", "device", 900_000, { finishedAt: NOW - GATE_WINDOW_MS - 1 });
    await verdict("check", "device", 900_000, { cls: "batch" });
    await verdict("check", "device", 900_000, { status: "cancelled" });
    const ok = measure(await records(), "warm-verdict");
    expect(ok).toEqual({
      name: "warm-verdict",
      holds: true,
      detail: "check: device median 60.0 s, best cloud aws 100.0 s, 40% below",
    });

    // lint: device median 80 s against 100 s, only 20% below; the gate fails on it.
    for (const ms of [80_000, 80_000]) await verdict("lint", "device", ms);
    await verdict("lint", "cloudflare", 100_000);
    const r = await records();
    expect(measure(r, "warm-verdict")).toMatchObject({
      holds: false,
      detail: "lint: device median 80.0 s, best cloud cloudflare 100.0 s, 20% below",
    });
    const input = gate({ measures: r.measures, killLines: r.killLines });
    expect(phaseGate(input).map((f) => f.message)).toContain(
      "warm-verdict: lint: device median 80.0 s, best cloud cloudflare 100.0 s, 20% below",
    );
  });

  it("[FD-VER-028] with no device verdict, no cache report or an unresolved estimate-drift, a gate 0 threshold does not hold", async () => {
    await verdict("check", "aws", 100_000);
    let r = await records();
    expect(r.measures.map((m) => [m.name, m.holds])).toEqual([
      ["warm-verdict", false],
      ["cache-hit-rate", false],
      ["estimate-drift", true],
    ]);
    expect(measure(r, "warm-verdict").detail).toBe(
      "no required run reached a verdict on an owned device in the window",
    );
    expect(measure(r, "cache-hit-rate").detail).toBe("the cache lookups cannot be read");

    await verdict("check", "device", 10_000);
    await cacheLookups();
    expect(measure(await records(), "cache-hit-rate").detail).toBe(
      "no cache lookup in the last 28 days",
    );
    await lookup("device", true);
    await lookup("device", false);
    await lookup("aws", false, NOW - 29 * DAY);
    await Effect.runPromise(
      raiseOnce(
        t.db,
        {
          name: "estimate-drift",
          severity: "notify",
          dedupeKey: "estimate-drift:check:aws",
          detail: null,
        },
        NOW - DAY,
      ).pipe(Effect.provide(alarms.layer)),
    );
    r = await records();
    expect(r.measures).toEqual([
      expect.objectContaining({ name: "warm-verdict", holds: true }),
      { name: "cache-hit-rate", holds: true, detail: "device L2 miss: 0/2; device L2 repo: 1/2" },
      {
        name: "estimate-drift",
        holds: false,
        detail: "unresolved: estimate-drift:check:aws",
      },
    ]);
    expect(phaseGate(gate({ measures: r.measures })).map((f) => f.check)).toEqual(["FD-VER-028"]);
    // A gate whose thresholds this control plane does not measure cannot pass.
    expect((await records(1)).measures).toEqual([
      {
        name: "gate-1",
        holds: false,
        detail: "this control plane measures no threshold of gate 1",
      },
    ]);
  });

  it("[FD-VER-029] the records carry each page alarm's raise-to-resolve span in the window, and the gate fails on one over 24 h", async () => {
    const start = NOW - GATE_WINDOW_MS;
    // Raised before the window and resolved 2 h into it: counted from the window start.
    await raise("canary-missed", start - 3 * DAY);
    await resolve("canary-missed", start + 2 * 3_600_000);
    // Raised again later: a new span, not one counted from the first raise.
    await raise("canary-missed", NOW - 3 * DAY);
    await resolve("canary-missed", NOW - 3 * DAY + 3_600_000);
    // Open for 30 h at the window end.
    await raise("installation-lost", NOW - 30 * 3_600_000);
    // Resolved before the window: outside it.
    await raise("drift", start - 5 * DAY);
    await resolve("drift", start - 4 * DAY);
    const r = await records();
    expect(r.windowStart).toBe(start);
    expect(r.pageAlarms).toEqual([
      {
        name: "canary-missed",
        dedupeKey: "canary-missed",
        raisedAt: start,
        resolvedAt: start + 2 * 3_600_000,
      },
      {
        name: "canary-missed",
        dedupeKey: "canary-missed",
        raisedAt: NOW - 3 * DAY,
        resolvedAt: NOW - 3 * DAY + 3_600_000,
      },
      {
        name: "installation-lost",
        dedupeKey: "installation-lost",
        raisedAt: NOW - 30 * 3_600_000,
        resolvedAt: null,
      },
    ]);
    const requirements = [
      {
        ...req("FD-OPS-040", 0, ["V-LIVE"]),
        sentence:
          "If the canary fails, then the control plane must raise the page alarm `canary-missed`.",
      },
      {
        ...req("FD-OPS-042", 0, ["V-LIVE", "V-UNIT"]),
        sentence:
          "If an installation read fails, then raise the page alarm `installation-lost` naming the login.",
      },
    ];
    const alarmsRead = pageAlarmRecords(r.pageAlarms, requirements);
    expect(alarmsRead.map((a) => [a.name, a.requirementPhase])).toEqual([
      ["canary-missed", 0],
      ["canary-missed", 0],
      ["installation-lost", 0],
    ]);
    expect(
      phaseGate(gate({ alarms: alarmsRead, windowEnd: r.windowEnd })).map((f) => f.message),
    ).toEqual(["installation-lost stayed unresolved for more than 24 h"]);
    await resolve("installation-lost", NOW - 10 * 3_600_000);
    const resolved = await records();
    expect(
      phaseGate(
        gate({
          alarms: pageAlarmRecords(resolved.pageAlarms, requirements),
          windowEnd: resolved.windowEnd,
        }),
      ),
    ).toEqual([]);
  });

  it("[FD-VER-029] the gate reads only the alarms a V-LIVE requirement names, at that requirement's phase", () => {
    const phases = liveAlarmPhases(allRequirements(readSpecsUnder(join(ROOT, "specs"))));
    expect(phases.get("canary-missed")).toBe(0);
    expect(phases.get("installation-lost")).toBe(0);
    expect(phases.get("neutral-invariant")).toBe(0);
    expect(phases.get("p0-breach")).toBe(0);
    expect(phases.has("estimate-drift")).toBe(false);
    const episode = { dedupeKey: "k", raisedAt: 0, resolvedAt: null };
    expect(
      pageAlarmRecords(
        [
          { ...episode, name: "canary-missed" },
          { ...episode, name: "not-a-live-alarm" },
        ],
        [
          {
            ...req("FD-PROV-035", 4, ["V-LIVE"]),
            sentence: "raise the page alarm `canary-missed`.",
          },
        ],
      ),
    ).toEqual([{ name: "canary-missed", requirementPhase: 4, raisedAt: 0, resolvedAt: null }]);
  });

  it("[FD-VER-028] [FD-VER-029] the phase-gate job fetches gate n's records with an Access service token and refuses another gate's", async () => {
    const body: Records = {
      gate: 0,
      windowStart: NOW - GATE_WINDOW_MS,
      windowEnd: NOW,
      measures: [{ name: "warm-verdict", holds: true, detail: "" }],
      pageAlarms: [],
      killLines: [],
    };
    const seen: { url: string; headers: Headers }[] = [];
    const fetcher = (answer: Response) =>
      (async (url: string, init?: RequestInit) => {
        seen.push({ url, headers: new Headers(init?.headers) });
        return answer;
      }) as typeof fetch;
    const source = (answer: Response) => ({
      origin: "https://dispatch.example.com/",
      clientId: "cid.access",
      clientSecret: "secret",
      fetch: fetcher(answer),
    });
    expect(await Effect.runPromise(fetchPhaseGateRecords(source(Response.json(body)), 0))).toEqual(
      body,
    );
    expect(seen[0]!.url).toBe("https://dispatch.example.com/v1/ops/phase-gate?gate=0");
    expect(seen[0]!.headers.get("CF-Access-Client-Id")).toBe("cid.access");
    expect(seen[0]!.headers.get("CF-Access-Client-Secret")).toBe("secret");
    const failure = (answer: Response, gate = 0) =>
      Effect.runPromise(
        fetchPhaseGateRecords(source(answer), gate).pipe(
          Effect.match({ onFailure: (e) => e.reason, onSuccess: () => "read" }),
        ),
      );
    expect(await failure(Response.json(body), 1)).toBe("asked for gate 1, answered gate 0");
    expect(await failure(new Response("no", { status: 403 }))).toBe(
      "https://dispatch.example.com/v1/ops/phase-gate?gate=0 answered 403",
    );
    expect(await failure(Response.json({ ...body, measures: null }))).toContain("measures");
  });
});

const readSpecsUnder = (dir: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const name of readdirSync(dir, { recursive: true }) as string[])
    if (name.endsWith(".md")) out.set(name, readFileSync(join(dir, name), "utf8"));
  return out;
};
