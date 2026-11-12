// The security gate's checkout against real git repositories: an origin with a target branch that moved after the
// pull request branched, and a pull request whose commits edit suppression files and add suppression markers.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processGateExec } from "./command.ts";
import { validPayload } from "./scan-bundle.test-support.ts";
import {
  addedLineNumbers,
  prepareScanCheckout,
  ScanBase,
  stripMarkers,
  type ScanCheckout,
} from "./scan-checkout.ts";

const SUPPRESSION = validPayload().suppression;
const MARKERS = SUPPRESSION.markers.map((m) => new RegExp(m, "g"));

const BASE_WORKFLOW = [
  "on: pull_request",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4 # zizmor: ignore[unpinned-uses]",
  "",
].join("\n");

let root: string;
let origin: string;
const commits: Record<string, string> = {};

const env = () => ({
  PATH: process.env["PATH"],
  HOME: root,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
});

const git = (cwd: string, ...args: readonly string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: env() }).trim();

const put = (path: string, content: string | Uint8Array) => {
  mkdirSync(dirname(join(origin, path)), { recursive: true });
  writeFileSync(join(origin, path), content);
};

const commit = (name: string) => {
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", name);
  commits[name] = git(origin, "rev-parse", "HEAD");
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fd-scan-checkout-"));
  process.env["FD_WORKSPACE_ROOT"] = root;
  origin = join(root, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  put(".gitleaksignore", "base-fingerprint\n");
  put("nested/.gitleaksignore", "nested-base\n");
  put("svc/osv-scanner.toml", "[[IgnoredVulns]]\nid = \"GHSA-base\"\n");
  put(".github/workflows/ci.yml", BASE_WORKFLOW);
  put("crlf.txt", "first\r\n");
  commit("base");
  git(origin, "checkout", "-q", "-b", "feature");
  put(".gitleaksignore", "base-fingerprint\nhead-fingerprint\n");
  put("pkg/osv-scanner.toml", "[[IgnoredVulns]]\nid = \"GHSA-head\"\n");
  commit("suppress");
  unlinkSync(join(origin, "svc/osv-scanner.toml"));
  put("notes.gitleaksignore", "not a suppression file\n");
  commit("delete");
  put(".gitattributes", "*.yml -diff\n");
  put(
    ".github/workflows/ci.yml",
    `${BASE_WORKFLOW}      - uses: evil/action@main # zizmor: ignore[unpinned-uses] # pinned later\n` +
      "      - run: echo # zizmor: ig# zizmor: ignore[a]nore[template-injection]\n" +
      "      - run: make\n",
  );
  put("crlf.txt", "first\r\nsecond # zizmor: ignore[x]\r\n");
  put("bom.yml", "\uFEFFkey: v # zizmor: ignore[z]\n");
  put("latin1.txt", Uint8Array.from([0xe9, 0x20, ...new TextEncoder().encode("# zizmor: ignore[y]"), 0x0a]));
  commit("markers");
  git(origin, "checkout", "-q", "main");
  put("main-only.txt", "the target branch moved\n");
  commit("main-tip");
});

afterAll(() => {
  delete process.env["FD_WORKSPACE_ROOT"];
  rmSync(root, { recursive: true, force: true });
});

const ctx = () => ({ repo: origin, sha: commits["markers"]!, ref: "refs/pull/1/head" });

/** Prepares the checkout, then runs `inspect` on it while its workspace still exists. */
const prepared = <A>(base: ScanBase, inspect: (checkout: ScanCheckout) => A) =>
  Effect.runPromise(
    Effect.scoped(
      prepareScanCheckout(ctx(), base, SUPPRESSION).pipe(Effect.map(inspect)),
    ).pipe(Effect.provide(processGateExec)),
  );

const pullRequest = ScanBase.TargetBranch({ branch: "main" });

