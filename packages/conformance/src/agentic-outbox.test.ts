// An agentic result's repository writes on the composed control plane: the control plane Worker under workerd through
// Miniflare, its D1 database, its `ExecutorChannel` and `ExecutionEngine` objects. A device holds an execution's lease
// over a signed socket and reports a write of each run-authored kind as an `exec.intents` batch, then a `success`
// result; the channel stages the batch and the engine's apply-outbox step turns the accepted epoch's intents into
// outbox rows. mameko's drainer then applies those rows through the control plane's actuators (`writebackApplier` over
// a GitHub in memory), the only place a repository write happens (specs/runs/agentic.md FD-AGT-009).
//
// `pr.propose` is a control-plane kind (specs/profile.md § Intent kinds): its row is the `prProposePayload` binding's
// answer for the accepted result, never an executor's batch. mameko at the pinned commit runs no binding at accept, so
// the scenario stages that answer for the lease's epoch the way the binding would.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  GitData,
  prProposePayload,
  WRITE_KINDS,
  writebackRecordsLayer,
  type Manifest,
} from "@fractalboxdev/flare-dispatch-agentic";
import { artifactPath } from "@fractalboxdev/flare-dispatch-cache";
import { profile } from "@fractalboxdev/flare-dispatch-profile";
import { actuatorBindings, drainOnce } from "@fractalboxdev/mameko-coordinator";
import { d1OutboxStore, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import {
  ActuatorRateLimit,
  Actuators,
  actuatorRegistry,
  type IntentRow,
} from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { build } from "esbuild";
import { fetch as mfFetch, Miniflare, type Request as MfRequest } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writebackApplier } from "../../../apps/control-plane/src/agentic.ts";
import {
  AUD,
  connect,
  endStandingClaim,
  hello,
  newDevice,
  OPERATOR,
  PLANE,
  registration,
  startAccessTeam,
  type AccessTeam,
} from "../../../apps/control-plane/test/support.ts";

const REPO = "fractalboxdev/flare-dispatch";
const [OWNER, NAME] = REPO.split("/") as [string, string];
const APP_LOGIN = "flare-dispatch[bot]";
const SPEC_DRIFT_BRANCH = "flare-dispatch/spec-drift";

const DEV_REPOSITORY = {
  repository: REPO,
  installation: 1,
  default_branch: "main",
  head: "f".repeat(40),
  confidentiality: "non-confidential",
  files: {
    ".github/flare-dispatch.json": readFileSync(
      join(import.meta.dirname, "../../../.github/flare-dispatch.json"),
    ).toString("base64"),
  },
};

const GITHUB_HOSTS: ReadonlySet<string> = new Set(["api.github.com", "github.com"]);

let team: AccessTeam;
let plane: Miniflare;
/** Every request the Worker addressed to GitHub. */
const githubRequests: string[] = [];

beforeAll(async () => {
  team = await startAccessTeam();
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "../../../apps/control-plane/src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  plane = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: bundle.outputFiles[0]!.text }],
    compatibilityDate: "2026-05-01",
    d1Databases: { DB: "control-plane" },
    durableObjects: {
      CHANNEL: { className: "ExecutorChannel", useSQLite: true },
      EXECUTION: { className: "ExecutionEngine", useSQLite: true },
      EPOCH_ANCHOR: { className: "EpochAnchor", useSQLite: true },
      MONITOR: { className: "LivenessMonitor", useSQLite: true },
    },
    r2Buckets: ["CACHE"],
    bindings: {
      DEPLOYMENT: "development",
      PLANE_ID: PLANE,
      ACCESS_TEAM_DOMAIN: team.teamDomain,
      ACCESS_AUD: AUD,
      OPERATORS: JSON.stringify([OPERATOR]),
      DISPATCHERS: JSON.stringify([OPERATOR]),
      FD_DEV_REPOSITORY: JSON.stringify(DEV_REPOSITORY),
    },
    // A request to GitHub is recorded and answered 503; the Access team's keys go out as addressed.
    outboundService: async (request: MfRequest) => {
      if (!GITHUB_HOSTS.has(new URL(request.url).host)) return mfFetch(request);
      githubRequests.push(`${request.method} ${request.url}`);
      return new Response("GitHub is not reachable from this suite", {
        status: 503,
      }) as never;
    },
  });
  await plane.ready;
}, 120_000);

