// The agentic area on the composed control plane: mameko's D1 tables and R2 under workerd, the agentic recipes run by
// a fake executor in a real git checkout, mameko's `applyOutbox` and drainer over D1, and the control plane's
// actuators (`writebackApplier` over the GitHub actuator) on a fake GitHub (specs/runs/agentic.md § Credential
// boundary, § Staged write).
//
// The fake executor reports each intent a run appends, and the `prProposePayload` binding's row for a `success` result
// with a staged write, as a staged intent at the lease's epoch. mameko at the pinned commit records neither from an
// `exec.result`, so the executor writes them to `staged_intents` directly; from there `applyOutbox` and the drainer
// are mameko's. The outbox scenario stands in for that staging, so it covers only the half after it — the epoch filter
// and the agentic routing — and cites no requirement id.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Artifacts,
  GitData,
  type GitDataError,
  type Manifest,
  ModelClient,
  prProposePayload,
  RecipeIntents,
  Shell,
  StagedWrites,
  writebackRecordsLayer,
} from "@fractalboxdev/flare-dispatch-agentic";
import {
  artifactPrefixSink,
  checkoutLayer,
  prReviewRun,
  shellLayer,
  specDriftRun,
  stagedWritesLayer,
} from "@fractalboxdev/flare-dispatch-agentic/executor";
import { artifactPath } from "@fractalboxdev/flare-dispatch-cache";
import { profile } from "@fractalboxdev/flare-dispatch-profile";
import { actuatorBindings, drainOnce, ExecutionSteps } from "@fractalboxdev/mameko-coordinator";
import {
  d1OutboxStore,
  runD1Migrations,
  type D1Like,
} from "@fractalboxdev/mameko-host-cloudflare/d1";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import {
  ActuatorRateLimit,
  Actuators,
  actuatorRegistry,
  type IntentRow,
} from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writebackApplier } from "../../../apps/control-plane/src/agentic.ts";
import { executionConfig } from "../../../apps/control-plane/src/config.ts";

const APP_LOGIN = "flare-dispatch[bot]";
const SPEC_DRIFT_BRANCH = "flare-dispatch/spec-drift";
const REVIEW_DIFF = [
  "diff --git a/docs/a.md b/docs/a.md",
  "--- a/docs/a.md",
  "+++ b/docs/a.md",
  "@@ -1 +1 @@",
  "+text",
].join("\n");

let mf: Miniflare;
let databases = 0;
const dirs: string[] = [];
beforeAll(() => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    compatibilityDate: "2026-05-01",
    d1Databases: ["DB0", "DB1"],
    r2Buckets: ["CACHE0", "CACHE1"],
  });
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A fresh control plane store: mameko's D1 tables and the `CACHE` bucket that holds `artifacts/`. */
const freshPlane = async () => {
  const n = databases++;
  const db = (await mf.getD1Database(`DB${n}`)) as unknown as D1Like;
  await runD1Migrations(db);
  await db
    .prepare(
      `insert into executors (executor_id, kind, posture_tier, labels_json, slots_json)
       values ('e1', 'cloudflare', 'unmanaged', '[]', '{}')`,
    )
    .run();
  return { db, bucket: await mf.getR2Bucket(`CACHE${n}`) };
};

