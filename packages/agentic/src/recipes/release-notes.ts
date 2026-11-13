// `release-notes`, the proposing execution: the commit range from the newest `v<semver>` tag reachable from the
// default branch to its head, read inside an Activity; a `skipped` verdict on an empty range; the next version from
// Conventional Commits; one `judgment` call for the highlights; and a release pull request, not a draft, on
// `flare-dispatch/release` whose body carries the execution, version and head marker that approval intake reads.
// The publish execution intake starts on an approval drafts and publishes that version's release
// (specs/runs/agentic.md § `release-notes`).
import type { RunResult } from "@fractalboxdev/mameko-run";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import { sanitizeModelText } from "../boundary.ts";
import { checkSuppression, suppressionKey, suppressionReadFailed } from "../suppression/ledger.ts";
import { ReadFailed } from "./spec-drift-pr.ts";
import {
  Checkout,
  ExecutionIdentity,
  ModelClient,
  modelFailureVerdict,
  RecipeIntents,
  Shell,
  StagedWrites,
} from "./services.ts";
import { flattenLine } from "./triage-prs.ts";

const CommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

/** An approved release: what intake read off the release pull request when it started the publish (FD-AGT-085). */
export const ReleasePublishInput = Schema.Struct({
  /** The version the release pull request's marker names, `v<major>.<minor>.<patch>`. */
  version: Schema.String.check(Schema.isPattern(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)),
  /** The approved commit, which the release's tag points at. */
  commit: CommitSha,
  /** The release pull request's head when it was approved, which holds the version's notes file. */
  notesCommit: CommitSha,
  /** The release pull request's number. */
  pullRequest: Schema.Number,
});
export type ReleasePublishInput = typeof ReleasePublishInput.Type;

export const ReleaseNotesInput = Schema.Struct({
  repo: Schema.Struct({ owner: Schema.String, name: Schema.String }),
  /** The default branch; the execution's checkout holds its head. */
  baseBranch: Schema.String,
  /** Present on a publish execution, which drafts and publishes this release instead of proposing one. */
  publish: Schema.optionalKey(ReleasePublishInput),
});
export type ReleaseNotesInput = typeof ReleaseNotesInput.Type;

/**
 * The `release-notes` input a caller may name: a dispatch, an MCP call, a local submit or a follow-on intent proposes a release and never names `publish`. Only intake's release approval builds a publish input, so
 * no publish starts without an approval inside the window and with no recorded rejection (FD-AGT-085 to FD-AGT-087,
 * FD-INT-066).
 */
export const ReleaseNotesRequestInput = Schema.Struct({
  repo: ReleaseNotesInput.fields.repo,
  baseBranch: ReleaseNotesInput.fields.baseBranch,
  publish: Schema.optionalKey(Schema.Never),
});

/** The release pull request's branch, which the catalogue's writeback block names (FD-AGT-084). */
export const RELEASE_NOTES_BRANCH = "flare-dispatch/release";
/** The notes file of a version, inside the writeback allowlist. */
export const releaseNotesPath = (version: string) => `.flare-dispatch/release/${version}.md`;
/** The detail of the verdict on an empty commit range (FD-AGT-082). */
export const EMPTY_RANGE_DETAIL = "empty-range";
/** Commits listed in the model prompt; the notes file lists every commit. */
export const PROMPT_MAX_COMMITS = 400;
/** Characters of a commit description in the notes. */
export const DESCRIPTION_MAX_CHARS = 200;
/** Characters of the notes the pull-request body holds before it points at the notes file instead. */
export const BODY_NOTES_MAX_CHARS = 50_000;
/** Characters of a GitHub release body; longer notes are cut at a line and point at the notes file. */
export const RELEASE_BODY_MAX_CHARS = 125_000;

// ---------------------------------------------------------------------------
// Versions (FD-AGT-081, FD-AGT-083)

