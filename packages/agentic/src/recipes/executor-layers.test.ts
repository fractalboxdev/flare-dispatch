import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intentList } from "@fractalboxdev/mameko-run";
import { Effect, Layer } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { afterEach, describe, expect, it } from "vitest";
import { memoryD1 } from "../local/d1.test-support.ts";
import { artifactPrefixSink } from "../staged-write/build.ts";
import { STAGED_WRITE_MANIFEST } from "../staged-write/manifest.ts";
import { suppressionLedgerD1 } from "../suppression/ledger.ts";
import { CI_TRIAGE_WINDOW_MS, ExecutionsRead, reportPath } from "./ci-triage-pr.ts";
import {
  artifactsLayer,
  checkoutLayer,
  cloudAgenticLayers,
  editLoopLayer,
  shellLayer,
  type CloudAgenticConfig,
} from "./executor-layers.ts";
import { executionsApiReadLayer, executionsReadLayer, type LogObjects } from "./executions-read.ts";
import { payload } from "./fakes.test-support.ts";
import { ciTriageRun, prReviewRun, selfHealPrRun } from "./runs.ts";
import { selfHealBranch } from "./self-heal-pr.ts";
import { Artifacts, Checkout, EditLoop, ModelClient, Shell } from "./services.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("executor layers", () => {
  it.each([0, 7])("keeps exit code %i when a real child closes stdin before a large prompt finishes writing", async (exitCode) => {
    const dir = await mkdtemp(join(tmpdir(), "fd-edit-stdin-"));
    dirs.push(dir);
    const result = await Effect.runPromise(
      EditLoop.use(loop => loop.run("prompt\n".repeat(400_000))).pipe(
        Effect.provide(editLoopLayer(dir, [process.execPath, "-e",
          `require('node:fs').closeSync(0); setTimeout(() => process.exit(${exitCode}), 25);`])),
      ),
    );
    // Vitest also fails this test file if the pipe emits an uncaught error after the command completes.
    expect(result.exitCode).toBe(exitCode);
  });

  it("delivers the complete prompt to a real child that consumes its stdin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fd-edit-prompt-"));
    dirs.push(dir);
    const prompt = "The exact coding-agent prompt.\n".repeat(10_000);
    const result = await Effect.runPromise(
      EditLoop.use(loop => loop.run(prompt)).pipe(
        Effect.provide(editLoopLayer(dir, [process.execPath, "-e",
          "let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>require('node:fs').writeFileSync('prompt.txt',text));"])),
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(dir,"prompt.txt"),"utf8")).toBe(prompt);
  });

  it("runs a command in the checkout and answers null for one that cannot start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fd-shell-"));
    dirs.push(dir);
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const shell = yield* Shell;
        return yield* shell.run("pwd && exit 3");
      }).pipe(Effect.provide(shellLayer(dir))),
    );
    expect(out.exitCode).toBe(3);
    expect(out.stdout.trim().endsWith(dir.split("/").at(-1) as string)).toBe(true);
    const missing = await Effect.runPromise(
      Effect.gen(function* () {
        const loop = yield* EditLoop;
        return yield* loop.run("prompt");
      }).pipe(Effect.provide(editLoopLayer(dir, ["/nonexistent/agent"]))),
    );
    expect(missing).toEqual({ started: false, exitCode: null });
    const killed = await Effect.runPromise(
      Effect.gen(function* () {
        const loop = yield* EditLoop;
        return yield* loop.run("prompt");
      }).pipe(Effect.provide(editLoopLayer(dir, ["sh", "-c", "exec sleep 5"], 200))),
    );
    expect(killed).toEqual({ started: true, exitCode: null });
  });

  it("writes checkout files and refuses a path outside the checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fd-checkout-"));
    dirs.push(dir);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const checkout = yield* Checkout;
        yield* checkout.write("specs/a.md", "# A");
        const listed = yield* checkout.list("specs");
        const refused = yield* Effect.result(checkout.write("../escape.md", "x"));
        return { listed, refused };
      }).pipe(Effect.provide(checkoutLayer(dir))),
    );
    expect(result.listed).toEqual(["specs/a.md"]);
    expect(result.refused._tag).toBe("Failure");
    expect(await readFile(join(dir, "specs/a.md"), "utf8")).toBe("# A");
  });
});

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

