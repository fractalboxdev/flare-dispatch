// The staged write's round trip on the per-pull-request backends: the executor builds a staged write in a git checkout
// and uploads it to R2 under workerd at the lease's artifact prefix; the control plane's `WritebackRecords` reads it
// back with mameko's D1 tables, and the `pr.propose` applier commits it on a fake GitHub (FD-AGT-013).
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPrPropose,
  GitData,
  type GitDataError,
  type Manifest,
  stagedBlobName,
  StagedWrites,
  writebackRecordsLayer,
} from "@fractalboxdev/flare-dispatch-agentic";
import {
  artifactPrefixSink,
  stagedWritesLayer,
} from "@fractalboxdev/flare-dispatch-agentic/executor";
import { runD1Migrations, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import type { IntentRow } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mf: Miniflare;
const dirs: string[] = [];
beforeAll(() => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    compatibilityDate: "2026-05-01",
    d1Databases: ["DB"],
    r2Buckets: ["CACHE"],
  });
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

/** A checkout at a base commit with a text edit, a new binary file and a new executable script. */
const checkout = async () => {
  const dir = await mkdtemp(join(tmpdir(), "fd-conf-stage-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  await writeFile(join(dir, "README.md"), "before\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  await writeFile(join(dir, "README.md"), "after\r\nno newline at end");
  await writeFile(join(dir, "logo.bin"), Uint8Array.from([0, 255, 10, 13, 128, 7, 0]));
  await writeFile(join(dir, "run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(dir, "run.sh"), 0o755);
  return { dir, base };
};

/** A GitHub repository in memory: what the applier creates, with every blob kept as the bytes it was sent. */
const fakeGithub = (base: string) => {
  const blobs: Uint8Array[] = [];
  const trees: { path: string; mode: string; sha: string }[][] = [];
  const refs = new Map<string, string>([["main", base]]);
  const ok = <A>(a: A): Effect.Effect<A, GitDataError> => Effect.succeed(a);
  const layer = Layer.succeed(GitData, {
    defaultBranch: () => ok("main"),
    branchProtected: (_r, branch) => ok(branch === "main"),
    refSha: (_r, branch) => ok(refs.get(branch) ?? null),
    commitsSince: () => ok([]),
    commit: (_r, sha) => ok({ sha, message: "base", authorLogin: "dev", tree: `tree-${sha}` }),
    fileAt: () => ok(null),
    createBlob: (_r, bytes) => ok(`blob-${blobs.push(bytes.slice())}`),
    createTree: (_r, _base, entries) => ok(`tree-${trees.push([...entries])}`),
    createCommit: () => ok("c".repeat(40)),
    createRef: (_r, branch, sha) => Effect.sync(() => void refs.set(branch, sha)),
    updateRef: (_r, branch, sha) => Effect.sync(() => void refs.set(branch, sha)),
    openPull: () => ok(null),
    createPull: (_r, input) =>
      ok({ number: 1, url: "https://github.com/o/r/pull/1", head: input.head }),
    updatePull: () => Effect.void,
    addLabels: () => Effect.void,
    closePull: () => Effect.void,
  });
  return { blobs, trees, layer };
};

/** The lease's `upload_grant.artifact_prefix`, and the object key the control plane reads an artifact name at. */
const artifactPrefix = (executionId: string, epoch: number) => `artifacts/${executionId}/${epoch}/`;
const artifactPath = (executionId: string, epoch: number, name: string) =>
  `${artifactPrefix(executionId, epoch)}${name}`;

const row = (manifest: Manifest): IntentRow => ({
  executionId: "x1",
  scopeId: "scope",
  intentKey: "cp:pr:propose",
  kind: "pr.propose",
  payload: { executionId: "x1", run: "spec-drift-pr", repo: { owner: "o", name: "r" }, manifest },
  payloadDigest: "d",
  effectClass: "adoptable",
  attempts: 0,
});

const applier = applyPrPropose({
  writebackFor: () => ({
    writeback: {
      branch: "flare-dispatch/conf",
      baseBranch: "main",
      allowlist: ["**"],
      allowSensitivePaths: false,
      allowWorkflows: false,
    },
    declaresModel: true,
  }),
  appLogin: "flare-dispatch[bot]",
});

describe("the staged write on R2 and D1 under workerd", () => {
  it("[FD-AGT-013] the executor stores each blob byte for byte under its digest and the control plane commits each byte for byte", async () => {
    const { dir, base } = await checkout();
    const db = (await mf.getD1Database("DB")) as unknown as D1Like;
    const bucket = await mf.getR2Bucket("CACHE");
    await runD1Migrations(db);
    for (const sql of [
      "insert into executions (id, scope_id, run, status, enqueued_at) values ('x1', 'scope', 'spec-drift-pr', 'success', 0)",
      `insert into executors (executor_id, kind, posture_tier, labels_json, slots_json)
         values ('e1', 'cloudflare', 'unmanaged', '[]', '{}')`,
      "insert into placements (execution_id, state, epoch, executor_id, accepted_epoch) values ('x1', 'accepted', 2, 'e1', 2)",
    ])
      await db.prepare(sql).run();

    const staging = await mkdtemp(join(tmpdir(), "fd-conf-staging-"));
    dirs.push(staging);
    const manifest = await Effect.runPromise(
      Effect.flatMap(StagedWrites, (s) =>
        s.stage({
          branch: "flare-dispatch/conf",
          baseBranch: "main",
          message: "chore: conformance",
          pr: { title: "Conformance", body: "Round trip.", draft: true, labels: [] },
        }),
      ).pipe(
        Effect.provide(
          stagedWritesLayer(
            dir,
            base,
            staging,
            artifactPrefixSink(artifactPrefix("x1", 2), async (key, bytes, sha256) => {
              await bucket.put(key, bytes, { sha256 });
            }),
          ),
        ),
      ),
    );
    expect(manifest.entries.map((e) => [e.path, e.mode])).toEqual([
      ["README.md", "100644"],
      ["logo.bin", "100644"],
      ["run.sh", "100755"],
    ]);

    const github = fakeGithub(base);
    const records = writebackRecordsLayer({
      db,
      artifacts: bucket,
      artifactPath,
      issuedCredentials: () => Effect.succeed([]),
    });
    const answer = await Effect.runPromise(
      applier(row(manifest)).pipe(Effect.provide(Layer.merge(github.layer, records))),
    );
    expect(answer).toEqual({ _tag: "applied", externalRef: "https://github.com/o/r/pull/1" });
    const inCheckout = await Promise.all(
      ["README.md", "logo.bin", "run.sh"].map(
        async (p) => new Uint8Array(await readFile(join(dir, p))),
      ),
    );
    expect(github.blobs).toEqual(inCheckout);
    expect(github.trees[0]?.map((e) => [e.path, e.mode])).toEqual([
      ["README.md", "100644"],
      ["logo.bin", "100644"],
      ["run.sh", "100755"],
    ]);

    const swapped = manifest.entries[1]!.digest;
    await bucket.put(artifactPath("x1", 2, stagedBlobName(swapped)), "swapped");
    const tampered = fakeGithub(base);
    const refused = await Effect.runPromise(
      applier(row(manifest)).pipe(Effect.provide(Layer.merge(tampered.layer, records))),
    );
    expect(refused).toMatchObject({ _tag: "refused" });
    expect((refused as { reason: string }).reason).toMatch(/^writeback: digest-mismatch/);
    expect(tampered.blobs).toEqual([]);
  });
});