type Bucket = Awaited<ReturnType<Miniflare["getR2Bucket"]>>;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A repository with `specs/` at a base commit, ignoring `*.log`. */
const checkout = async () => {
  const dir = await tempDir("fd-conf-agentic-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  await mkdir(join(dir, "specs"), { recursive: true });
  await writeFile(join(dir, ".gitignore"), "*.log\n");
  for (const name of ["api", "committed", "edited", "kept"])
    await writeFile(join(dir, `specs/${name}.md`), `${name} before\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
};

const seedExecution = async (db: D1Like, id: string, scope: string, run: string, epoch: number) => {
  await db
    .prepare(
      "insert into executions (id, scope_id, run, class, status, enqueued_at) values (?, ?, ?, 'interactive', 'running', 0)",
    )
    .bind(id, scope, run)
    .run();
  await db
    .prepare(
      "insert into placements (execution_id, state, epoch, executor_id, accepted_epoch) values (?, 'leased', ?, 'e1', null)",
    )
    .bind(id, epoch)
    .run();
};

/** The result the control plane accepts at `epoch`: the placement row's accept, then `applyOutbox` for that epoch. */
const acceptSuccess = (db: D1Like, id: string, epoch: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        db
          .prepare(
            "update placements set state = 'accepted', epoch = ?, accepted_epoch = ? where execution_id = ?",
          )
          .bind(epoch, epoch, id)
          .run(),
      );
      const steps = yield* ExecutionSteps;
      yield* steps.applyOutbox(id, { _tag: "Success", epoch }, epoch);
    }).pipe(
      Effect.provide(
        d1ExecutionSteps(db, {
          ...executionConfig(profile),
          meteredCost: () => Effect.succeed(0),
        }),
      ),
    ),
  );

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** The fake executor's report of one intent at the lease's epoch. */
const stageIntent = (
  db: D1Like,
  lease: { readonly id: string; readonly epoch: number; readonly scope: string },
  intentKey: string,
  kind: string,
  payload: unknown,
) => {
  const json = JSON.stringify(payload);
  return db
    .prepare(
      `insert into staged_intents (execution_id, epoch, intent_key, kind, limit_key, payload_json, payload_digest, effect_class)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      lease.id,
      lease.epoch,
      intentKey,
      kind,
      lease.scope,
      json,
      digest(json),
      profile.intent_kinds[kind]!.effect_class,
    )
    .run();
};

/** `RecipeIntents` as the fake executor runs it: each intent keyed `run:<step>:<index>`, staged at the lease's epoch. */
const executorIntents = (
  db: D1Like,
  lease: { readonly id: string; readonly epoch: number; readonly scope: string },
) => {
  const counts = new Map<string, number>();
  return Layer.succeed(RecipeIntents, {
    append: (step, kind, payload) =>
      Effect.promise(async () => {
        const index = counts.get(step) ?? 0;
        counts.set(step, index + 1);
        await stageIntent(db, lease, `run:${step}:${index}`, kind, payload);
      }),
  });
};

/** One GitHub call or actuator apply, in the order GitHub received it. */
interface GithubWrite {
  readonly via: string;
  readonly repo: string;
  readonly detail: string;
}

/** A GitHub in memory: the git data the agentic appliers call, and every other actuator the profile binds. */
const fakeGithub = (repos: Readonly<Record<string, { base: string; openPull?: number }>>) => {
  const writes: GithubWrite[] = [];
  const reads: string[] = [];
  const blobs: { repo: string; bytes: Uint8Array }[] = [];
  const trees: { path: string; mode: string; sha: string }[][] = [];
  const refs = new Map<string, string>(
    Object.entries(repos).map(([name, r]) => [`${name}:main`, r.base]),
  );
  const pulls = new Map<string, number>(
    Object.entries(repos).flatMap(([name, r]) =>
      r.openPull === undefined ? [] : [[`${name}:${SPEC_DRIFT_BRANCH}`, r.openPull] as const],
    ),
  );
  const key = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`;
  const read = <A>(call: string, a: A): Effect.Effect<A, GitDataError> =>
    Effect.sync(() => (reads.push(call), a));
  const write = <A>(call: string, r: { owner: string; name: string }, detail: string, a: A) =>
    Effect.sync(() => (writes.push({ via: `git:${call}`, repo: key(r), detail }), a));
  const git = Layer.succeed(GitData, {
    defaultBranch: () => read("defaultBranch", "main"),
    branchProtected: (_r, branch) => read("branchProtected", branch === "main"),
    refSha: (r, branch) => read("refSha", refs.get(`${key(r)}:${branch}`) ?? null),
    commitsSince: () => read("commitsSince", []),
    commit: (_r, sha) =>
      read("commit", { sha, message: "base", authorLogin: "dev", tree: `tree-${sha}` }),
    fileAt: () => read("fileAt", null),
    createBlob: (r, bytes) =>
      Effect.sync(() => {
        blobs.push({ repo: key(r), bytes: bytes.slice() });
        return `blob-${blobs.length}`;
      }).pipe(Effect.tap(() => write("createBlob", r, `${bytes.length} bytes`, undefined))),
    createTree: (r, _base, entries) =>
      Effect.sync(() => `tree-${trees.push([...entries])}`).pipe(
        Effect.tap(() => write("createTree", r, entries.map((e) => e.path).join(","), undefined)),
      ),
    createCommit: (r) => write("createCommit", r, "", "c".repeat(40)),
    createRef: (r, branch, sha) =>
      Effect.sync(() => void refs.set(`${key(r)}:${branch}`, sha)).pipe(
        Effect.tap(() => write("createRef", r, branch, undefined)),
      ),
    updateRef: (r, branch, sha) =>
      Effect.sync(() => void refs.set(`${key(r)}:${branch}`, sha)).pipe(
        Effect.tap(() => write("updateRef", r, branch, undefined)),
      ),
    openPull: (r, head) => {
      const number = pulls.get(`${key(r)}:${head}`);
      return read(
        "openPull",
        number === undefined
          ? null
          : { number, url: `https://github.com/${key(r)}/pull/${number}`, head },
      );
    },
    createPull: (r, input) =>
      write("createPull", r, input.head, {
        number: 1,
        url: `https://github.com/${key(r)}/pull/1`,
        head: input.head,
      }),
    updatePull: (r) => write("updatePull", r, "", undefined),
    addLabels: (r, _n, labels) => write("addLabels", r, labels.join(","), undefined),
    closePull: (r, number) =>
      Effect.sync(() => void pulls.forEach((n, k) => n === number && pulls.delete(k))).pipe(
        Effect.tap(() => write("closePull", r, String(number), undefined)),
      ),
  });
  const actuator = (name: string) => ({
    apply: (row: IntentRow) =>
      Effect.sync(() => {
        writes.push({ via: `actuator:${name}`, repo: row.scopeId, detail: row.kind });
        return { _tag: "applied" as const, externalRef: `${name}:${row.intentKey}` };
      }),
    lookup: () => Effect.succeed({ _tag: "absent" as const }),
    reconcile: () => Effect.succeed({ _tag: "absent" as const }),
  });
  const names = [...new Set(Object.values(profile.intent_kinds).map((k) => k.actuator))];
  const actuators = Layer.succeed(
    Actuators,
    actuatorRegistry(Object.fromEntries(names.map((n) => [n, actuator(n)]))),
  );
  return { writes, reads, blobs, trees, git, actuators };
};

