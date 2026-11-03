// The executor's side of a staged write: the tracked changes against the base commit plus the untracked files
// `.gitignore` does not match, minus the staging directory, each blob stored byte for byte under its SHA-256 digest
// (FD-AGT-012, FD-AGT-013). It runs in the job sandbox, so it imports Node APIs and the control plane never loads it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";
import type { Manifest, ManifestEntry, PullRequestFields } from "./manifest.ts";

export class StagingFailed extends Schema.TaggedError<StagingFailed>()("StagingFailed", {
  step: Schema.String,
  detail: Schema.String,
}) {}

const git = (cwd: string, args: readonly string[]) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((ok, fail) =>
        execFile("git", [...args], { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
          error === null ? ok(stdout) : fail(error),
        ),
      ),
    catch: (cause) => new StagingFailed({ step: `git ${args[0]}`, detail: String(cause) }),
  });

const nulList = (out: string): readonly string[] => out.split("\0").filter((p) => p !== "");

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export interface StageInput {
  readonly checkout: string;
  readonly baseCommit: string;
  /** Where the blobs and the manifest are written; excluded from the staged write when inside the checkout. */
  readonly stagingDir: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly message: string;
  readonly pr: PullRequestFields;
}

export interface StagedWrite {
  readonly manifest: Manifest;
  /** Tracked paths removed against the base commit. The manifest has no deletion entry, so they are reported here. */
  readonly deleted: readonly string[];
}

/**
 * Builds and stores the staged write. Each blob is written to `<stagingDir>/blobs/<sha256>` and the manifest to
 * `<stagingDir>/manifest.json`.
 */
export const buildStagedWrite = (input: StageInput): Effect.Effect<StagedWrite, StagingFailed> =>
  Effect.gen(function* () {
    const checkout = resolve(input.checkout);
    const staging = relative(checkout, resolve(input.stagingDir));
    const insideStaging = (path: string) =>
      !staging.startsWith("..") &&
      staging !== "" &&
      (path === staging || path.startsWith(`${staging.split(sep).join("/")}/`));

    const changed = nulList(
      yield* git(checkout, ["diff", "--name-only", "-z", "--no-renames", input.baseCommit, "--"]),
    );
    const untracked = nulList(
      yield* git(checkout, ["ls-files", "--others", "--exclude-standard", "-z"]),
    );
    const paths = [...new Set([...changed, ...untracked])].filter((p) => !insideStaging(p)).sort();

    yield* Effect.tryPromise({
      try: () => mkdir(join(input.stagingDir, "blobs"), { recursive: true }),
      catch: (cause) => new StagingFailed({ step: "mkdir", detail: String(cause) }),
    });

    const entries: ManifestEntry[] = [];
    const deleted: string[] = [];
    for (const path of paths) {
      const absolute = join(checkout, path);
      const stat = yield* Effect.tryPromise({
        try: () =>
          lstat(absolute).then(
            (s) => s,
            () => null,
          ),
        catch: (cause) => new StagingFailed({ step: "stat", detail: String(cause) }),
      });
      if (stat === null) {
        deleted.push(path);
        continue;
      }
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(absolute),
        catch: (cause) => new StagingFailed({ step: "read", detail: `${path}: ${String(cause)}` }),
      });
      const digest = sha256Hex(bytes);
      yield* Effect.tryPromise({
        try: () => writeFile(join(input.stagingDir, "blobs", digest), bytes),
        catch: (cause) => new StagingFailed({ step: "store", detail: String(cause) }),
      });
      const mode = stat.isSymbolicLink()
        ? "120000"
        : (stat.mode & 0o111) !== 0
          ? "100755"
          : "100644";
      entries.push({ path, mode, digest });
    }

    const manifest: Manifest = {
      branch: input.branch,
      baseBranch: input.baseBranch,
      baseCommit: input.baseCommit,
      message: input.message,
      pr: input.pr,
      entries,
    };
    yield* Effect.tryPromise({
      try: () => writeFile(join(input.stagingDir, "manifest.json"), JSON.stringify(manifest)),
      catch: (cause) => new StagingFailed({ step: "manifest", detail: String(cause) }),
    });
    return { manifest, deleted };
  });