export interface ReleaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The version a `v<major>.<minor>.<patch>` tag names, or null for any other tag, a pre-release among them. */
export const parseReleaseTag = (tag: string): ReleaseVersion | null => {
  const m = RELEASE_TAG.exec(tag);
  return m === null ? null : { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
};

export const formatVersion = (v: ReleaseVersion) => `v${v.major}.${v.minor}.${v.patch}`;

const compareVersions = (a: ReleaseVersion, b: ReleaseVersion) =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/**
 * The newest release tag among the tags reachable from the default branch's head: the highest `v<semver>` version,
 * which on one line of history is also the latest one cut. Tags of any other shape are ignored; null when none is a
 * release tag.
 */
export const newestReleaseTag = (tags: readonly string[]): string | null => {
  let newest: { tag: string; version: ReleaseVersion } | null = null;
  for (const tag of tags) {
    const version = parseReleaseTag(tag.trim());
    if (version !== null && (newest === null || compareVersions(version, newest.version) > 0))
      newest = { tag: tag.trim(), version };
  }
  return newest?.tag ?? null;
};

export type ReleaseBump = "major" | "minor" | "patch";

export interface RangeCommit {
  readonly sha: string;
  readonly subject: string;
  /** Whether the message carries a `BREAKING CHANGE:` or `BREAKING-CHANGE:` footer. */
  readonly breakingFooter: boolean;
}

export interface ConventionalCommit {
  /** The lower-cased type, or `other` when the subject is not a Conventional Commit header. */
  readonly type: string;
  readonly breaking: boolean;
  readonly description: string;
  /** The pull-request number of a trailing `(#123)`. */
  readonly pr: number | null;
}

const HEADER = /^(\w+)(?:\([^)\n]*\))?(!)?:\s*(.+)$/;
const TRAILING_PR = /\s*\(#(\d+)\)\s*$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

/** A commit subject as a Conventional Commit: `type(scope)!: description`, breaking on a `!` or the footer. */
export const parseConventionalCommit = (c: RangeCommit): ConventionalCommit => {
  const m = HEADER.exec(c.subject.trim());
  const description = (m === null ? c.subject : (m[3] ?? "")).trim();
  const pr = TRAILING_PR.exec(description);
  return {
    type: m === null ? "other" : (m[1] ?? "other").toLowerCase(),
    breaking: m?.[2] === "!" || c.breakingFooter,
    description: description.replace(TRAILING_PR, "").trim(),
    pr: pr === null ? null : Number(pr[1]),
  };
};

/** A breaking commit bumps major, else a `feat` bumps minor, else any other type bumps patch (FD-AGT-083). */
export const releaseBump = (commits: readonly ConventionalCommit[]): ReleaseBump =>
  commits.some((c) => c.breaking)
    ? "major"
    : commits.some((c) => c.type === "feat")
      ? "minor"
      : "patch";

/** The next version after the base tag; a repository with no release tag counts from `v0.0.0` (FD-AGT-083). */
export const nextReleaseVersion = (baseTag: string | null, bump: ReleaseBump): string => {
  const base = (baseTag === null ? null : parseReleaseTag(baseTag)) ?? {
    major: 0,
    minor: 0,
    patch: 0,
  };
  return formatVersion(
    bump === "major"
      ? { major: base.major + 1, minor: 0, patch: 0 }
      : bump === "minor"
        ? { major: base.major, minor: base.minor + 1, patch: 0 }
        : { ...base, patch: base.patch + 1 },
  );
};

// ---------------------------------------------------------------------------
// The commit range (FD-AGT-081, FD-AGT-082)

export const CommitRange = Schema.Struct({
  /** The newest release tag reachable from the head, or null when the range starts at the first commit. */
  baseTag: Schema.NullOr(Schema.String),
  /** The default branch's head, the range's end. */
  head: Schema.String,
  /** The range's commits without merges, newest first. */
  commits: Schema.Array(
    Schema.Struct({
      sha: Schema.String,
      subject: Schema.String,
      breakingFooter: Schema.Boolean,
    }),
  ),
});
export type CommitRange = typeof CommitRange.Type;

const FIELD = "\u001f";
const RECORD = "\u001e";

/** The `git log` format `parseCommitLog` reads: sha, subject and body, fields and records separated. */
export const COMMIT_LOG_FORMAT = "%H%x1f%s%x1f%b%x1e";

/** The commits of `git log --format=COMMIT_LOG_FORMAT` output. */
export const parseCommitLog = (stdout: string): RangeCommit[] =>
  stdout
    .split(RECORD)
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split(FIELD);
      return {
        sha: sha.trim(),
        subject,
        breakingFooter: BREAKING_FOOTER.test(body),
      };
    });

