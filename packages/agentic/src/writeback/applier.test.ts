import { createHash } from "node:crypto";
import type { IntentRow } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { Manifest, WritebackSpec } from "../staged-write/manifest.ts";
import {
  applyPrClose,
  applyPrPropose,
  executionTrailer,
  lookupPrPropose,
  prProposePayload,
  refusalView,
  StagedWriteReadFailed,
  WritebackRecords,
  type LoadedBlob,
} from "./applier.ts";
import { BASE_SHA, fakeGitLayer, fakeRepo, type FakeRepo } from "./fake-git.test-support.ts";
import { writebackRecordsLayer } from "./records.ts";
import { artifactPath, memoryBucket, recordsDb } from "./records.test-support.ts";
import { DEFAULT_MAX_BYTES, stagedBlobName } from "../staged-write/manifest.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const enc = (text: string) => new TextEncoder().encode(text);

const writeback: WritebackSpec = {
  branch: "flare-dispatch/spec-drift",
  baseBranch: "main",
  allowlist: ["specs/**"],
  allowSensitivePaths: false,
  allowWorkflows: false,
};

const files: Record<string, string> = { "specs/a.md": "# A\n", "specs/b.md": "# B\n" };

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  branch: "flare-dispatch/spec-drift",
  baseBranch: "main",
  baseCommit: BASE_SHA,
  message: "docs(specs): reconcile",
  pr: { title: "Reconcile specs", body: "Drift found.", draft: true, labels: ["spec-drift"] },
  entries: Object.entries(files).map(([path, text]) => ({
    path,
    mode: "100644",
    digest: sha256(enc(text)),
  })),
  ...over,
});

const row = (m: Manifest): IntentRow => ({
  executionId: "x1",
  scopeId: "scope",
  intentKey: "cp:pr:propose",
  kind: "pr.propose",
  payload: {
    executionId: "x1",
    run: "spec-drift-pr",
    repo: { owner: "o", name: "r" },
    manifest: m,
  },
  payloadDigest: "d",
  effectClass: "adoptable",
  attempts: 0,
});

const recordsLayer = (
  opts: { blobs?: Record<string, string>; modelCalls?: boolean; fail?: boolean } = {},
) =>
  Layer.succeed(WritebackRecords, {
    blobs: (_x, entries) =>
      opts.fail === true
        ? Effect.fail(new StagedWriteReadFailed({ source: "artifacts", detail: "down" }))
        : Effect.succeed(
            entries.flatMap((e): LoadedBlob[] => {
              const text = (opts.blobs ?? files)[e.path];
              if (text === undefined) return [];
              const bytes = enc(text);
              return [{ path: e.path, digest: sha256(bytes), size: bytes.length, text, bytes }];
            }),
          ),
    modelCalls: () => Effect.succeed(opts.modelCalls ?? false),
    issuedCredentials: () => Effect.succeed([]),
  });

const config = {
  writebackFor: (run: string) =>
    run === "spec-drift-pr" ? { writeback, declaresModel: true } : undefined,
  appLogin: "flare-dispatch[bot]",
};

const apply = (repo: FakeRepo, m: Manifest, records = recordsLayer()) =>
  Effect.runPromise(
    applyPrPropose(config)(row(m)).pipe(Effect.provide(Layer.merge(fakeGitLayer(repo), records))),
  );

const WRITES = [
  "createBlob",
  "createTree",
  "createCommit",
  "createRef",
  "updateRef",
  "createPull",
  "updatePull",
  "addLabels",
];