/** A checkout with a base commit and a head commit that changes `docs/a.md`. */
const repository = async () => {
  const dir = await tempDir("fd-cloud-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  await writeFile(join(dir, "README.md"), "readme\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  await writeFile(join(dir, "README.md"), "readme\nmore\n");
  git(dir, "commit", "-q", "-am", "head");
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
};

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** A log bucket in memory, in the shape the R2 binding answers. */
const memoryLogs = (objects: Record<string, string>, uploaded: Record<string, number> = {}) => {
  const store = new Map(Object.entries(objects));
  const bucket: LogObjects & { readonly drop: (key: string) => void } = {
    drop: (key) => void store.delete(key),
    list: async ({ prefix }) => ({
      objects: Object.keys(objects)
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key, uploaded: new Date(uploaded[key] ?? 0) })),
      truncated: false,
    }),
    get: async (key) => {
      const text = store.get(key);
      return text === undefined ? null : { text: async () => text };
    },
  };
  return bucket;
};

const STEP_A = "a".repeat(24);
const STEP_B = "b".repeat(24);

const LEASE_TOKEN = "fd-lease-token-0123456789abcdef";
const PROVIDER_KEY = "sk-ant-provider-key-0123456789";
const CONTROL_PLANE = "https://cp.example.com";
const GATEWAY = `${CONTROL_PLANE}/v1/model/completions`;

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: { call_site: string; tier: string; messages: { content: string }[] };
}

interface ApiRequest {
  readonly url: URL;
  readonly headers: Headers;
}

const notFound = () => new Response(null, { status: 404 });

/**
 * The config a cloud executor builds, with the model gateway answering per call site and `controlPlane` answering the
 * executions and log routes.
 */
const cloudConfig = (
  over: Partial<CloudAgenticConfig> & { checkout: string; baseCommit: string },
  controlPlane: (url: URL) => Response = notFound,
) => {
  const sent: Sent[] = [];
  const api: ApiRequest[] = [];
  const stored = new Map<string, { bytes: Uint8Array; sha256: string }>();
  const config: CloudAgenticConfig = {
    stagingDir: join(tmpdir(), `fd-cloud-staging-${Math.random().toString(16).slice(2)}`),
    editLoop: ["sh", "-c", "true"],
    modelGatewayUrl: GATEWAY,
    controlPlaneUrl: CONTROL_PLANE,
    fetch: (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      if (url.pathname.startsWith("/v1/executions")) {
        api.push({ url, headers: new Headers(init.headers) });
        return controlPlane(url);
      }
      const body = JSON.parse(String(init.body)) as Sent["body"];
      sent.push({ url: input, headers: new Headers(init.headers), body });
      const text =
        body.call_site === "classify"
          ? "flaky"
          : body.call_site === "write-up"
            ? "Two flaky tests."
            : '{"findings":[]}';
      return new Response(JSON.stringify({ text }));
    }) as unknown as typeof fetch,
    artifacts: artifactPrefixSink(
      "artifacts/01HEXEC0000000000000000000/1/",
      async (key, bytes, sha256) => {
        stored.set(key, { bytes: new Uint8Array(bytes), sha256 });
      },
    ),
    env: {
      PATH: process.env["PATH"],
      HOME: tmpdir(),
      FD_LEASE_TOKEN: LEASE_TOKEN,
      ANTHROPIC_API_KEY: PROVIDER_KEY,
    },
    credentials: [LEASE_TOKEN],
    suppressionLedger: suppressionLedgerD1(memoryD1()),
    ...over,
  };
  return { config, sent, api, stored };
};