const SHA = /^[0-9a-f]{40}$/;

const git = (command: string, source: string) =>
  Effect.gen(function* () {
    const shell = yield* Shell;
    const result = yield* shell.run(command);
    if (result.exitCode !== 0)
      return yield* new ReadFailed({
        source,
        detail: (result.stderr || `exit ${result.exitCode}`).slice(0, 200),
      });
    return result.stdout;
  });

/**
 * The commit range as an Activity (FD-AGT-081): a shallow checkout fetches its full history and tags first, so no
 * range is cut short; then the head, the newest release tag merged into it, and the commits after that tag. A failed
 * git command fails the read, never an empty range (FD-AGT-042).
 */
export const commitRangeActivity = Activity.make({
  name: "commit-range",
  success: CommitRange,
  error: ReadFailed,
  execute: Effect.gen(function* () {
    const shallow = yield* git("git rev-parse --is-shallow-repository", "history");
    if (shallow.trim() === "true") yield* git("git fetch -q --unshallow --tags origin", "history");
    const head = (yield* git("git rev-parse HEAD", "head")).trim();
    if (!SHA.test(head))
      return yield* new ReadFailed({
        source: "head",
        detail: `not a commit: ${head.slice(0, 64)}`,
      });
    const tags = yield* git(`git tag --merged ${head} --list 'v*'`, "tags");
    const baseTag = newestReleaseTag(tags.split("\n"));
    const range = baseTag === null ? head : `${baseTag}..${head}`;
    const log = yield* git(`git log --no-merges --format=${COMMIT_LOG_FORMAT} ${range}`, "log");
    return { baseTag, head, commits: parseCommitLog(log) };
  }),
});

// ---------------------------------------------------------------------------
// Notes and the release pull request (FD-AGT-084)

/** The marker approval intake reads off the release pull request: the execution, the version and the range's head. */
export const releaseNotesMarker = (m: {
  readonly executionId: string;
  readonly version: string;
  readonly head: string;
}) =>
  `<!-- flare-dispatch:release-notes execution=${m.executionId} version=${m.version} head=${m.head} -->`;

/** Anchored to the body's end, so a marker-shaped comment earlier in the body is never read. */
const MARKER =
  /<!-- flare-dispatch:release-notes execution=(\S+) version=(v\d+\.\d+\.\d+) head=([0-9a-f]{40}) -->\s*$/;

/** The marker that ends a pull-request body, or null when the body does not end with one. */
export const parseReleaseNotesMarker = (body: string | null) => {
  const m = body === null ? null : MARKER.exec(body);
  return m === null ? null : { executionId: m[1] ?? "", version: m[2] ?? "", head: m[3] ?? "" };
};

const SECTIONS: readonly {
  readonly heading: string;
  readonly types: readonly string[];
}[] = [
  { heading: "Features", types: ["feat"] },
  { heading: "Fixes", types: ["fix"] },
  { heading: "Performance", types: ["perf"] },
  { heading: "Documentation", types: ["docs"] },
];