describe("pr.propose", () => {
  it("[FD-AGT-034] the binding returns the manifest of a success result with a staged write, and none otherwise", () => {
    const base = { executionId: "x1", run: "spec-drift-pr", repo: { owner: "o", name: "r" } };
    expect(prProposePayload({ ...base, outcome: "success", stagedWrite: manifest() })).toEqual({
      _tag: "payload",
      payload: { ...base, manifest: manifest() },
    });
    expect(prProposePayload({ ...base, outcome: "success" })).toEqual({ _tag: "none" });
    expect(prProposePayload({ ...base, outcome: "failure", stagedWrite: manifest() })).toEqual({
      _tag: "none",
    });
  });

  it("[FD-AGT-035] [FD-AGT-013] [FD-GH-083] commits each blob byte for byte on the base commit and opens a draft pull request", async () => {
    const repo = fakeRepo();
    const answer = await apply(repo, manifest());
    expect(answer).toEqual({ _tag: "applied", externalRef: "https://github.com/o/r/pull/1" });
    expect([...repo.blobs.values()].map((b) => new TextDecoder().decode(b)).sort()).toEqual([
      "# A\n",
      "# B\n",
    ]);
    const head = repo.refs.get("flare-dispatch/spec-drift") as string;
    const commit = repo.commits.get(head);
    expect(commit?.parents).toEqual([BASE_SHA]);
    expect(commit?.message).toContain(executionTrailer("x1"));
    expect(repo.pulls[0]).toMatchObject({
      draft: true,
      base: "main",
      head: "flare-dispatch/spec-drift",
      labels: ["spec-drift"],
    });
  });

  it("[FD-AGT-013] commits the blobs read back from the artifact store byte for byte, and refuses a swapped one", async () => {
    const db = recordsDb();
    db.exec(
      "insert into placements values ('x1', 'accepted', 1, 'e1', 1); insert into executors values ('e1', 'cloudflare')",
    );
    const bucket = memoryBucket();
    const binary = Uint8Array.from([0, 255, 10, 13, 128, 7]);
    const crlf = enc("# A\r\nno newline at end");
    for (const bytes of [binary, crlf])
      bucket.objects.set(artifactPath("x1", 1, stagedBlobName(sha256(bytes))), bytes);
    const live = writebackRecordsLayer({
      db,
      artifacts: bucket,
      artifactPath,
      issuedCredentials: () => Effect.succeed([]),
    });
    const m = manifest({
      entries: [
        { path: "specs/a.md", mode: "100644", digest: sha256(crlf) },
        { path: "specs/logo.bin", mode: "100644", digest: sha256(binary) },
      ],
    });
    const repo = fakeRepo();
    expect((await apply(repo, m, live))._tag).toBe("applied");
    expect([...repo.blobs.values()]).toEqual([crlf, binary]);

    bucket.objects.set(artifactPath("x1", 1, stagedBlobName(sha256(binary))), enc("swapped"));
    const swapped = fakeRepo();
    const refused = await apply(swapped, m, live);
    expect(refused).toMatchObject({ _tag: "refused" });
    expect((refused as { reason: string }).reason).toMatch(/^writeback: digest-mismatch/);
    expect(swapped.calls.filter((c) => WRITES.includes(c))).toEqual([]);
  });

  it("[FD-AGT-026] refuses a staged blob larger than maxBytes as too-large without reading its bytes", async () => {
    const db = recordsDb();
    db.exec(
      "insert into placements values ('x1', 'accepted', 1, 'e1', 1); insert into executors values ('e1', 'cloudflare')",
    );
    const bucket = memoryBucket();
    const big = new Uint8Array(DEFAULT_MAX_BYTES + 1);
    bucket.objects.set(artifactPath("x1", 1, stagedBlobName(sha256(big))), big);
    const live = writebackRecordsLayer({
      db,
      artifacts: bucket,
      artifactPath,
      issuedCredentials: () => Effect.succeed([]),
    });
    const m = manifest({
      entries: [{ path: "specs/big.bin", mode: "100644", digest: sha256(big) }],
    });
    const repo = fakeRepo();
    const refused = await apply(repo, m, live);
    expect(refused).toMatchObject({ _tag: "refused" });
    expect((refused as { reason: string }).reason).toMatch(/^writeback: too-large/);
    expect(bucket.reads).toEqual([]);
    expect(repo.calls.filter((c) => WRITES.includes(c))).toEqual([]);
  });

  it("[FD-GH-083] reuses the open pull request whose head is the manifest's branch", async () => {
    const repo = fakeRepo();
    await apply(repo, manifest());
    const second = await apply(
      repo,
      manifest({ pr: { title: "Again", body: "B2", draft: true, labels: [] } }),
    );
    expect(second).toEqual({ _tag: "applied", externalRef: "https://github.com/o/r/pull/1" });
    expect(repo.pulls).toHaveLength(1);
    expect(repo.pulls[0]?.title).toBe("Again");
  });

  it("[FD-AGT-016] [FD-AGT-018] a rejected manifest is refused with every reason before any GitHub call", async () => {
    const repo = fakeRepo();
    const bad = manifest({
      branch: "main",
      entries: [
        ...manifest().entries,
        { path: "runs/x.ts", mode: "100644", digest: sha256(enc("x")) },
      ],
    });
    const answer = await apply(repo, bad, recordsLayer({ blobs: { ...files, "runs/x.ts": "x" } }));
    expect(answer._tag).toBe("refused");
    const reason = (answer as { reason: string }).reason;
    expect(reason.startsWith("writeback: branch-invalid; ")).toBe(true);
    expect(refusalView(reason)).toEqual({
      firstKind: "branch-invalid",
      reasons: ["branch-invalid", "protected-path runs/x.ts", "outside-allowlist runs/x.ts"],
    });
    expect(repo.calls).toEqual([]);
  });

  it("[FD-AGT-032] a URL host present in the file at the base commit is read back before any write and accepted", async () => {
    const repo = fakeRepo();
    repo.files.set("specs/a.md", enc("see https://kept.example/x\n"));
    const text = "see https://kept.example/x\nmore https://kept.example/y\n";
    const m = manifest({
      entries: [{ path: "specs/a.md", mode: "100644", digest: sha256(enc(text)) }],
    });
    const answer = await apply(repo, m, recordsLayer({ blobs: { "specs/a.md": text } }));
    expect(answer._tag).toBe("applied");
    expect(repo.calls.slice(0, 1)).toEqual(["fileAt"]);
    const refused = await apply(fakeRepo(), m, recordsLayer({ blobs: { "specs/a.md": text } }));
    expect((refused as { reason: string }).reason).toMatch(/^writeback: url-not-allowed/);
  });

  it("[FD-GH-084] refuses a branch holding a commit whose author is not the App, and leaves it unchanged", async () => {
    const repo = fakeRepo();
    repo.commits.set("h".repeat(40), {
      sha: "h".repeat(40),
      message: "human",
      authorLogin: "dev",
      tree: "t",
      parents: [BASE_SHA],
    });
    repo.refs.set("flare-dispatch/spec-drift", "h".repeat(40));
    expect(await apply(repo, manifest())).toEqual({
      _tag: "refused",
      reason: "writeback: human-commits-present",
    });
    expect(repo.refs.get("flare-dispatch/spec-drift")).toBe("h".repeat(40));
    expect(repo.calls.filter((c) => WRITES.includes(c))).toEqual([]);
  });

  it("[FD-GH-082] refuses a protected branch under the prefix", async () => {
    const repo = fakeRepo();
    repo.protectedBranches.add("flare-dispatch/spec-drift");
    expect(await apply(repo, manifest())).toEqual({
      _tag: "refused",
      reason: "writeback: branch-invalid",
    });
    expect(repo.calls.filter((c) => WRITES.includes(c))).toEqual([]);
  });

  it("[FD-AGT-042] a failed record read answers retryable, never an empty staged write", async () => {
    const answer = await apply(fakeRepo(), manifest(), recordsLayer({ fail: true }));
    expect(answer).toEqual({ _tag: "retryable", reason: "writeback: read artifacts" });
  });

  it("[FD-AGT-038] a refusal leaves only the row's answer: the applier has no outcome to change", async () => {
    const answer = await apply(fakeRepo(), manifest({ branch: "feature/x" }));
    expect(Object.keys(answer).sort()).toEqual(["_tag", "reason"]);
  });

  it("a GitHub 5xx is retryable and a 4xx is refused", async () => {
    const repo = fakeRepo();
    repo.failNext = { call: "createTree", status: 502 };
    expect((await apply(repo, manifest()))._tag).toBe("retryable");
    const repo2 = fakeRepo();
    repo2.failNext = { call: "createPull", status: 422 };
    expect((await apply(repo2, manifest()))._tag).toBe("refused");
  });

  it("lookup finds the applier's commit for this execution and its open pull request", async () => {
    const repo = fakeRepo();
    const layer = fakeGitLayer(repo);
    const look = () =>
      Effect.runPromise(lookupPrPropose(row(manifest())).pipe(Effect.provide(layer)));
    expect(await look()).toEqual({ _tag: "absent" });
    await apply(repo, manifest());
    expect(await look()).toEqual({ _tag: "found", externalRef: "https://github.com/o/r/pull/1" });
  });
});