const permits = Layer.succeed(ActuatorRateLimit, {
  acquire: () => Effect.succeed({ _tag: "granted" as const, permitId: "p" }),
  release: () => Effect.void,
});

/** The control plane's actuators as `composition.ts` composes them, over the fake GitHub and the plane's records. */
const controlPlaneActuators = (
  github: ReturnType<typeof fakeGithub>,
  plane: { readonly db: D1Like; readonly bucket: Bucket },
) =>
  writebackApplier(APP_LOGIN).pipe(
    Layer.provide(
      Layer.mergeAll(
        github.actuators,
        github.git,
        writebackRecordsLayer({
          db: plane.db,
          artifacts: plane.bucket,
          artifactPath,
          issuedCredentials: () => Effect.succeed([]),
        }),
      ),
    ),
  );

const drain = (github: ReturnType<typeof fakeGithub>, plane: { db: D1Like; bucket: Bucket }) =>
  Effect.runPromise(
    drainOnce({
      now: Date.now() + 60_000,
      token: () => "t",
      random: () => 0.5,
      actuatorOf: actuatorBindings(profile.intent_kinds),
    }).pipe(
      Effect.provide(
        Layer.mergeAll(controlPlaneActuators(github, plane), d1OutboxStore(plane.db), permits),
      ),
    ),
  );

