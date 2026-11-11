import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { stagedWritesLayer } from "../recipes/executor-layers.ts";
import { StagedWrites } from "../recipes/services.ts";
import { artifactPrefixSink, buildStagedWrite, uploadStagedWrite } from "./build.ts";
import { STAGED_WRITE_MANIFEST, stagedBlobName } from "./manifest.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

const repo = async () => {
  const dir = await mkdtemp(join(tmpdir(), "fd-stage-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  await writeFile(join(dir, "kept.txt"), "kept\n");
  await writeFile(join(dir, "edited.txt"), "before\n");
  await writeFile(join(dir, "removed.txt"), "gone\n");
  await writeFile(join(dir, ".gitignore"), "ignored.log\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
};

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

describe("buildStagedWrite", () => {
  it("[FD-AGT-012] holds every tracked change and untracked file not ignored, excluding its staging directory (S8 assumption)", async () => {
    const { dir, base } = await repo();
    await writeFile(join(dir, "edited.txt"), "after\n");
    await rm(join(dir, "removed.txt"));
    await mkdir(join(dir, "new"), { recursive: true });
    await writeFile(join(dir, "new/file.txt"), "new\n");
    await writeFile(join(dir, "ignored.log"), "noise\n");
    await writeFile(join(dir, "staged-only.txt"), "index\n");
    git(dir, "add", "staged-only.txt");
    const staging = join(dir, ".fd-staging");

    const { manifest, deleted } = await Effect.runPromise(
      buildStagedWrite({
        checkout: dir,
        baseCommit: base,
        stagingDir: staging,
        branch: "flare-dispatch/x",
        baseBranch: "main",
        message: "m",
        pr: { title: "t", body: "b", draft: true, labels: [] },
      }),
    );
    expect(manifest.entries.map((e) => e.path)).toEqual([
      "edited.txt",
      "new/file.txt",
      "staged-only.txt",
    ]);
    expect(deleted).toEqual(["removed.txt"]);
    expect(manifest.baseCommit).toBe(base);
  });

  it("[FD-AGT-013] stores each blob byte for byte under its SHA-256 digest, with its mode", async () => {
    const { dir, base } = await repo();
    const binary = Uint8Array.from([0, 255, 10, 13, 128, 7]);
    await writeFile(join(dir, "bin.dat"), binary);
    await writeFile(join(dir, "run.sh"), "#!/bin/sh\r\necho hi\r\n");
    await chmod(join(dir, "run.sh"), 0o755);
    const staging = await mkdtemp(join(tmpdir(), "fd-staging-"));
    dirs.push(staging);
    const { manifest } = await Effect.runPromise(
      buildStagedWrite({
        checkout: dir,
        baseCommit: base,
        stagingDir: staging,
        branch: "flare-dispatch/x",
        baseBranch: "main",
        message: "m",
        pr: { title: "t", body: "b", draft: true, labels: [] },
      }),
    );
    const bin = manifest.entries.find((e) => e.path === "bin.dat");
    const script = manifest.entries.find((e) => e.path === "run.sh");
    expect(bin).toEqual({ path: "bin.dat", mode: "100644", digest: sha(binary) });
    expect(script?.mode).toBe("100755");
    expect(new Uint8Array(await readFile(join(staging, "blobs", bin?.digest as string)))).toEqual(
      binary,
    );
    expect(await readFile(join(staging, "blobs", script?.digest as string), "utf8")).toBe(
      "#!/bin/sh\r\necho hi\r\n",
    );
    expect(JSON.parse(await readFile(join(staging, "manifest.json"), "utf8"))).toEqual(manifest);
  });

  it("[FD-AGT-013] uploads each blob byte for byte under its digest, then the manifest, to the execution's artifact prefix", async () => {
    const { dir, base } = await repo();
    const binary = Uint8Array.from([0, 255, 10, 13, 128, 7]);
    await writeFile(join(dir, "bin.dat"), binary);
    await writeFile(join(dir, "copy.dat"), binary);
    await writeFile(join(dir, "edited.txt"), "after\r\n");
    const staging = await mkdtemp(join(tmpdir(), "fd-staging-"));
    dirs.push(staging);
    const stored = new Map<string, { bytes: Uint8Array; sha256: string }>();
    const prefix = "artifacts/x1/2/";
    const layer = stagedWritesLayer(
      dir,
      base,
      staging,
      artifactPrefixSink(prefix, async (key, bytes, sha256) => {
        stored.set(key, { bytes: new Uint8Array(bytes), sha256 });
      }),
    );
    const manifest = await Effect.runPromise(
      Effect.flatMap(StagedWrites, (s) =>
        s.stage({
          branch: "flare-dispatch/x",
          baseBranch: "main",
          message: "m",
          pr: { title: "t", body: "b", draft: true, labels: [] },
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(manifest.entries.map((e) => e.path)).toEqual(["bin.dat", "copy.dat", "edited.txt"]);
    expect([...stored.keys()]).toEqual([
      `${prefix}${stagedBlobName(sha(binary))}`,
      `${prefix}${stagedBlobName(sha("after\r\n"))}`,
      `${prefix}${STAGED_WRITE_MANIFEST}`,
    ]);
    const bin = stored.get(`${prefix}${stagedBlobName(sha(binary))}`);
    expect(bin).toEqual({ bytes: binary, sha256: sha(binary) });
    const text = stored.get(`${prefix}${stagedBlobName(sha("after\r\n"))}`);
    expect(new TextDecoder().decode(text?.bytes)).toBe("after\r\n");
    const uploaded = stored.get(`${prefix}${STAGED_WRITE_MANIFEST}`);
    expect(JSON.parse(new TextDecoder().decode(uploaded?.bytes))).toEqual(manifest);
    expect(uploaded?.sha256).toBe(sha(uploaded?.bytes as Uint8Array));
  });

  it("[FD-AGT-013] refuses to upload a staged blob whose bytes no longer hash to its digest", async () => {
    const { dir, base } = await repo();
    await writeFile(join(dir, "edited.txt"), "after\n");
    const staging = await mkdtemp(join(tmpdir(), "fd-staging-"));
    dirs.push(staging);
    const { manifest } = await Effect.runPromise(
      buildStagedWrite({
        checkout: dir,
        baseCommit: base,
        stagingDir: staging,
        branch: "flare-dispatch/x",
        baseBranch: "main",
        message: "m",
        pr: { title: "t", body: "b", draft: true, labels: [] },
      }),
    );
    await writeFile(join(staging, "blobs", sha("after\n")), "tampered\n");
    const stored: string[] = [];
    const failure = await Effect.runPromise(
      uploadStagedWrite(staging, manifest, {
        put: async (name) => {
          stored.push(name);
        },
      }).pipe(Effect.flip),
    );
    expect(failure).toMatchObject({ _tag: "StagingFailed", step: "upload" });
    expect(stored).toEqual([]);
  });

  it("a git failure is a StagingFailed error, never an empty staged write", async () => {
    const { dir } = await repo();
    const exit = await Effect.runPromiseExit(
      buildStagedWrite({
        checkout: dir,
        baseCommit: "0".repeat(40),
        stagingDir: join(dir, ".s"),
        branch: "flare-dispatch/x",
        baseBranch: "main",
        message: "m",
        pr: { title: "t", body: "b", draft: true, labels: [] },
      }).pipe(Effect.flip),
    );
    expect(exit._tag === "Success" && exit.value._tag).toBe("StagingFailed");
  });
});
