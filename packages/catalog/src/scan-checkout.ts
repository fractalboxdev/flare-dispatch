// The security gate's checkout (specs/runs/gate.md § Security gate, steps 2 to 4): the head commit in a fresh
// workspace with every commit of the scan range fetched (FD-GATE-092), each suppression file the range changes restored
// from the base commit or deleted where the base has none (FD-GATE-093), and each suppression marker removed from the
// lines the range adds (FD-GATE-094). Every step ends before the recipe starts any scanner.
//
// Git output the recipe parses goes to a file under `.git/`, never to the job log: a patch holds the added lines, and
// an added line may hold a secret (FD-GATE-098).
import { Data, Effect, type Scope } from "effect";
import { CommandExit, GateExec } from "./command.ts";
import { CheckoutFailed, jobEnv, shellQuote } from "./job.ts";
import type { GateContext } from "./manifest.ts";
import type { ScanBundlePayload } from "./scan-bundle.ts";

/** Where the scan range starts. */
export type ScanBase = Data.TaggedEnum<{
  /** A pull request: the merge base of the head and the target branch's head. */
  TargetBranch: { readonly branch: string };
  /** A merge group: `merge_group.base_sha`. */
  MergeGroup: { readonly baseSha: string };
  /**
   * A rescan: the merge base of the head and the default branch head, which the remote's `HEAD` names, so the base
   * follows the repository's default branch rather than a branch the request names (FD-GATE-112).
   */
  DefaultBranch: {};
}>;
export const ScanBase = Data.taggedEnum<ScanBase>();

/** `base..head`: the commits a scan covers and the paths they change. */
export interface ScanRange {
  readonly base: string;
  readonly head: string;
  /** Every commit of `base..head`, oldest first. */
  readonly commits: readonly string[];
  /** Every path `git diff --no-renames <base> <head>` lists. */
  readonly changed: readonly string[];
  /**
   * The changed paths the head commit holds as a regular file, in `changed` order: what a scanner may read. A deleted
   * path or a symbolic link is no scanner input.
   */
  readonly scannable: readonly string[];
}

/** A checkout ready for the scanners. */
export interface ScanCheckout {
  readonly dir: string;
  readonly range: ScanRange;
  /** Suppression files the recipe restored from the base commit. */
  readonly restored: readonly string[];
  /** Suppression files the base commit has no entry for, which the recipe deleted. */
  readonly deleted: readonly string[];
  /** Files from whose added lines the recipe removed a marker match. */
  readonly stripped: readonly string[];
}

const FETCH_TIMEOUT_SEC = 600;
const GIT_TIMEOUT_SEC = 120;
const JOB = "scan-checkout";
/** The file each parsed git command writes its stdout to. */
const CAPTURE = ".git/fd-scan-capture";
const COMMIT = /^[0-9a-f]{40}$/;
const HEAD_REF = "refs/fd/scan-head";
const TARGET_REF = "refs/fd/scan-target";

const decoder = new TextDecoder();

/**
 * Splits `bytes` at each `\n` into lines without it; the segment after the last `\n` is the last element, empty where
 * the file ends with a newline.
 */
const splitLines = (bytes: Uint8Array): Uint8Array[] => {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++)
    if (bytes[i] === 0x0a) {
      lines.push(bytes.subarray(start, i));
      start = i + 1;
    }
  lines.push(bytes.subarray(start));
  return lines;
};

const joinLines = (lines: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(lines.reduce((n, l) => n + l.length, 0) + lines.length - 1);
  let at = 0;
  lines.forEach((line, i) => {
    out.set(line, at);
    at += line.length;
    if (i < lines.length - 1) out[at++] = 0x0a;
  });
  return out;
};

// `ignoreBOM` keeps a leading byte order mark in the text, so a rewritten first line keeps it too.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * One line as text and the way back to bytes. A line that is not UTF-8 reads one character per byte, so a marker of
 * ASCII characters still matches it and the bytes round-trip unchanged.
 */
const lineText = (bytes: Uint8Array): { readonly text: string; readonly encode: (s: string) => Uint8Array } => {
  try {
    return { text: utf8.decode(bytes), encode: (s) => new TextEncoder().encode(s) };
  } catch {
    return {
      text: Array.from(bytes, (b) => String.fromCharCode(b)).join(""),
      encode: (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff),
    };
  }
};