const runPayload = <I>(
  run: string,
  lease: { id: string; epoch: number; scope: string },
  input: I,
) => ({
  workflow_version: 1,
  execution_id: lease.id,
  run,
  run_version: "2.0.0",
  scope_id: lease.scope,
  request_context: {},
  class: "interactive",
  epoch: lease.epoch,
  deadline_at: Date.now() + 3_600_000,
  attempt: 0,
  input,
});

const answering = (text: string) =>
  Layer.succeed(ModelClient, { complete: () => Effect.succeed(text) });

const noArtifacts = Layer.succeed(Artifacts, { put: () => Effect.void });

/** The executor's lease of a spec-drift-pr execution: the run in the checkout, the staged write to R2, its intents. */
const runSpecDrift = async (
  plane: { db: D1Like; bucket: Bucket },
  lease: { id: string; epoch: number; scope: string },
  repo: { dir: string; base: string },
  answer: object,
) => {
  const prefix = artifactPath(lease.id, lease.epoch, "");
  let manifest: Manifest | undefined;
  const staging = await tempDir("fd-conf-staging-");
  const staged = stagedWritesLayer(
    repo.dir,
    repo.base,
    staging,
    artifactPrefixSink(prefix, async (key, bytes, sha256) => {
      await plane.bucket.put(key, bytes, { sha256 });
    }),
  );
  const recording = Layer.effect(
    StagedWrites,
    Effect.map(StagedWrites, (s) => ({
      stage: (input: Parameters<typeof s.stage>[0]) =>
        Effect.tap(s.stage(input), (m) => Effect.sync(() => void (manifest = m))),
    })),
  ).pipe(Layer.provide(staged));
  const services = Layer.mergeAll(
    shellLayer(repo.dir),
    checkoutLayer(repo.dir),
    answering(JSON.stringify(answer)),
    executorIntents(plane.db, lease),
    recording,
    noArtifacts,
    WorkflowEngine.layerMemory,
  );
  const [owner, name] = lease.scope.split("/") as [string, string];
  const result = await Effect.runPromise(
    specDriftRun.workflow
      .execute(runPayload("spec-drift-pr", lease, { repo: { owner, name }, baseBranch: "main" }))
      .pipe(Effect.provide(Layer.provideMerge(specDriftRun.layer, services))),
  );
  const proposal = prProposePayload({
    executionId: lease.id,
    run: "spec-drift-pr",
    repo: { owner, name },
    outcome: (result as { _tag: string })._tag,
    ...(manifest === undefined ? {} : { stagedWrite: manifest }),
  });
  if (proposal._tag === "payload")
    await stageIntent(plane.db, lease, "cp:pr:propose", "pr.propose", proposal.payload);
  return result;
};

/** The rows of a query against the control plane's database. */
const rows = async <T>(db: D1Like, sql: string): Promise<readonly T[]> =>
  (await db.prepare(sql).all()).results as T[];

const outboxRows = (db: D1Like) =>
  rows<{
    execution_id: string;
    intent_key: string;
    kind: string;
    state: string;
    payload_json: string;
  }>(db, "select execution_id, intent_key, kind, state, payload_json from outbox order by id");