afterAll(async () => {
  await plane?.dispose();
  await team?.close();
});

const db = async () => (await plane.getD1Database("DB")) as unknown as D1Like;

/** A dispatched execution leased to a fresh device over the control plane's socket. */
const lease = async () => {
  const executorId = "conf-agentic-outbox";
  const device = await newDevice();
  const headers = {
    "content-type": "application/json",
    "cf-access-jwt-assertion": await team.jwt(OPERATOR),
  };
  const enrolled = await plane.dispatchFetch("http://x/v1/executors/register", {
    method: "POST",
    headers,
    body: JSON.stringify(registration(executorId, device.identity)),
  });
  expect(enrolled.status).toBe(201);
  const sha = "a".repeat(40);
  const admitted = await plane.dispatchFetch("http://x/v1/dispatch/check", {
    method: "POST",
    headers,
    body: JSON.stringify({
      repository: REPO,
      sha,
      inputs: {
        repo: `https://github.com/${REPO}`,
        sha,
        ref: "main",
        steps: [{ label: "test", command: "true" }],
      },
    }),
  });
  expect(admitted.status).toBe(202);
  const { execution_id: id } = (await admitted.json()) as { execution_id: string };
  const socket = await connect(plane, executorId, device.keys);
  socket.send(hello(executorId));
  await socket.next("session.welcome");
  socket.send({
    type: "exec.claim",
    id: "c1",
    free: { release: 1, required: 1, interactive: 1, batch: 1 },
  });
  const granted = await socket.next("exec.lease");
  expect(granted["execution_id"]).toBe(id);
  await endStandingClaim(socket);
  return { socket, id, epoch: granted["epoch"] as number };
};

const repo = { owner: OWNER, name: NAME };

/** One payload per run-authored write kind, as the agentic recipes write them. */
const RUN_WRITES: Readonly<Record<string, unknown>> = {
  comment: { repo, number: 7, body: "Two findings." },
  review: { repo, number: 7, event: "COMMENT", body: "Review.", comments: [] },
  issue: { repo, title: "Flaky test", body: "Seen twice." },
  label: { repo, number: 7, labels: ["triage"] },
  "pr.close": { repo, branch: SPEC_DRIFT_BRANCH, base: "main", pull: 5 },
  "release.draft": { repo, tag: "v1.2.0", name: "v1.2.0", body: "Notes." },
  "release.publish": { repo, tag: "v1.2.0" },
};

const MANIFEST: Manifest = {
  baseCommit: "b".repeat(40),
  branch: SPEC_DRIFT_BRANCH,
  baseBranch: "main",
  message: "docs(specs): reconcile the specs with the code",
  pr: { title: "Reconcile the specs", body: "Drift.", draft: true, labels: ["spec-drift"] },
  entries: [],
};

interface OutboxRow {
  readonly intent_key: string;
  readonly kind: string;
  readonly state: string;
}

const outboxOf = async (id: string) =>
  (
    await (
      await db()
    )
      .prepare("select intent_key, kind, state from outbox where execution_id = ? order by id")
      .bind(id)
      .all()
  ).results as unknown as readonly OutboxRow[];