/**
 * `line` with every match of `markers` removed, until no marker matches: removing one match can join the text around it
 * into another. A line ending in `\r` keeps it.
 */
export const stripMarkers = (line: string, markers: readonly RegExp[]): string => {
  const cr = line.endsWith("\r");
  let text = cr ? line.slice(0, -1) : line;
  for (let before = ""; before !== text; ) {
    before = text;
    for (const marker of markers) text = text.replace(marker, "");
  }
  return cr ? `${text}\r` : text;
};

/** The head-side line numbers each hunk of a `--unified=0` patch adds. */
export const addedLineNumbers = (patch: string): readonly number[] => {
  const numbers: number[] = [];
  for (const m of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let n = start; n < start + count; n++) numbers.push(n);
  }
  return numbers;
};

/** One entry of `git diff --raw -z`: the head side's mode and the path. */
interface RawEntry {
  readonly headMode: string;
  readonly status: string;
  readonly path: string;
}

/** Parses `git diff --raw -z --no-renames`: a `:<modes> <ids> <status>` field, then the path, each NUL-ended. */
export const parseRawDiff = (output: string): readonly RawEntry[] => {
  const fields = output.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, headMode = "", , , status = ""] = fields[i]!.slice(1).split(" ");
    entries.push({ headMode, status, path: fields[i + 1]! });
  }
  return entries;
};

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const REGULAR_FILE = new Set(["100644", "100755"]);

/**
 * The scan's checkout of `ctx.sha` (specs/runs/gate.md § Security gate, steps 2 to 4). A fetch, a git command or a
 * workspace read or write that fails is `CheckoutFailed`, so the scan never starts on a partial range.
 */