describe("an agentic recipe's repository writes on the composed control plane", () => {
  it("reach GitHub only as outbox rows of the accepted epoch, pr.propose and pr.close through the agentic appliers", async () => {
    const plane = await freshPlane();
    const drifted = await checkout();
    const inSync = await checkout();
    const github = fakeGithub({
      "o/r": { base: drifted.base },
      "o/s": { base: inSync.base, openPull: 5 },
    });

    // x1 drifts: its first lease is reclaimed after the run staged its write, and the second lease's result is accepted.
    await seedExecution(plane.db, "x1", "o/r", "spec-drift-pr", 1);
    const drift = (text: string) => ({
      inSync: false,
      summary: "Reconcile the API spec.",
      files: [{ path: "specs/api.md", content: text }],
    });
    await runSpecDrift(plane, { id: "x1", epoch: 1, scope: "o/r" }, drifted, drift("epoch one\n"));
    await plane.db.prepare("update placements set epoch = 2 where execution_id = 'x1'").run();
    await runSpecDrift(plane, { id: "x1", epoch: 2, scope: "o/r" }, drifted, drift("epoch two\n"));

    // x2 is in sync, so the run closes the open spec-drift pull request.
    await seedExecution(plane.db, "x2", "o/s", "spec-drift-pr", 1);
    await runSpecDrift(plane, { id: "x2", epoch: 1, scope: "o/s" }, inSync, {
      inSync: true,
      summary: "",
      files: [],
    });

    // x3 reviews a pull request and comments on it.
    await seedExecution(plane.db, "x3", "o/r", "pr-review", 1);
    const review = await Effect.runPromise(
      prReviewRun.workflow
        .execute(
          runPayload(
            "pr-review",
            { id: "x3", epoch: 1, scope: "o/r" },
            {
              repo: { owner: "o", name: "r" },
              number: 7,
              baseSha: "a".repeat(40),
              headSha: "c".repeat(40),
              draft: false,
              labels: [],
              authorLogin: "dev",
              authorAssociation: "MEMBER",
              forkHead: false,
              maxDiffChars: 100_000,
            },
          ),
        )
        .pipe(
          Effect.provide(
            Layer.provideMerge(
              prReviewRun.layer,
              Layer.mergeAll(
                Layer.succeed(Shell, {
                  run: () => Effect.succeed({ exitCode: 0, stdout: REVIEW_DIFF, stderr: "" }),
                }),
                answering('{"findings":[]}'),
                executorIntents(plane.db, { id: "x3", epoch: 1, scope: "o/r" }),
                noArtifacts,
                WorkflowEngine.layerMemory,
              ),
            ),
          ),
        ),
    );
    expect(review).toMatchObject({ _tag: "success" });

    // Every run has ended and GitHub has received nothing: the runs hold no GitHub writer.
    expect(github.writes).toEqual([]);
    expect(github.reads).toEqual([]);

    await acceptSuccess(plane.db, "x1", 2);
    await acceptSuccess(plane.db, "x2", 1);
    await acceptSuccess(plane.db, "x3", 1);
    const queued = await outboxRows(plane.db);
    expect(queued.map((r) => [r.execution_id, r.intent_key, r.kind, r.state])).toEqual([
      ["x1", "cp:pr:propose", "pr.propose", "pending"],
      ["x1", "outcome", "check.conclude", "pending"],
      ["x2", "outcome", "check.conclude", "pending"],
      ["x2", "run:close:0", "pr.close", "pending"],
      ["x3", "outcome", "check.conclude", "pending"],
      ["x3", "run:comment:0", "comment", "pending"],
    ]);
    // The reclaimed epoch's staged write never reaches the outbox.
    const proposed = JSON.parse(queued[0]!.payload_json) as { manifest: Manifest };
    const staged = await rows<{ epoch: number; committed: number; payload_json: string }>(
      plane.db,
      "select epoch, committed, payload_json from staged_intents where execution_id = 'x1' order by epoch",
    );
    expect(staged.map((r) => [r.epoch, r.committed])).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(proposed).toEqual(JSON.parse(staged[1]!.payload_json));
    expect(proposed).not.toEqual(JSON.parse(staged[0]!.payload_json));
    expect(github.writes).toEqual([]);

    await drain(github, plane);

    expect((await outboxRows(plane.db)).map((r) => [r.intent_key, r.state])).toEqual([
      ["cp:pr:propose", "applied"],
      ["outcome", "applied"],
      ["outcome", "applied"],
      ["run:close:0", "applied"],
      ["outcome", "applied"],
      ["run:comment:0", "applied"],
    ]);
    const via = (repo: string) =>
      github.writes.filter((w) => w.repo === repo).map((w) => `${w.via} ${w.detail}`);
    // pr.propose: one commit of the accepted epoch's bytes and one draft pull request, written by the agentic applier.
    expect(via("o/r").filter((w) => w.startsWith("git:"))).toEqual([
      "git:createBlob 10 bytes",
      "git:createTree specs/api.md",
      "git:createCommit ",
      `git:createRef ${SPEC_DRIFT_BRANCH}`,
      `git:createPull ${SPEC_DRIFT_BRANCH}`,
      "git:addLabels spec-drift",
    ]);
    expect(github.blobs.map((b) => new TextDecoder().decode(b.bytes))).toEqual(["epoch two\n"]);
    // pr.close: the agentic applier closes the open pull request.
    expect(via("o/s")).toEqual(["actuator:checkRun check.conclude", "git:closePull 5"]);
    // The comment and every outcome go to the GitHub actuator; no pr.propose or pr.close row reaches it.
    expect(
      github.writes
        .filter((w) => w.via.startsWith("actuator:"))
        .map((w) => w.detail)
        .sort(),
    ).toEqual(["check.conclude", "check.conclude", "check.conclude", "comment"]);
  }, 60_000);
});

