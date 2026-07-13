// Run: weekly release notes with a human gate
//
// A Schedule-mode run that, every Monday, drafts release notes for the unreleased
// range (`<last-tag>..HEAD`), opens a release PR for review, and HIBERNATES on a
// human approval before publishing the GitHub Release. It is the canonical
// example of Schedule mode's two durable mechanisms working together:
//
//   1. a wall-clock trigger — the `schedules` block (`0 9 * * 1`); the Cron
//      Trigger is the heartbeat (must also be in wrangler.jsonc `triggers.crons`);
//   2. a durable pause — `step.waitForEvent` (specs/03-dsl.md § Human-in-the-loop):
//      after drafting, the Workflow sleeps for up to 72h at ZERO CPU cost,
//      surviving Worker eviction, until the gate is resolved.
//
// --- The approval surface: a release PR (GitHub-native) ---------------------
//
// The run opens a NON-draft PR carrying the rendered notes + a hidden marker
// pinning its own Workflow instance id. A human approves by MERGING the PR (or
// the `release:approve` label) and rejects by CLOSING it unmerged (or
// `release:reject`). The dispatcher's webhook (apps/dispatcher/src/release-
// approval.ts) reads the marker and signals this run — so GitHub's repo
// permissions are the authZ and the decider is a real GitHub identity, no shared
// ADMIN_TOKEN. /v1/admin/events/:wf_id stays as a manual override.
//
// --- What's real (no fictional CLI) -----------------------------------------
//
// The draft is built from plain `git` in the container (the same posture as
// `spec-drift-pr`: the ONE image is used only for `git`); the notes — a semver
// bump derived from Conventional Commits + a categorized changelog — are
// rendered IN THE WORKER by the pure helpers below (unit-tested, replay-safe).
// The PR open and the publish are both `github` capability writes (the App
// installation token) — no PAT, no container `gh`, no bespoke image.
//
// Mode: Schedule mode — specs/04-gha-integration.md § Schedule mode.

import { Effect, Match, Schema } from "effect";
import { defineRun, github, io, sandbox, step } from "@fractalboxdev/flare-dispatch-core";
import { workspace } from "@fractalboxdev/flare-dispatch-core/primitives";

// The repo this run cuts releases for. One scheduled run per release line.
const TARGET = { repo: "fractalbox/flare-dispatch", ref: "main" } as const;

// Where the approved notes land in the repo when the release PR merges — a
// durable changelog archive, and the PR's diff.
const releaseFile = (tag: string): string => `.flare-dispatch/releases/${tag}.md`;

// The hidden marker the dispatcher's webhook reads off the PR body to resume
// THIS run on merge/label. MUST match `RELEASE_APPROVAL_MARKER` in
// apps/dispatcher/src/release-approval.ts.
const approvalMarker = (wfId: string, tag: string): string =>
  `<!-- flare-dispatch:release-approval wf=${wfId} tag=${tag} -->`;

const renderPrBody = (notes: string, wfId: string, tag: string): string =>
  [
    `### 🚀 Release \`${tag}\` — approval gate`,
    "",
    "> 🤖 Drafted by `flare-dispatch/release-notes`. **Merge this PR to publish the GitHub Release**, or add the `release:reject` label / close it to cancel. (`release:approve` also publishes without merging.)",
    "",
    notes,
    "",
    approvalMarker(wfId, tag),
  ].join("\n");

