// The security gate's checkout against a real git remote: a bare repository served over git's `file://` transport,
// as GitHub serves a repository, holding a target branch, a pull request head that only `refs/pull/7/head` reaches,
// and the merge queue's commit of that pull request on the moved target branch. The scan checkout runs as a gate job
// runs it, through `processGateExec` in a fresh workspace, and the test reads what the scanners would read there.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processGateExec } from "../../../../packages/catalog/src/command.ts";
import {
  prepareScanCheckout,
  ScanBase,
  type ScanCheckout,
} from "../../../../packages/catalog/src/scan-checkout.ts";

/** The scan bundle's `suppression` section as a deployment pins it. */
const SUPPRESSION = {
  files: [".gitleaksignore", "osv-scanner.toml"],
  markers: ["\\s*# zizmor: ignore\\[[^\\]]*\\]"],
};

const WORKFLOW = [
  "on: pull_request",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4 # zizmor: ignore[unpinned-uses]",
  "",
].join("\n");
const ADDED_STEP = "      - uses: evil/action@main # zizmor: ignore[unpinned-uses]\n";
const RELEASE = "on: push\njobs:\n  release:\n    steps:\n      - run: ${{ github.ref }} # zizmor: ignore[template-injection]\n";

let root: string;
let bare: string;
let work: string;
let url: string;
const sha: Record<string, string> = {};

const git = (cwd: string, ...args: readonly string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"],
      HOME: root,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

const put = (path: string, content: string) => {
  mkdirSync(dirname(join(work, path)), { recursive: true });
  writeFileSync(join(work, path), content);
};

const commit = (name: string) => {
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", name);
  sha[name] = git(work, "rev-parse", "HEAD");
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fd-security-gate-"));
  process.env["FD_WORKSPACE_ROOT"] = root;
  bare = join(root, "widgets.git");
  work = join(root, "author");
  url = `file://${bare}`;
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  git(work, "remote", "add", "origin", url);

  put(".gitleaksignore", "target-fingerprint\n");
  put("api/osv-scanner.toml", '[[IgnoredVulns]]\nid = "GHSA-target"\n');
  put("api/package-lock.json", '{"lockfileVersion":3}\n');
  put(".github/workflows/ci.yml", WORKFLOW);
  commit("target");
  git(work, "push", "-q", "origin", "main");

  // The pull request: it widens the gitleaks ignore list, drops the target branch's OSV ignore file, adds one beside a
  // new lockfile and suppresses a zizmor finding on the step it adds. Only `refs/pull/7/head` reaches its head.
  git(work, "checkout", "-q", "-b", "pr");
  put(".gitleaksignore", "target-fingerprint\nleaked-key-fingerprint\n");
  rmSync(join(work, "api/osv-scanner.toml"));
  put("web/osv-scanner.toml", '[[IgnoredVulns]]\nid = "GHSA-head"\n');
  put("web/package-lock.json", '{"lockfileVersion":3,"packages":{}}\n');
  commit("suppress");
  put(".github/workflows/ci.yml", `${WORKFLOW}${ADDED_STEP}`);
  commit("step");
  git(work, "push", "-q", "origin", "pr:refs/pull/7/head");

  // The target branch moves after the pull request branched: a new ignore entry and a workflow with its own marker.
  git(work, "checkout", "-q", "main");
  put(".gitleaksignore", "target-fingerprint\nrotated-fingerprint\n");
  put(".github/workflows/release.yml", RELEASE);
  commit("moved");
  git(work, "push", "-q", "origin", "main");

  // The merge queue's commit: the pull request merged onto the moved target branch.
  git(work, "checkout", "-q", "-b", "queue");
  git(work, "merge", "-q", "--no-edit", "-X", "theirs", "pr");
  sha["queue"] = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", "origin", `queue:refs/heads/gh-readonly-queue/main/pr-7-${sha["step"]}`);
});

afterAll(() => {
  delete process.env["FD_WORKSPACE_ROOT"];
  rmSync(root, { recursive: true, force: true });
});

const scan = <A>(head: string, base: ScanBase, inspect: (checkout: ScanCheckout) => A) =>
  Effect.runPromise(
    Effect.scoped(
      prepareScanCheckout({ repo: url, sha: head, ref: "refs/pull/7/head" }, base, SUPPRESSION).pipe(
        Effect.map(inspect),
      ),
    ).pipe(Effect.provide(processGateExec)),
  );

const read = (dir: string, path: string) =>
  existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null;

describe("security-gate checkout on a real remote", () => {
  it("[FD-GATE-093] a pull request's scan reads the merge base's suppression files, not the head's", async () => {
    const seen = await scan(sha["step"]!, ScanBase.TargetBranch({ branch: "main" }), (c) => ({
      base: c.range.base,
      commits: c.range.commits,
      gitleaksignore: read(c.dir, ".gitleaksignore"),
      apiOsv: read(c.dir, "api/osv-scanner.toml"),
      webOsv: read(c.dir, "web/osv-scanner.toml"),
      webLock: read(c.dir, "web/package-lock.json"),
    }));
    expect(seen.base).toBe(sha["target"]);
    expect(seen.commits).toEqual([sha["suppress"], sha["step"]]);
    expect(seen.gitleaksignore).toBe("target-fingerprint\n");
    expect(seen.apiOsv).toBe('[[IgnoredVulns]]\nid = "GHSA-target"\n');
    expect(seen.webOsv).toBeNull();
    expect(seen.webLock).toBe('{"lockfileVersion":3,"packages":{}}\n');
  });

  it("[FD-GATE-094] a pull request's scan reads its added step without the marker and the target's marker intact", async () => {
    const workflow = await scan(sha["step"]!, ScanBase.TargetBranch({ branch: "main" }), (c) =>
      read(c.dir, ".github/workflows/ci.yml"),
    );
    expect(workflow).toBe(`${WORKFLOW}      - uses: evil/action@main\n`);
  });

  it("[FD-GATE-093] a merge group's scan restores the suppression files of merge_group.base_sha", async () => {
    const seen = await scan(sha["queue"]!, ScanBase.MergeGroup({ baseSha: sha["moved"]! }), (c) => ({
      base: c.range.base,
      commits: [...c.range.commits].sort(),
      gitleaksignore: read(c.dir, ".gitleaksignore"),
      apiOsv: read(c.dir, "api/osv-scanner.toml"),
      webOsv: read(c.dir, "web/osv-scanner.toml"),
    }));
    expect(seen.base).toBe(sha["moved"]);
    expect(seen.commits).toEqual([sha["suppress"], sha["step"], sha["queue"]].sort());
    expect(seen.gitleaksignore).toBe("target-fingerprint\nrotated-fingerprint\n");
    expect(seen.apiOsv).toBe('[[IgnoredVulns]]\nid = "GHSA-target"\n');
    expect(seen.webOsv).toBeNull();
  });

  it("[FD-GATE-094] a merge group's scan keeps the marker the base already holds and strips the one the group adds", async () => {
    const seen = await scan(sha["queue"]!, ScanBase.MergeGroup({ baseSha: sha["moved"]! }), (c) => ({
      ci: read(c.dir, ".github/workflows/ci.yml"),
      release: read(c.dir, ".github/workflows/release.yml"),
    }));
    expect(seen.ci).toBe(`${WORKFLOW}      - uses: evil/action@main\n`);
    expect(seen.release).toBe(RELEASE);
  });
});