/** The outbox once the engine's apply-outbox step has written the execution's outcome row. */
const appliedOutbox = async (id: string) => {
  for (let i = 0; i < 500; i++) {
    const rows = await outboxOf(id);
    if (rows.some((r) => r.kind === "check.conclude")) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no outcome row for ${id}`);
};

/** A GitHub in memory: each actuator's apply and each Git Data call is one recorded write or read. */
const memoryGithub = () => {
  const writes: { readonly via: string; readonly kind: string; readonly key: string }[] = [];
  const actuator = (name: string) => ({
    apply: (row: IntentRow) =>
      Effect.sync(() => {
        writes.push({ via: `actuator:${name}`, kind: row.kind, key: row.intentKey });
        return { _tag: "applied" as const, externalRef: `${name}:${row.intentKey}` };
      }),
    lookup: () => Effect.succeed({ _tag: "absent" as const }),
    reconcile: () => Effect.succeed({ _tag: "absent" as const }),
  });
  const names = [...new Set(Object.values(profile.intent_kinds).map((k) => k.actuator))];
  const write =
    <A>(call: string, a: A) =>
    () =>
      Effect.sync(() => (writes.push({ via: `git:${call}`, kind: "", key: "" }), a));
  const git = Layer.succeed(GitData, {
    defaultBranch: () => Effect.succeed("main"),
    branchProtected: (_r, branch) => Effect.succeed(branch === "main"),
    refSha: () => Effect.succeed(null),
    commitsSince: () => Effect.succeed([]),
    commit: (_r, sha) =>
      Effect.succeed({ sha, message: "base", authorLogin: APP_LOGIN, tree: `tree-${sha}` }),
    fileAt: () => Effect.succeed(null),
    createBlob: write("createBlob", "blob"),
    createTree: write("createTree", "tree"),
    createCommit: write("createCommit", "c".repeat(40)),
    createRef: write("createRef", undefined),
    updateRef: write("updateRef", undefined),
    openPull: (_r, head) =>
      Effect.succeed(
        head === SPEC_DRIFT_BRANCH
          ? { number: 5, url: `https://github.com/${REPO}/pull/5`, head }
          : null,
      ),
    createPull: write("createPull", {
      number: 9,
      url: `https://github.com/${REPO}/pull/9`,
      head: SPEC_DRIFT_BRANCH,
    }),
    updatePull: write("updatePull", undefined),
    addLabels: write("addLabels", undefined),
    closePull: write("closePull", undefined),
  });
  const actuators = Layer.succeed(
    Actuators,
    actuatorRegistry(Object.fromEntries(names.map((n) => [n, actuator(n)]))),
  );
  return { writes, git, actuators };
};

const permits = Layer.succeed(ActuatorRateLimit, {
  acquire: () => Effect.succeed({ _tag: "granted" as const, permitId: "p" }),
  release: () => Effect.void,
});

/** mameko's drainer over the Worker's outbox, through the actuators `composition.ts` composes. */
const drain = async (github: ReturnType<typeof memoryGithub>) => {
  const d1 = await db();
  const actuators = writebackApplier(APP_LOGIN).pipe(
    Layer.provide(
      Layer.mergeAll(
        github.actuators,
        github.git,
        writebackRecordsLayer({
          db: d1,
          artifacts: (await plane.getR2Bucket("CACHE")) as never,
          artifactPath,
          issuedCredentials: () => Effect.succeed([]),
        }),
      ),
    ),
  );
  await Effect.runPromise(
    drainOnce({
      now: Date.now() + 60_000,
      token: () => "t",
      random: () => 0.5,
      actuatorOf: actuatorBindings(profile.intent_kinds),
    }).pipe(Effect.provide(Layer.mergeAll(actuators, d1OutboxStore(d1), permits))),
  );
};