// ISO year + week (e.g. "2026-W21") — the cron-window dedup key, so re-firing
// the same week is a no-op (04-gha-integration § Receiver dedup).
const isoYearWeek = (ms: number): string => {
  const d = new Date(ms);
  const thu = new Date(d);
  thu.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((thu.getTime() - week1.getTime()) / 86_400_000 -
        3 +
        ((week1.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${thu.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};

// The inbound approval signal. Primary path: the dispatcher's webhook resolves
// a merge/label on the release PR and POSTs it (release-approval.ts). Fallback:
// an operator POSTs to /v1/admin/events/:wf_id. Either way the payload is this.
const ApprovalPayload = Schema.Struct({
  decision: Schema.Literal("approve", "reject"),
  decider: Schema.String, // GitHub login (or email, via the admin path)
});

const Input = Schema.Struct({
  firedAt: Schema.Number, // epoch ms the cron fired at
});

const Output = Schema.Struct({
  published: Schema.Boolean,
  reason: Schema.Literal(
    "published",
    "rejected",
    "no-changes",
    "not-opened", // the App isn't configured, so no approval PR could be opened
    "not-configured", // approved, but createRelease degraded to a no-op
  ),
  tag: Schema.String,
  prNumber: Schema.Number, // the approval PR ("0" when none opened)
  prUrl: Schema.String,
  releaseUrl: Schema.String, // the published GitHub Release URL ("" unless published)
});

// ---------------------------------------------------------------------------
// Pure helpers — Conventional-Commit parsing, semver bump, notes rendering.
// Exported for unit tests; no I/O, fully deterministic given the git log.
// ---------------------------------------------------------------------------

/** One commit parsed out of the container's `git log` output. */
export type RawCommit = {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
};

/** What `collect-git` returns — the inputs every later step is derived from. */
export type GitState = {
  readonly headSha: string;
  readonly lastTag: string; // "" when the repo has no tags yet
  readonly commits: readonly RawCommit[];
};

/** Field separator git emits between log fields (ASCII Unit Separator). */
const US = "";

/**
 * Parse the labelled output of {@link GIT_SCRIPT}. Lines are either
 * `HEAD <sha>`, `LASTTAG <tag?>`, or `COMMIT␟<sha>␟<subject>␟<author>`.
 */
export const parseGitState = (stdout: string): GitState => {
  let headSha = "";
  let lastTag = "";
  const commits: RawCommit[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("HEAD ")) headSha = line.slice("HEAD ".length).trim();
    else if (line.startsWith("LASTTAG"))
      lastTag = line.slice("LASTTAG".length).trim();
    else if (line.startsWith(`COMMIT${US}`)) {
      const [, sha, subject, author] = line.split(US);
      if (sha !== undefined && subject !== undefined)
        commits.push({ sha, subject, author: author ?? "" });
    }
  }
  return { headSha, lastTag, commits };
};

/** A Conventional Commit, parsed from a commit subject. */
export type ConvCommit = {
  /** Normalized type — `feat` / `fix` / `perf` / `docs` / … / `other`. */
  readonly type: string;
  readonly breaking: boolean;
  /** The change description (subject minus the `type(scope)!:` prefix). */
  readonly description: string;
  /** PR number parsed from a trailing `(#123)`, when present. */
  readonly pr?: number;
  readonly author: string;
};

const CONVENTIONAL = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/;
const TRAILING_PR = /\(#(\d+)\)\s*$/;

/** Parse a raw commit into a Conventional Commit (best-effort). */
export const parseConventional = (c: RawCommit): ConvCommit => {
  const m = CONVENTIONAL.exec(c.subject);
  const breaking = m?.[3] === "!" || /BREAKING[ -]CHANGE/.test(c.subject);
  const type = m ? m[1]!.toLowerCase() : "other";
  const description = (m ? m[4]! : c.subject).trim();
  const prMatch = TRAILING_PR.exec(c.subject);
  return {
    type,
    breaking,
    description: description.replace(TRAILING_PR, "").trim(),
    ...(prMatch ? { pr: Number(prMatch[1]) } : {}),
    author: c.author,
  };
};

export type Bump = "major" | "minor" | "patch";

/** Pick the version bump implied by a set of commits. */
export const bumpFor = (commits: readonly ConvCommit[]): Bump =>
  commits.some((c) => c.breaking)
    ? "major"
    : commits.some((c) => c.type === "feat")
      ? "minor"
      : "patch";

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * Compute the next tag from the last tag + the bump the commits imply. No prior
 * tag (or an unparseable one) starts from `v0.0.0`, so the first release with a
 * `feat` becomes `v0.1.0`.
 */
export const nextVersion = (
  lastTag: string,
  commits: readonly ConvCommit[],
): string => {
  const m = SEMVER.exec(lastTag);
  const [major, minor, patch] = m
    ? [Number(m[1]), Number(m[2]), Number(m[3])]
    : [0, 0, 0];
  switch (bumpFor(commits)) {
    case "major":
      return `v${major + 1}.0.0`;
    case "minor":
      return `v${major}.${minor + 1}.0`;
    case "patch":
      return `v${major}.${minor}.${patch + 1}`;
  }
};

/** The changelog sections, in render order: [normalized type(s), heading]. */
const SECTIONS: ReadonlyArray<{ heading: string; types: readonly string[] }> = [
  { heading: "### 🚀 Features", types: ["feat"] },
  { heading: "### 🐛 Fixes", types: ["fix"] },
  { heading: "### ⚡ Performance", types: ["perf"] },
  { heading: "### 📝 Documentation", types: ["docs"] },
  {
    heading: "### 🧹 Other changes",
    types: ["refactor", "chore", "build", "ci", "style", "test", "other"],
  },
];

const prRef = (repo: string, c: ConvCommit, sha: string): string =>
  c.pr !== undefined
    ? `[#${c.pr}](https://github.com/${repo}/pull/${c.pr})`
    : `\`${sha.slice(0, 7)}\``;

const line = (repo: string, c: ConvCommit, sha: string): string => {
  const who = c.author ? ` — @${c.author}` : "";
  return `- ${c.description} (${prRef(repo, c, sha)})${who}`;
};

/**
 * Render proper, categorized Markdown release notes — breaking changes first,
 * then Features / Fixes / Performance / Documentation / Other, then a compare
 * link and the contributor list. Pure and deterministic.
 */
export const renderReleaseNotes = (args: {
  readonly repo: string;
  readonly tag: string;
  readonly lastTag: string;
  readonly raw: readonly RawCommit[];
  readonly date: string;
}): string => {
  const { repo, tag, lastTag, raw, date } = args;
  const parsed = raw.map((c) => ({ conv: parseConventional(c), sha: c.sha }));

  const out: string[] = [`## ${tag} (${date})`, ""];

  const compare = lastTag
    ? `https://github.com/${repo}/compare/${lastTag}...${tag}`
    : `https://github.com/${repo}/commits/${tag}`;
  out.push(
    `${parsed.length} change${parsed.length === 1 ? "" : "s"} since ` +
      (lastTag ? `[\`${lastTag}\`](${compare})` : "the start of the project") +
      `. [Full diff](${compare}).`,
    "",
  );

  const breaking = parsed.filter((p) => p.conv.breaking);
  if (breaking.length > 0) {
    out.push("### ⚠️ Breaking changes");
    for (const p of breaking) out.push(line(repo, p.conv, p.sha));
    out.push("");
  }

  for (const section of SECTIONS) {
    const rows = parsed.filter(
      (p) => !p.conv.breaking && section.types.includes(p.conv.type),
    );
    if (rows.length === 0) continue;
    out.push(section.heading);
    for (const p of rows) out.push(line(repo, p.conv, p.sha));
    out.push("");
  }

  const contributors = [...new Set(raw.map((c) => c.author).filter(Boolean))];
  if (contributors.length > 0) {
    out.push(
      `**Contributors:** ${contributors.map((a) => `@${a}`).join(", ")}`,
      "",
    );
  }

  return out.join("\n").trimEnd() + "\n";
};

// The in-container collector: HEAD sha, the most recent reachable tag, and the
// commit log for the unreleased range. `git fetch --tags` is best-effort — the
// clone may already carry tags; a fresh repo (this one, today) simply has none.
const GIT_SCRIPT = `set -e
git fetch --tags --force origin >/dev/null 2>&1 || true
last=$(git describe --tags --abbrev=0 2>/dev/null || true)
head=$(git rev-parse HEAD)
if [ -n "$last" ]; then range="$last..HEAD"; else range="HEAD"; fi
echo "HEAD $head"
echo "LASTTAG $last"
git log "$range" --no-merges --pretty=format:'COMMIT%x1f%H%x1f%s%x1f%an'`;

export const releaseNotes = defineRun({
  name: "release-notes",
  version: "1.0.0",
  image: "registry.cloudflare.com/fractalbox/flare-dispatch-review:latest",

  // Schedule mode: 09:00 UTC every Monday. MUST also appear in wrangler.jsonc
  // `triggers.crons`.
  schedules: [
    {
      cron: "0 9 * * 1",
      idempotencyKey: ({ firedAt }) => `release-notes:${isoYearWeek(firedAt)}`,
      inputs: ({ firedAt }) => ({ firedAt }),
    },
  ],

  inputs: Input,
  outputs: Output,

  // Wall-clock ceiling covers the 72h approval wait — the Workflow hibernates
  // for almost all of it, consuming no CPU.
  limits: { maxDurationSec: 4 * 24 * 3600 },

  run: (input) =>
    Effect.gen(function* () {
      // 1. Check out the release repo (the image is used only for `git`).
      const { container, dir } = yield* workspace({
        repo: TARGET.repo,
        sha: TARGET.ref,
      });

      // 2. Collect the unreleased range from plain `git`.
      const git = yield* step("collect-git", () =>
        sandbox
          .exec({ cwd: dir, container, command: ["sh", "-lc", GIT_SCRIPT] })
          .pipe(Effect.map((r) => parseGitState(r.stdout))),
      );

      // 3. Nothing merged since the last tag — skip the release and the gate.
      if (git.commits.length === 0) {
        yield* step("notify", () =>
          io.log("info", "release-notes: no changes since last tag — skipping"),
        );
        return {
          published: false as const,
          reason: "no-changes" as const,
          tag: git.lastTag || "v0.0.0",
          prNumber: 0,
          prUrl: "",
          releaseUrl: "",
        };
      }

      // 4. Compute the next tag + render proper categorized notes (pure).
      const parsed = git.commits.map(parseConventional);
      const tag = nextVersion(git.lastTag, parsed);
      const date = new Date(input.firedAt).toISOString().slice(0, 10);
      const notes = renderReleaseNotes({
        repo: TARGET.repo,
        tag,
        lastTag: git.lastTag,
        raw: git.commits,
        date,
      });

      // 5. Open the release PR — the GitHub-native approval surface. It carries
      //    the notes (as a committed file + the body) and a hidden marker
      //    pinning THIS run's instance id, so the dispatcher's webhook can
      //    resume the exact paused run when a human merges or labels it. Opened
      //    NON-draft so "merge to publish" is one click.
      const wfId = yield* io.executionId;
      const pr = yield* step("open-release-pr", () =>
        github.openDraftPullRequest({
          repo: TARGET.repo,
          baseBranch: TARGET.ref,
          headBranch: `flare-dispatch/release-${tag}`,
          title: `release: ${tag}`,
          body: renderPrBody(notes, wfId, tag),
          commitMessage: `chore(release): notes for ${tag}`,
          files: [{ path: releaseFile(tag), content: notes }],
          draft: false,
        }),
      );

      // No PR opened (App not configured) — there's no surface to gate on, so
      // don't hibernate forever; report and stop.
      if (pr.number === 0) {
        yield* step("notify-not-opened", () =>
          io.log(
            "warn",
            `release-notes: could not open the approval PR for ${tag} (GitHub App not configured) — not gating`,
          ),
        );
        return {
          published: false as const,
          reason: "not-opened" as const,
          tag,
          prNumber: 0,
          prUrl: "",
          releaseUrl: "",
        };
      }

      yield* step("announce", () =>
        io.log(
          "info",
          `release ${tag} drafted — PR #${pr.number} awaiting approval (merge to publish)`,
          { prUrl: pr.url, changes: git.commits.length },
        ),
      );

      // 6. Hibernate until the PR is merged/labeled (webhook) or an operator
      //    signals via /v1/admin/events. The Workflow consumes no CPU and
      //    survives eviction for the full timeout window.
      const approval = yield* step.waitForEvent("release approval", {
        type: "release-approval",
        timeout: "72 hours",
        payloadSchema: ApprovalPayload,
      });

      // 7. Exhaustive match on the decision — a new variant becomes a compile
      //    error, never a silent fall-through.
      return yield* Match.value(approval.decision).pipe(
        Match.when("reject", () =>
          Effect.succeed({
            published: false as const,
            reason: "rejected" as const,
            tag,
            prNumber: pr.number,
            prUrl: pr.url,
            releaseUrl: "",
          }),
        ),
        Match.when("approve", () =>
          Effect.gen(function* () {
            // Publishing is the `github.createRelease` capability write — the
            // Dispatcher's App installation token, which also creates the tag at
            // the drafted HEAD sha. On an uncredentialed deploy it degrades to a
            // logged no-op (`published: false`) rather than failing the run.
            const release = yield* step("publish-release", () =>
              github.createRelease({
                repo: TARGET.repo,
                tag,
                target: git.headSha,
                name: tag,
                body: notes,
              }),
            );
            return {
              published: release.published,
              reason: release.published
                ? ("published" as const)
                : ("not-configured" as const),
              tag,
              prNumber: pr.number,
              prUrl: pr.url,
              releaseUrl: release.url,
            };
          }),
        ),
        Match.exhaustive,
      );
    }),
});