const entryLine = (c: ConventionalCommit, sha: string) =>
  `- ${flattenLine(c.description, DESCRIPTION_MAX_CHARS)} (${c.pr === null ? `\`${sha.slice(0, 7)}\`` : `#${c.pr}`})`;

/**
 * The notes of a version: the highlights, then breaking changes, features, fixes, performance, documentation and
 * other changes, one line per commit. Commit text is flattened to one markdown-inert line with no link or mention.
 */
export const renderReleaseNotes = (args: {
  readonly version: string;
  readonly range: CommitRange;
  readonly highlights: string;
}): string => {
  const parsed = args.range.commits.map((c) => ({
    conv: parseConventionalCommit(c),
    sha: c.sha,
  }));
  const count = parsed.length;
  const out = [
    `# ${args.version}`,
    "",
    `${count} change${count === 1 ? "" : "s"} since ${
      args.range.baseTag === null ? "the first commit" : `\`${args.range.baseTag}\``
    }, up to \`${args.range.head.slice(0, 12)}\`.`,
    "",
  ];
  if (args.highlights.trim() !== "") out.push("## Highlights", "", args.highlights.trim(), "");
  const section = (heading: string, rows: typeof parsed) => {
    if (rows.length === 0) return;
    out.push(`## ${heading}`, "", ...rows.map((p) => entryLine(p.conv, p.sha)), "");
  };
  section(
    "Breaking changes",
    parsed.filter((p) => p.conv.breaking),
  );
  const listed = new Set(SECTIONS.flatMap((s) => s.types));
  for (const s of SECTIONS)
    section(
      s.heading,
      parsed.filter((p) => !p.conv.breaking && s.types.includes(p.conv.type)),
    );
  section(
    "Other changes",
    parsed.filter((p) => !p.conv.breaking && !listed.has(p.conv.type)),
  );
  return `${out.join("\n").trimEnd()}\n`;
};

/** The release pull request's body: how to approve, the notes, and the marker on the last line. */
export const releasePullRequestBody = (args: {
  readonly version: string;
  readonly notes: string;
  readonly marker: string;
}) =>
  [
    `Release \`${args.version}\`. Merging this pull request or applying the label \`release:approve\` within the approval window publishes the release; closing it unmerged or applying \`release:reject\` cancels it.`,
    "",
    args.notes.length <= BODY_NOTES_MAX_CHARS
      ? args.notes.trimEnd()
      : `The notes are in \`${releaseNotesPath(args.version)}\`.`,
    "",
    args.marker,
  ].join("\n");

const SYSTEM = [
  "You write the highlights of a software release for its users.",
  "Answer with at most five markdown bullet points in plain language, no headings, links or mentions.",
  "Name only changes the commit list holds.",
].join("\n");

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi;
const HTML_COMMENT = /<!--[\s\S]*?(-->|$)/g;