describe("an agentic result's repository writes on the composed control plane", () => {
  it("[FD-AGT-009] become outbox rows of exactly the result's write kinds, each applied only through an outbox applier", async () => {
    // The eight write kinds: seven the run authors and pr.propose, which the control plane authors.
    expect([...Object.keys(RUN_WRITES), "pr.propose"].sort()).toEqual([...WRITE_KINDS].sort());
    for (const kind of Object.keys(RUN_WRITES))
      expect(profile.intent_kinds[kind]?.origin, kind).toBe("run");
    expect(profile.intent_kinds["pr.propose"]?.origin).toBe("control-plane");

    const { socket, id, epoch } = await lease();
    const intents = Object.entries(RUN_WRITES).map(([kind, payload], i) => ({
      intent_key: `${kind}:${i}`,
      kind,
      payload,
    }));

    // An executor's batch naming pr.propose is rejected whole, and stages nothing.
    socket.send({
      type: "exec.intents",
      id: "i0",
      execution_id: id,
      epoch,
      batch_seq: 0,
      intents: [{ intent_key: "propose:0", kind: "pr.propose", payload: { repo } }],
    });
    expect(await socket.next("exec.intents.ack")).toMatchObject({ ref: "i0", status: "rejected" });

    socket.send({
      type: "exec.intents",
      id: "i1",
      execution_id: id,
      epoch,
      batch_seq: 1,
      intents,
    });
    expect(await socket.next("exec.intents.ack")).toMatchObject({ ref: "i1", status: "accepted" });
    const d1 = await db();
    const staged = (
      await d1
        .prepare(
          "select intent_key, kind, epoch, committed from staged_intents where execution_id = ? order by intent_key",
        )
        .bind(id)
        .all()
    ).results as unknown as readonly {
      intent_key: string;
      kind: string;
      epoch: number;
      committed: number;
    }[];
    expect(staged.map((s) => [s.intent_key, s.kind, s.epoch, s.committed])).toEqual(
      intents
        .map((i) => [`run:${i.intent_key}`, i.kind, epoch, 0])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );

    // The `prProposePayload` binding's answer for a success result with a staged write, at the lease's epoch.
    const proposal = prProposePayload({
      executionId: id,
      run: "spec-drift-pr",
      repo,
      outcome: "success",
      stagedWrite: MANIFEST,
    });
    if (proposal._tag !== "payload") throw new Error("expected a pr.propose payload");
    const json = JSON.stringify(proposal.payload);
    await d1
      .prepare(
        `insert into staged_intents (execution_id, epoch, intent_key, kind, limit_key, payload_json, payload_digest, effect_class)
         values (?, ?, 'cp:pr:propose', 'pr.propose', ?, ?, ?, ?)`,
      )
      .bind(
        id,
        epoch,
        REPO,
        json,
        createHash("sha256").update(json).digest("hex"),
        profile.intent_kinds["pr.propose"]!.effect_class,
      )
      .run();

    // No outbox row exists before the result is accepted.
    expect((await outboxOf(id)).filter((r) => r.kind !== "check.open")).toEqual([]);

    socket.send({
      type: "exec.result",
      id: "r1",
      execution_id: id,
      epoch,
      result_id: `${id}:${epoch}`,
      outcome: { status: "success" },
      usage: {},
      artifacts: [],
    });
    expect(await socket.next("exec.result.ack")).toMatchObject({ status: "accepted" });

    const rows = await appliedOutbox(id);
    const writes = rows.filter((r) => (WRITE_KINDS as readonly string[]).includes(r.kind));
    expect(writes.map((r) => r.kind).sort()).toEqual([...WRITE_KINDS].sort());
    expect(writes.map((r) => r.intent_key).sort()).toEqual(
      ["cp:pr:propose", ...intents.map((i) => `run:${i.intent_key}`)].sort(),
    );
    // Beside the write kinds the outbox holds only the execution's own check.
    for (const r of rows.filter((x) => !writes.includes(x)))
      expect(r.kind, r.intent_key).toMatch(/^check\./);
    expect(writes.every((r) => r.state === "pending")).toBe(true);

    // Every run, result and acceptance step has happened, and nothing reached GitHub.
    expect(githubRequests).toEqual([]);
    const github = memoryGithub();
    expect(github.writes).toEqual([]);

    await drain(github);

    // The drainer answered every write row through an applier.
    const after = await outboxOf(id);
    for (const r of after.filter((x) => (WRITE_KINDS as readonly string[]).includes(x.kind)))
      expect(r.state, r.kind).not.toBe("pending");
    // Each run-authored write reached GitHub once, through its kind's actuator; pr.propose and pr.close went through
    // the agentic appliers' Git Data calls, never through an actuator.
    const byActuator = github.writes.filter((w) => w.via.startsWith("actuator:"));
    expect(
      byActuator
        .map((w) => w.kind)
        .filter((k) => k !== "check.conclude" && k !== "check.open")
        .sort(),
    ).toEqual(
      Object.keys(RUN_WRITES)
        .filter((k) => k !== "pr.close")
        .sort(),
    );
    for (const w of byActuator)
      expect(w.via).toBe(`actuator:${profile.intent_kinds[w.kind]!.actuator}`);
    expect(github.writes.filter((w) => w.via.startsWith("git:")).map((w) => w.via)).toContain(
      "git:closePull",
    );
    expect(githubRequests).toEqual([]);
  }, 120_000);
});
