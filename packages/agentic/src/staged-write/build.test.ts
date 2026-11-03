import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { buildStagedWrite } from "./build.ts";

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
  it("FD-AGT-012 holds every tracked change and untracked file not ignored, excluding its staging directory (S8 assumption)", async () => {
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

  it("FD-AGT-013 stores each blob byte for byte under its SHA-256 digest, with its mode", async () => {
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