describe("the staged write the executor builds, as the composed control plane commits it", () => {
  it("[FD-AGT-012] holds the tracked changes against the base commit and the untracked files not ignored, never its staging directory", async () => {
    const plane = await freshPlane();
    const { dir, base } = await checkout();
    // A commit after the base, an edit in the working tree, a file only in the index, an untracked file and an
    // ignored one; the staging directory sits inside the checkout and already holds an earlier staged write.
    await writeFile(join(dir, "specs/committed.md"), "committed after\n");
    git(dir, "commit", "-q", "-am", "after base");
    await writeFile(join(dir, "specs/edited.md"), "edited after\n");
    await writeFile(join(dir, "specs/indexed.md"), "indexed\n");
    git(dir, "add", "specs/indexed.md");
    await writeFile(join(dir, "specs/untracked.md"), "untracked\n");
    await writeFile(join(dir, "specs/debug.log"), "ignored\n");
    const staging = join(dir, "specs/.staging");
    const sink = artifactPrefixSink(artifactPath("x1", 1, ""), async (key, bytes, sha256) => {
      await plane.bucket.put(key, bytes, { sha256 });
    });
    const stage = Effect.flatMap(StagedWrites, (s) =>
      s.stage({
        branch: SPEC_DRIFT_BRANCH,
        baseBranch: "main",
        message: "docs(specs): reconcile the specs with the code",
        pr: { title: "Reconcile the specs with the code", body: "Drift.", draft: true, labels: [] },
      }),
    ).pipe(Effect.provide(stagedWritesLayer(dir, base, staging, sink)));
    await Effect.runPromise(stage);
    await writeFile(join(dir, "specs/api.md"), "api after\n");
    const manifest = await Effect.runPromise(stage);

    const expected = [
      "specs/api.md",
      "specs/committed.md",
      "specs/edited.md",
      "specs/indexed.md",
      "specs/untracked.md",
    ];
    expect(manifest.baseCommit).toBe(base);
    expect(manifest.entries.map((e) => e.path)).toEqual(expected);

    await seedExecution(plane.db, "x1", "o/r", "spec-drift-pr", 1);
    await plane.db
      .prepare(
        "update placements set state = 'accepted', accepted_epoch = 1 where execution_id = 'x1'",
      )
      .run();
    const github = fakeGithub({ "o/r": { base } });
    const row: IntentRow = {
      executionId: "x1",
      scopeId: "o/r",
      intentKey: "cp:pr:propose",
      kind: "pr.propose",
      payload: {
        executionId: "x1",
        run: "spec-drift-pr",
        repo: { owner: "o", name: "r" },
        manifest,
      },
      payloadDigest: "d",
      effectClass: "adoptable",
      attempts: 0,
    };
    const answer = await Effect.runPromise(
      Effect.flatMap(Actuators, (a) => a.get("pullRequest")!.apply(row)).pipe(
        Effect.provide(controlPlaneActuators(github, plane)),
      ),
    );
    expect(answer).toEqual({ _tag: "applied", externalRef: "https://github.com/o/r/pull/1" });
    expect(github.trees[0]?.map((e) => e.path)).toEqual(expected);
    expect(github.blobs.map((b) => new TextDecoder().decode(b.bytes))).toEqual(
      await Promise.all(expected.map((p) => readFile(join(dir, p), "utf8"))),
    );
  }, 60_000);
});