describe("security-gate scan checkout", () => {
  it("[FD-GATE-092] fetches every commit from the merge base with the target branch to the head", async () => {
    const seen = await prepared(pullRequest, ({ dir, range }) => ({
      range,
      shallow: git(dir, "rev-parse", "--is-shallow-repository"),
      present: range.commits.map((c) => git(dir, "cat-file", "-t", c)),
      revList: git(dir, "rev-list", "--reverse", `${range.base}..${range.head}`).split("\n"),
      head: git(dir, "rev-parse", "HEAD"),
    }));
    expect(seen.range.base).toBe(commits["base"]);
    expect(seen.range.head).toBe(commits["markers"]);
    expect(seen.range.commits).toEqual([commits["suppress"], commits["delete"], commits["markers"]]);
    expect(seen.revList).toEqual(seen.range.commits);
    expect(seen.present).toEqual(["commit", "commit", "commit"]);
    expect(seen.shallow).toBe("false");
    expect(seen.head).toBe(commits["markers"]);
  });

  it("[FD-GATE-092] takes merge_group.base_sha as the base of a merge group's range", async () => {
    const range = await prepared(
      ScanBase.MergeGroup({ baseSha: commits["suppress"]! }),
      (c) => c.range,
    );
    expect(range.base).toBe(commits["suppress"]);
    expect(range.commits).toEqual([commits["delete"], commits["markers"]]);
  });

  it("[FD-GATE-093] restores each suppression file the range changes from the base commit, or deletes it", async () => {
    const seen = await prepared(pullRequest, ({ dir, restored, deleted }) => ({
      restored,
      deleted,
      gitleaksignore: readFileSync(join(dir, ".gitleaksignore"), "utf8"),
      svcOsv: readFileSync(join(dir, "svc/osv-scanner.toml"), "utf8"),
      pkgOsv: existsSync(join(dir, "pkg/osv-scanner.toml")),
      nested: readFileSync(join(dir, "nested/.gitleaksignore"), "utf8"),
      notes: readFileSync(join(dir, "notes.gitleaksignore"), "utf8"),
    }));
    expect(seen.gitleaksignore).toBe("base-fingerprint\n");
    expect(seen.svcOsv).toBe('[[IgnoredVulns]]\nid = "GHSA-base"\n');
    expect(seen.pkgOsv).toBe(false);
    expect(seen.nested).toBe("nested-base\n");
    expect(seen.notes).toBe("not a suppression file\n");
    expect([...seen.restored].sort()).toEqual([".gitleaksignore", "svc/osv-scanner.toml"]);
    expect(seen.deleted).toEqual(["pkg/osv-scanner.toml"]);
  });

  it("[FD-GATE-094] removes every marker match from the added lines only and leaves every other byte", async () => {
    const seen = await prepared(pullRequest, ({ dir, stripped }) => ({
      stripped,
      workflow: readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8"),
      crlf: readFileSync(join(dir, "crlf.txt"), "utf8"),
      bom: [...readFileSync(join(dir, "bom.yml"))],
      latin1: [...readFileSync(join(dir, "latin1.txt"))],
    }));
    expect(seen.workflow).toBe(
      `${BASE_WORKFLOW}      - uses: evil/action@main # pinned later\n      - run: echo\n      - run: make\n`,
    );
    expect(seen.crlf).toBe("first\r\nsecond\r\n");
    expect(seen.bom).toEqual([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("key: v\n")]);
    expect(seen.latin1).toEqual([0xe9, 0x0a]);
    expect([...seen.stripped].sort()).toEqual([
      ".github/workflows/ci.yml",
      "bom.yml",
      "crlf.txt",
      "latin1.txt",
    ]);
  });

  it("[FD-GATE-094] removes a marker that removing another match reassembles", () => {
    expect(stripMarkers("run: x # zizmor: ig# zizmor: ignore[a]nore[b]", MARKERS)).toBe("run: x");
    expect(stripMarkers("run: y # zizmor: ignore[a]\r", MARKERS)).toBe("run: y\r");
    expect(stripMarkers("run: z # zizmor: allow", MARKERS)).toBe("run: z # zizmor: allow");
  });

  it("[FD-GATE-094] reads the head lines each hunk of a zero-context patch adds", () => {
    const patch = ["@@ -3,0 +4,2 @@", "+a", "+b", "@@ -9 +11 @@", "-c", "+d", "@@ -20,2 +21,0 @@"].join(
      "\n",
    );
    expect(addedLineNumbers(patch)).toEqual([4, 5, 11]);
  });
});