/** The cloud Layers as the runner provides them: on its `Intents`, with an in-memory workflow engine. */
const cloud = (config: CloudAgenticConfig) => {
  const intents = intentList();
  return {
    intents,
    layer: Layer.mergeAll(
      cloudAgenticLayers(config).pipe(Layer.provide(intents.layer)),
      intents.layer,
      WorkflowEngine.layerMemory,
    ),
  };
};

describe("the cloud executor's agentic layers", () => {
  it("[FD-AGT-010] starts the edit loop and the shell without the runner's credentials, and sends models none", async () => {
    const { dir, base } = await repository();
    const { config, sent } = cloudConfig({
      checkout: dir,
      baseCommit: base,
      editLoop: ["sh", "-c", "env > edit-loop.env"],
    });
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* EditLoop).run("fix it");
        const shell = yield* (yield* Shell).run("env");
        const model = yield* ModelClient;
        const answer = yield* model.complete({
          callSite: "c",
          tier: "transform",
          messages: [{ role: "user", content: "hello" }],
        });
        const leaked = yield* Effect.result(
          model.complete({
            callSite: "c",
            tier: "transform",
            messages: [{ role: "user", content: `token ${LEASE_TOKEN}` }],
          }),
        );
        return { shell: shell.stdout, answer, leaked };
      }).pipe(Effect.provide(cloud(config).layer)),
    );
    const editEnv = await readFile(join(dir, "edit-loop.env"), "utf8");
    for (const env of [editEnv, out.shell]) {
      expect(env).not.toContain(LEASE_TOKEN);
      expect(env).not.toContain(PROVIDER_KEY);
      expect(env).toContain(`FD_MODEL_GATEWAY_URL=${GATEWAY}`);
    }
    expect(out.answer).toBe('{"findings":[]}');
    expect(out.leaked._tag).toBe("Failure");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(GATEWAY);
    expect(sent[0]?.headers.get("authorization")).toBeNull();
    expect(JSON.stringify(sent[0]?.body)).not.toContain(LEASE_TOKEN);
  });

  it("[FD-AGT-059] stores pr-review's diff only in the execution's artifact store, byte for byte, and publishes no link", async () => {
    const { dir, base, head } = await repository();
    const { config, stored } = cloudConfig({ checkout: dir, baseCommit: base });
    const { intents, layer } = cloud(config);
    const result = await Effect.runPromise(
      prReviewRun.workflow
        .execute(
          payload("pr-review", {
            repo: { owner: "o", name: "r" },
            number: 7,
            baseSha: base,
            headSha: head,
            draft: false,
            labels: [],
            authorLogin: "dev",
            authorAssociation: "MEMBER",
            forkHead: false,
            maxDiffChars: 100_000,
          }),
        )
        .pipe(Effect.provide(Layer.provideMerge(prReviewRun.layer, layer))),
    );
    expect(result).toEqual({ _tag: "success" });
    const diff = git(dir, "diff", "--no-color", "--no-ext-diff", `${base}...${head}`);
    const key = "artifacts/01HEXEC0000000000000000000/1/pr-review.diff";
    expect([...stored.keys()]).toEqual([key]);
    expect(new TextDecoder().decode(stored.get(key)?.bytes).trim()).toBe(diff);
    expect(stored.get(key)?.sha256).toBe(sha(stored.get(key)?.bytes ?? new Uint8Array()));
    const published = JSON.stringify(intents.intents());
    expect(published).not.toContain("+more");
    expect(published).not.toContain("artifacts/");
  });

  it("[FD-AGT-064] [FD-AGT-065] [FD-AGT-066] self-heal-pr's repro runs on the checkout its edit loop edited, and only a green repro stages the edit", async () => {
    const repro = "grep -qx fixed src/status.txt";
    const selfHeal = async (
      editLoop: readonly [string, ...string[]],
      editLoopTimeoutMs?: number,
    ) => {
      const { dir, head } = await repository();
      const { config, stored } = cloudConfig({
        checkout: dir,
        baseCommit: head,
        editLoop,
        ...(editLoopTimeoutMs === undefined ? {} : { editLoopTimeoutMs }),
      });
      const result = await Effect.runPromise(
        selfHealPrRun.workflow
          .execute(
            payload("self-heal-pr", {
              incident: {
                contractVersion: "v1",
                incidentId: "ci-1",
                class: "ci",
                repo: "o/r",
                repro: { kind: "command", command: repro },
              },
            }),
          )
          .pipe(Effect.provide(Layer.provideMerge(selfHealPrRun.layer, cloud(config).layer))),
      );
      return { result, stored };
    };
    const fixed = await selfHeal([
      "sh",
      "-c",
      "mkdir -p src && printf 'fixed\\n' > src/status.txt",
    ]);
    expect(fixed.result).toEqual({ _tag: "success" });
    const key = `artifacts/01HEXEC0000000000000000000/1/${STAGED_WRITE_MANIFEST}`;
    const manifest = JSON.parse(new TextDecoder().decode(fixed.stored.get(key)?.bytes)) as {
      branch: string;
      entries: { path: string }[];
      pr: { labels: string[] };
    };
    expect(manifest.branch).toBe(selfHealBranch("ci-1"));
    expect(manifest.entries.map((e) => e.path)).toEqual(["src/status.txt"]);
    expect(manifest.pr.labels).toEqual(["self-heal", "self-heal:verified"]);

    const unfixed = await selfHeal(["sh", "-c", "true"]);
    expect(unfixed.result).toEqual({ _tag: "failure", reason: "no-fix" });
    expect([...unfixed.stored.keys()]).toEqual([]);

    // A loop its timeout kills ran, so the repro decides: red without the fix, green with it.
    const timedOut = await selfHeal(["sh", "-c", "exec sleep 5"], 200);
    expect(timedOut.result).toEqual({ _tag: "failure", reason: "no-fix" });
    expect([...timedOut.stored.keys()]).toEqual([]);
    const fixedThenKilled = await selfHeal(
      ["sh", "-c", "mkdir -p src && printf 'fixed\\n' > src/status.txt && exec sleep 5"],
      200,
    );
    expect(fixedThenKilled.result).toEqual({ _tag: "success" });
  });

  it("[FD-AGT-067] self-heal-pr whose edit-loop executable does not exist concludes infra: edit loop unavailable", async () => {
    const { dir, head } = await repository();
    const { config, stored } = cloudConfig({
      checkout: dir,
      baseCommit: head,
      editLoop: ["/nonexistent/agent"],
    });
    const result = await Effect.runPromise(
      selfHealPrRun.workflow
        .execute(
          payload("self-heal-pr", {
            incident: {
              contractVersion: "v1",
              incidentId: "ci-1",
              class: "ci",
              repo: "o/r",
              repro: { kind: "command", command: "true" },
            },
          }),
        )
        .pipe(Effect.provide(Layer.provideMerge(selfHealPrRun.layer, cloud(config).layer))),
    );
    expect(result).toEqual({ _tag: "failure", reason: "infra: edit loop unavailable" });
    expect([...stored.keys()]).toEqual([]);
  });

  it("[FD-AGT-059] refuses an artifact name outside the store's grammar and a store that fails", async () => {
    const put = (layer: Layer.Layer<Artifacts>, name: string) =>
      Effect.runPromise(
        Effect.result(
          Effect.flatMap(Artifacts, (a) => a.put(name, new Uint8Array([1]), "dashboard")),
        ).pipe(Effect.provide(layer)),
      );
    const keys: string[] = [];
    const ok = artifactsLayer(
      artifactPrefixSink("artifacts/x1/1/", async (key) => void keys.push(key)),
    );
    expect((await put(ok, "../escape"))._tag).toBe("Failure");
    expect((await put(ok, "a/./b"))._tag).toBe("Failure");
    expect((await put(ok, "review/diff.txt"))._tag).toBe("Success");
    expect(keys).toEqual(["artifacts/x1/1/review/diff.txt"]);
    const down = artifactsLayer({ put: async () => Promise.reject(new Error("R2 down")) });
    expect((await put(down, "pr-review.diff"))._tag).toBe("Failure");
  });

  it("[FD-AGT-071] ci-triage-pr reads the repository's failures of the last 24 h and their logs through the control plane's routes, with no credential", async () => {
    const { dir, base } = await repository();
    const now = Date.now();
    const view = (id: string, verdict: string, reason: string | null, finishedAt: number) => ({
      execution_id: id,
      run: "check",
      repository: "o/r",
      status: "done",
      verdict,
      reason,
      finished_at: finishedAt,
    });
    const logs: Record<string, string> = {
      "x-recent": "FAIL a.test.ts\nsecond step",
      "x-older": "ECONNRESET",
    };
    const controlPlane = (url: URL) => {
      if (url.pathname === "/v1/executions")
        return Response.json(
          url.searchParams.get("before") === null
            ? {
                executions: [
                  view("x-green", "success", null, now - 60_000),
                  view("x-recent", "failure", "finding: test", now - 3_600_000),
                ],
                next_before: "x-recent",
              }
            : { executions: [view("x-older", "failure", "infra: checkout", now - 20 * 3_600_000)] },
        );
      const id = /^\/v1\/executions\/([^/]+)\/logs$/.exec(url.pathname)?.[1];
      return id !== undefined && url.searchParams.get("format") === "text" && id in logs
        ? new Response(logs[id], { headers: { "content-type": "text/plain; charset=utf-8" } })
        : notFound();
    };
    const { config, sent, api, stored } = cloudConfig(
      { checkout: dir, baseCommit: base },
      controlPlane,
    );
    const { layer } = cloud(config);
    const result = await Effect.runPromise(
      ciTriageRun.workflow
        .execute(payload("ci-triage-pr", { repo: { owner: "o", name: "r" }, baseBranch: "main" }))
        .pipe(Effect.provide(Layer.provideMerge(ciTriageRun.layer, layer))),
    );
    expect(result).toEqual({ _tag: "success" });
    const lists = api.filter((r) => r.url.pathname === "/v1/executions");
    expect(lists.map((r) => r.url.searchParams.get("before"))).toEqual([null, "x-recent"]);
    for (const r of lists) {
      expect(r.url.searchParams.get("repository")).toBe("o/r");
      expect(r.url.searchParams.get("status")).toBe("done");
      expect(Number(r.url.searchParams.get("finished_since"))).toBeGreaterThanOrEqual(
        now - CI_TRIAGE_WINDOW_MS,
      );
    }
    expect(api.map((r) => r.url.pathname)).not.toContain("/v1/executions/x-green/logs");
    for (const r of api) expect(r.headers.get("authorization")).toBeNull();
    expect(sent.map((s) => [s.body.call_site, s.body.tier])).toEqual([
      ["classify", "transform"],
      ["classify", "transform"],
      ["write-up", "judgment"],
    ]);
    const recent = sent[0]?.body.messages[1]?.content ?? "";
    expect(recent).toContain("reason finding: test");
    expect(recent).toContain("FAIL a.test.ts\nsecond step");
    expect(sent[1]?.body.messages[1]?.content).toContain("ECONNRESET");
    const table = sent[2]?.body.messages[1]?.content ?? "";
    expect(table).toContain("x-recent check: flaky");
    expect(table).toContain("x-older check: flaky");
    expect(table).not.toContain("x-green");
    expect([...stored.keys()]).toContain(
      `artifacts/01HEXEC0000000000000000000/1/${STAGED_WRITE_MANIFEST}`,
    );
    expect(await readFile(join(dir, reportPath(now)), "utf8")).toContain("Two flaky tests.");
  });

  it("[FD-AGT-071] [FD-AGT-042] fails the route read on an answer other than 200, a page outside the shape and a log not served as text", async () => {
    let answer: () => Response = notFound;
    const fetch = (async () => answer()) as unknown as typeof globalThis.fetch;
    const read = <A, E>(f: (r: ExecutionsRead["Service"]) => Effect.Effect<A, E>) =>
      Effect.runPromise(
        Effect.result(Effect.flatMap(ExecutionsRead, f)).pipe(
          Effect.provide(executionsApiReadLayer({ baseUrl: CONTROL_PLANE, fetch })),
        ),
      );
    answer = () => new Response(null, { status: 401 });
    expect(await read((r) => r.failedSince("o/r", 5))).toMatchObject({
      _tag: "Failure",
      failure: { source: "executions" },
    });
    answer = () => Response.json({ executions: [{ execution_id: "x-1" }] });
    expect(await read((r) => r.failedSince("o/r", 5))).toMatchObject({
      _tag: "Failure",
      failure: { source: "executions" },
    });
    answer = () => new Response("<p>", { headers: { "content-type": "text/html" } });
    expect(await read((r) => r.failedJobLog("x-1"))).toMatchObject({
      _tag: "Failure",
      failure: { source: "logs" },
    });
    answer = () => new Response("", { headers: { "content-type": "text/plain; charset=utf-8" } });
    expect(await read((r) => r.failedJobLog("x-1"))).toMatchObject({
      _tag: "Success",
      success: "",
    });
  });

  it("[FD-AGT-071] the store read answers the repository's failures of the window and the failing epoch's log in step order", async () => {
    const now = Date.now();
    const db = memoryD1();
    const insert = (
      id: string,
      scope: string,
      status: string,
      reason: string,
      finishedAt: number,
    ) =>
      db
        .prepare(
          `insert into executions (id, scope_id, run, class, status, reason, enqueued_at, finished_at)
           values (?, ?, 'check', 'required', ?, ?, ?, ?)`,
        )
        .bind(id, scope, status, reason, finishedAt - 1000, finishedAt)
        .run();
    await insert("x-recent", "o/r", "failure", "finding: test", now - 3_600_000);
    await insert("x-older", "o/r", "failure", "infra: checkout", now - 20 * 3_600_000);
    await insert("x-stale", "o/r", "failure", "finding: old", now - 25 * 3_600_000);
    await insert("x-green", "o/r", "success", "", now - 60_000);
    await insert("x-other", "o/other", "failure", "finding: elsewhere", now - 60_000);
    const logs = memoryLogs(
      {
        [`logs/x-recent/1/${STEP_A}/stdout-0-10.ndjson`]: `{"line":"epoch one noise"}\n`,
        [`logs/x-recent/2/${STEP_B}/stdout-0-10.ndjson`]: `{"line":"second step"}\n`,
        [`logs/x-recent/2/${STEP_A}/stdout-0-10.ndjson`]: `{"line":"\\u001b[31mFAIL\\u001b[0m a.test.ts"}\n`,
        [`logs/x-recent/2/${STEP_A}/stdout-10-5.ndjson`]: `{"line":"outside the grammar"}\n`,
      },
      {
        [`logs/x-recent/2/${STEP_A}/stdout-0-10.ndjson`]: 1,
        [`logs/x-recent/2/${STEP_B}/stdout-0-10.ndjson`]: 2,
      },
    );
    const read = <A, E>(f: (r: ExecutionsRead["Service"]) => Effect.Effect<A, E>) =>
      Effect.runPromise(
        Effect.flatMap(ExecutionsRead, f).pipe(Effect.provide(executionsReadLayer({ db, logs }))),
      );
    const failures = await read((r) => r.failedSince("o/r", now - CI_TRIAGE_WINDOW_MS));
    expect(failures.map((f) => f.executionId)).toEqual(["x-recent", "x-older"]);
    expect(await read((r) => r.failedJobLog("x-recent"))).toBe("FAIL a.test.ts\nsecond step");
  });

  it("[FD-AGT-071] [FD-AGT-042] fails the read when the executions table, a listing or a listed log object fails", async () => {
    const db = memoryD1();
    await db
      .prepare(
        `insert into executions (id, scope_id, run, class, status, reason, enqueued_at, finished_at)
         values ('x-1', 'o/r', 'check', 'required', 'failure', 'finding: test', 1, 10)`,
      )
      .bind()
      .run();
    const logs = memoryLogs({ [`logs/x-1/1/${STEP_A}/stdout-0-10.ndjson`]: `{"line":"x"}\n` });
    const read = <A, E>(f: (r: ExecutionsRead["Service"]) => Effect.Effect<A, E>) =>
      Effect.runPromise(
        Effect.result(Effect.flatMap(ExecutionsRead, f)).pipe(
          Effect.provide(executionsReadLayer({ db, logs })),
        ),
      );
    expect(await read((r) => r.failedSince("o/r", 5))).toMatchObject({
      _tag: "Success",
      success: [{ executionId: "x-1", run: "check", reason: "finding: test", finishedAt: 10 }],
    });
    expect(await read((r) => r.failedJobLog("x-none"))).toMatchObject({
      _tag: "Failure",
      failure: { source: "logs" },
    });
    logs.drop(`logs/x-1/1/${STEP_A}/stdout-0-10.ndjson`);
    expect(await read((r) => r.failedJobLog("x-1"))).toMatchObject({
      _tag: "Failure",
      failure: { source: "logs" },
    });
    db.fail.on = true;
    expect(await read((r) => r.failedSince("o/r", 5))).toMatchObject({
      _tag: "Failure",
      failure: { source: "executions" },
    });
  });

  it("[FD-AGT-071] [FD-AGT-042] selects the accepted or current epoch and refuses an older attempt's log when the failed attempt wrote none", async () => {
    const db = memoryD1();
    await db
      .prepare(`insert into executions (id, scope_id, run, class, status, enqueued_at, finished_at)
      values ('reclaimed', 'o/r', 'check', 'required', 'failure', 1, 10)`)
      .bind()
      .run();
    await db
      .prepare(`insert into placements (execution_id, state, epoch, accepted_epoch)
      values ('reclaimed', 'failed', 3, 2)`)
      .bind()
      .run();
    const logs = memoryLogs({
      [`logs/reclaimed/1/${STEP_A}/stdout-0-10.ndjson`]: '{"line":"old attempt"}\n',
      [`logs/reclaimed/2/${STEP_A}/stdout-0-10.ndjson`]: '{"line":"accepted failure"}\n',
    });
    const read = () =>
      Effect.runPromise(
        Effect.result(ExecutionsRead.use((r) => r.failedJobLog("reclaimed"))).pipe(
          Effect.provide(executionsReadLayer({ db, logs })),
        ),
      );
    expect(await read()).toMatchObject({ _tag: "Success", success: "accepted failure" });
    await db
      .prepare("update placements set accepted_epoch = null where execution_id = 'reclaimed'")
      .bind()
      .run();
    expect(await read()).toMatchObject({
      _tag: "Failure",
      failure: { source: "logs", detail: expect.stringContaining("epoch 3") },
    });
    await db
      .prepare("update placements set epoch = 2 where execution_id = 'reclaimed'")
      .bind()
      .run();
    expect(await read()).toMatchObject({ _tag: "Success", success: "accepted failure" });
    await db
      .prepare("update placements set accepted_epoch = 1 where execution_id = 'reclaimed'")
      .bind()
      .run();
    expect(await read()).toMatchObject({ _tag: "Success", success: "old attempt" });
  });
});