describe("pr.close", () => {
  const closeRow = (branch: string): IntentRow => ({
    ...row(manifest()),
    kind: "pr.close",
    intentKey: "run:close:0",
    payload: { repo: { owner: "o", name: "r" }, branch, base: "main" },
  });
  const close = (repo: FakeRepo, branch: string) =>
    Effect.runPromise(
      applyPrClose(config)(closeRow(branch)).pipe(Effect.provide(fakeGitLayer(repo))),
    );

  it("[FD-GH-087] [FD-AGT-070] closes the App's pull request, and refuses one carrying a human commit", async () => {
    const repo = fakeRepo();
    await apply(repo, manifest());
    expect((await close(repo, "flare-dispatch/spec-drift"))._tag).toBe("applied");
    expect(repo.pulls[0]?.open).toBe(false);

    const held = fakeRepo();
    await apply(held, manifest());
    const appHead = held.refs.get("flare-dispatch/spec-drift") as string;
    held.commits.set("h".repeat(40), {
      sha: "h".repeat(40),
      message: "human",
      authorLogin: "dev",
      tree: "t",
      parents: [appHead],
    });
    held.refs.set("flare-dispatch/spec-drift", "h".repeat(40));
    expect(await close(held, "flare-dispatch/spec-drift")).toEqual({
      _tag: "refused",
      reason: "writeback: human-commits-present",
    });
    expect(await close(held, "feature/x")).toEqual({
      _tag: "refused",
      reason: "writeback: branch-invalid",
    });
  });
});