/** The highlights from one `judgment` call over the range's commit subjects, made safe for the notes. */
const highlightsOf = (version: string, range: CommitRange) =>
  Effect.gen(function* () {
    const model = yield* ModelClient;
    const subjects = range.commits.slice(0, PROMPT_MAX_COMMITS).map((c) => `- ${c.subject}`);
    const text = yield* model.complete({
      callSite: "notes",
      tier: "judgment",
      maxTokens: 1024,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Release ${version}, ${range.commits.length} commits since ${range.baseTag ?? "the first commit"}:\n${subjects.join("\n")}`,
        },
      ],
    });
    // HTML comments go too, fenced ones included, so the highlights cannot carry a marker-shaped comment.
    return sanitizeModelText(text).replace(URL_IN_TEXT, "[link]").replace(HTML_COMMENT, "");
  });

// ---------------------------------------------------------------------------
// Publishing an approved release (FD-AGT-088)

/**
 * The version's notes file at the release pull request's approved head, as an Activity: a checkout that lacks that
 * commit fetches it first. A failed read fails the publish rather than draft a release without its notes.
 */
export const approvedNotesActivity = (publish: ReleasePublishInput) =>
  Activity.make({
    name: "approved-notes",
    success: Schema.String,
    error: ReadFailed,
    execute: Effect.gen(function* () {
      const shell = yield* Shell;
      const present = yield* shell.run(`git cat-file -e '${publish.notesCommit}^{commit}'`);
      if (present.exitCode !== 0) yield* git(`git fetch -q origin ${publish.notesCommit}`, "notes");
      return yield* git(
        `git show ${publish.notesCommit}:${releaseNotesPath(publish.version)}`,
        "notes",
      );
    }),
  });

/** The notes as a release body, cut at the last whole line under GitHub's limit when they are longer. */
export const releaseBody = (version: string, notes: string) => {
  if (notes.length <= RELEASE_BODY_MAX_CHARS) return notes;
  const pointer = `\n\nThe full notes are in \`${releaseNotesPath(version)}\`.\n`;
  const cut = notes.slice(0, RELEASE_BODY_MAX_CHARS - pointer.length);
  return `${cut.slice(0, Math.max(0, cut.lastIndexOf("\n"))).trimEnd()}${pointer}`;
};

/**
 * The publish execution (FD-AGT-088): one `release.draft` intent for the marker's version at the approved commit,
 * carrying the notes the release pull request held when it was approved, then one `release.publish` intent for that
 * tag. The appliers create a draft only where no release exists and publish only a draft, so the drain leaves a
 * release that is already published unchanged (FD-GH-085, FD-GH-086). A last `pr.close` intent names the release pull
 * request by number: a label approval leaves it open, and closing it lets the next proposal open its own pull request,
 * with its own creation time, window and dedup key, instead of reusing this one (FD-AGT-084); a merged one is already
 * closed, and another pull request on the branch stays open.
 */
export const runReleasePublish = (
  input: Pick<ReleaseNotesInput, "repo" | "baseBranch">,
  publish: ReleasePublishInput,
) =>
  Effect.gen(function* () {
    const notes = yield* approvedNotesActivity(publish);
    const intents = yield* RecipeIntents;
    yield* intents.append("release-draft", "release.draft", {
      tag: publish.version,
      target: publish.commit,
      name: publish.version,
      body: releaseBody(publish.version, notes),
    });
    yield* intents.append("release-publish", "release.publish", { tag: publish.version });
    yield* intents.append("release-close", "pr.close", {
      repo: input.repo,
      branch: RELEASE_NOTES_BRANCH,
      base: input.baseBranch,
      pull: publish.pullRequest,
    });
    return { _tag: "success" } satisfies RunResult;
  });

/**
 * The proposing `release-notes` body, or the publish execution's when the input names an approved release. A suppressed key reads nothing and opens nothing (FD-AGT-043). The commit range
 * is read inside an Activity (FD-AGT-081); an empty range concludes `skipped` with `not-applicable: empty-range` before
 * any model call (FD-AGT-082). The next version follows the range's Conventional Commits (FD-AGT-083), and the notes
 * leave as one staged write on `flare-dispatch/release`, a pull request with `draft` false whose body ends with the
 * marker naming the execution, the version and the range's head; the run then concludes `success` (FD-AGT-084).
 */
export const runReleaseNotes = (input: ReleaseNotesInput) =>
  Effect.gen(function* () {
    if (input.publish !== undefined) return yield* runReleasePublish(input, input.publish);
    const suppressed = yield* checkSuppression(suppressionKey(input.repo, RELEASE_NOTES_BRANCH));
    if (suppressed) return { _tag: "success" } satisfies RunResult;
    const range = yield* commitRangeActivity;
    if (range.commits.length === 0)
      return {
        _tag: "skipped",
        detail: EMPTY_RANGE_DETAIL,
      } satisfies RunResult;
    const version = nextReleaseVersion(
      range.baseTag,
      releaseBump(range.commits.map(parseConventionalCommit)),
    );
    const highlights = yield* highlightsOf(version, range);
    const notes = renderReleaseNotes({ version, range, highlights });
    const checkout = yield* Checkout;
    yield* checkout.write(releaseNotesPath(version), notes);
    const { executionId } = yield* ExecutionIdentity;
    const stage = yield* StagedWrites;
    yield* stage.stage({
      branch: RELEASE_NOTES_BRANCH,
      baseBranch: input.baseBranch,
      message: `docs(release): notes for ${version}`,
      pr: {
        title: `release: ${version}`,
        body: releasePullRequestBody({
          version,
          notes,
          marker: releaseNotesMarker({
            executionId,
            version,
            head: range.head,
          }),
        }),
        draft: false,
        labels: ["release"],
      },
    });
    return { _tag: "success" } satisfies RunResult;
  }).pipe(
    Effect.catchTags({
      SuppressionReadFailed: suppressionReadFailed,
      ReadFailed: (e) =>
        Effect.succeed({
          _tag: "failure",
          reason: `infra: read ${e.source}: ${e.detail}`,
        } satisfies RunResult),
      ModelCallError: (e) => Effect.succeed(modelFailureVerdict(e) satisfies RunResult),
      StageFailed: (e) =>
        Effect.succeed({
          _tag: "failure",
          reason: `infra: stage: ${e.detail}`,
        } satisfies RunResult),
    }),
  );