export const prepareScanCheckout = (
  ctx: GateContext,
  base: ScanBase,
  suppression: ScanBundlePayload["suppression"],
): Effect.Effect<ScanCheckout, CheckoutFailed, GateExec | Scope.Scope> =>
  Effect.gen(function* () {
    const exec = yield* GateExec;
    const dir = yield* exec.workspace;

    const run = (step: string, command: string, timeoutSec = GIT_TIMEOUT_SEC) =>
      Effect.gen(function* () {
        const { exit } = yield* exec.run({
          command,
          cwd: dir,
          env: jobEnv(ctx, JOB),
          timeoutMs: timeoutSec * 1000,
          ...(ctx.deadlineAt === undefined ? {} : { deadlineAt: ctx.deadlineAt }),
        });
        if (!CommandExit.$is("Exited")(exit) || exit.code !== 0)
          return yield* new CheckoutFailed({
            detail: `${step}: ${CommandExit.$is("Exited")(exit) ? `exit ${exit.code}` : exit._tag}`,
          });
      });
    const read = (path: string) =>
      exec
        .readFile(`${dir}/${path}`)
        .pipe(
          Effect.catchTag("WorkspaceReadFailed", (e) =>
            Effect.fail(new CheckoutFailed({ detail: `read ${e.path}: ${e.detail}` })),
          ),
        );
    /** A git command's stdout, written to a file under `.git/` rather than to the job log. */
    const capture = (step: string, command: string) =>
      run(step, `${command} > ${CAPTURE}`).pipe(Effect.andThen(read(CAPTURE)));
    const text = (step: string, command: string) =>
      capture(step, command).pipe(Effect.map((bytes) => decoder.decode(bytes).trim()));

    // Step 2 and FD-GATE-092: the head and the base side with their whole history, so `base..head` holds every
    // commit of the range rather than the one commit a depth-1 fetch brings.
    if (ScanBase.$is("MergeGroup")(base) && !COMMIT.test(base.baseSha))
      return yield* new CheckoutFailed({ detail: `merge_group.base_sha ${base.baseSha}` });
    const baseSpec = ScanBase.$match(base, {
      TargetBranch: ({ branch }) => `+refs/heads/${branch}:${TARGET_REF}`,
      MergeGroup: ({ baseSha }) => `+${baseSha}:${TARGET_REF}`,
      DefaultBranch: () => `+HEAD:${TARGET_REF}`,
    });
    // The fetch reaches the repository's git host, an egress FD-GATE-110 does not grant: the open item in
    // specs/runs/gate.md decides whether the control plane stages this history or the spec allows that host.
    yield* run("init", `git init -q . && git remote add origin ${shellQuote(ctx.repo)}`);
    yield* run(
      "fetch",
      `git fetch -q --no-tags origin ${shellQuote(`+${ctx.sha}:${HEAD_REF}`)} ${shellQuote(baseSpec)}`,
      FETCH_TIMEOUT_SEC,
    );
    if ((yield* text("shallow", "git rev-parse --is-shallow-repository")) !== "false")
      return yield* new CheckoutFailed({ detail: "fetch: shallow history" });
    yield* run("checkout", `git -c advice.detachedHead=false checkout -q --detach ${HEAD_REF}`);
    const head = ctx.sha;
    const baseCommit = yield* ScanBase.$match(base, {
      TargetBranch: () => text("merge-base", `git merge-base ${HEAD_REF} ${TARGET_REF}`),
      MergeGroup: ({ baseSha }) => text("base", `git rev-parse --verify ${baseSha}^{commit}`),
      DefaultBranch: () => text("merge-base", `git merge-base ${HEAD_REF} ${TARGET_REF}`),
    });
    if (!COMMIT.test(baseCommit))
      return yield* new CheckoutFailed({ detail: `base: ${baseCommit}` });
    const commits = (yield* text("rev-list", `git rev-list --reverse ${baseCommit}..${head}`))
      .split("\n")
      .filter((c) => c !== "");
    const entries = parseRawDiff(
      decoder.decode(
        yield* capture("diff", `git diff --raw -z --no-renames --no-abbrev ${baseCommit} ${head}`),
      ),
    );
    const range: ScanRange = {
      base: baseCommit,
      head,
      commits,
      changed: entries.map((e) => e.path),
      scannable: entries
        .filter((e) => e.status !== "D" && REGULAR_FILE.has(e.headMode))
        .map((e) => e.path),
    };

    // Step 3 and FD-GATE-093: each suppression file the range changes takes the base commit's content, or leaves the
    // checkout where the base commit has none.
    const names = new Set(suppression.files);
    const restored: string[] = [];
    const deleted: string[] = [];
    for (const { path } of entries) {
      if (!names.has(baseName(path))) continue;
      const quoted = shellQuote(path);
      const atBase = yield* text(
        "ls-tree",
        `git --literal-pathspecs ls-tree -z --full-tree ${baseCommit} -- ${quoted}`,
      );
      if (atBase !== "") {
        yield* run("restore", `git --literal-pathspecs checkout -q ${baseCommit} -- ${quoted}`);
        restored.push(path);
      } else {
        yield* run("delete", `rm -rf -- ./${quoted}`);
        deleted.push(path);
      }
    }

    // Step 4 and FD-GATE-094: every marker match leaves the lines the range adds; every other line keeps its bytes. A
    // restored or deleted file holds no line of the head, so the head's added line numbers do not apply to it.
    const markers = suppression.markers.map((m) => new RegExp(m, "g"));
    const probes = suppression.markers.map((m) => new RegExp(m));
    const handled = new Set([...restored, ...deleted]);
    const stripped: string[] = [];
    for (const { path, headMode, status } of entries) {
      if (status === "D" || handled.has(path) || !REGULAR_FILE.has(headMode)) continue;
      const lines = splitLines(yield* read(path));
      const decoded = lines.map(lineText);
      if (!decoded.some((d) => probes.some((p) => p.test(d.text)))) continue;
      // `--text` reads every file as text, so a head `.gitattributes` that marks a file binary cannot hide its lines.
      const patch = decoder.decode(
        yield* capture(
          "added lines",
          `git --literal-pathspecs diff --no-color --no-ext-diff --no-textconv --text --no-renames --unified=0 ${baseCommit} ${head} -- ${shellQuote(path)}`,
        ),
      );
      let changed = false;
      for (const n of addedLineNumbers(patch)) {
        const line = decoded[n - 1];
        if (line === undefined) continue;
        const after = stripMarkers(line.text, markers);
        if (after === line.text) continue;
        lines[n - 1] = line.encode(after);
        changed = true;
      }
      if (!changed) continue;
      yield* exec
        .writeFile(`${dir}/${path}`, joinLines(lines))
        .pipe(
          Effect.catchTag("WorkspaceWriteFailed", (e) =>
            Effect.fail(new CheckoutFailed({ detail: `write ${e.path}: ${e.detail}` })),
          ),
        );
      stripped.push(path);
    }
    yield* run("capture cleanup", `rm -f ${CAPTURE}`);
    return { dir, range, restored, deleted, stripped };
  });
