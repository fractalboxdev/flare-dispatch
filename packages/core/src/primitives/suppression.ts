// Primitive: suppression — has this proposal already been answered "no"?
//
// The maintenance loop's memory. Every proposal a run opens carries stable
// `maintenance-key: <source-slug>/<stable-id>` lines in its PR body; this
// primitive reads those keys back and answers, per key: propose it, or don't.
//
// Two rules, and they come from the loop's process doc, not from here:
//
//   * a key in `infra/maintenance-loop/declined.jsonl` means **never again**;
//   * a PR carrying the key that a human **closed unmerged**, with no ledger
//     entry, means a **30-day cooldown dated from `closed_at`**.
//
// Without this, a proposal a human closed is re-proposed on the next tick,
// forever — which the process doc names as the loop's likeliest failure: not a
// bad merge, but the team learning to ignore the loop. Three runs need it, so it
// lives here rather than inside the first one that did.
//
// --- Why `closed_at`, and why not the org context store ----------------------
//
// The store's `pulls` table has no `closed_at`, and `updated_at` resets on any
// touch — a cooldown dated from it never expires. So the GitHub API is the only
// source, via `github.pullRequestHistory` (closed PRs included). And the ledger
// is a file in a private git repo, read via `github.readTextFile` — cloning the
// repo to read one line on every tick would cost a container per string.
//
// --- Fail open, loudly -------------------------------------------------------
//
// If a source cannot be read, its half of the rule is skipped, the reason is
// logged at `warn`, and the report names it so the run can say so in its output.
// Suppression failing *closed* would silence the loop entirely — a strictly
// worse outcome than one duplicate PR. Each source degrades independently: a
// ledger that fails to read does not throw away the cooldowns.
//
// --- The ledger is untrusted input ------------------------------------------
//
// `declined.jsonl` is a file humans hand-edit in PRs. A malformed line is
// skipped with a warning and never crashes a run; a line's `key` is only ever
// used as an exact-match string, never as a pattern; and its `reason` is
// flattened before it reaches a PR body, so ledger prose cannot inject markdown
// structure into a proposal.
//
// Pure decision (`decideSuppression`) is separated from the two reads
// (`checkSuppression`) — the rules are unit-testable with plain data and no
// mocks, the way `oxlint` / `scheduling` split.
//
// Rides on the `github` and `io` capabilities. Layer: 03-dsl § Primitives.

import { Effect } from "effect";
import type { GitHubApiError } from "../errors";
import { github, type PullRequestHistoryRef } from "../services/github";
import { io } from "../services/io";

/** Where a decline is recorded, in the control repo. */
export const DECLINED_LEDGER_PATH = "infra/maintenance-loop/declined.jsonl";

/** A closed-unmerged proposal with no ledger entry waits this long. */
export const COOLDOWN_DAYS_DEFAULT = 30;

const DAY_MS = 86_400_000;

/** The longest a key may be before the ledger line is treated as junk. */
const KEY_MAX_CHARS = 200;
/** Reasons are rendered into markdown; longer than this is truncated. */
const REASON_MAX_CHARS = 200;

// --- The ledger --------------------------------------------------------------

/** One permanently declined proposal, as `declined.jsonl` records it. */
export type DeclineEntry = {
  /** The proposal's `maintenance-key`, exactly as its PR body carried it. */
  readonly key: string;
  /** Why, in a sentence. A ledger of bare keys teaches nobody. */
  readonly reason: string;
  /** Who decided. */
  readonly by: string;
  /** When, as the ledger wrote it (`YYYY-MM-DD`). */
  readonly at: string;
};

/** The outcome of reading `declined.jsonl` — including what it could not read. */
export type LedgerParse = {
  readonly byKey: ReadonlyMap<string, DeclineEntry>;
  /** One entry per skipped line: its 1-based number and why it was skipped. */
  readonly malformed: readonly { readonly line: number; readonly why: string }[];
};

/** Flatten untrusted prose to one safe single-line fragment for markdown. */
const flatten = (raw: unknown, max: number): string =>
  typeof raw === "string"
    ? raw
        .replace(/[\r\n]+/g, " ")
        // Backticks and pipes would break out of inline code / table cells.
        .replace(/[`|]/g, "")
        .trim()
        .slice(0, max)
    : "";

/**
 * Parse `declined.jsonl` — one JSON object per line.
 *
 * Never throws. A line that is not an object, or whose `key` is missing / not a
 * string / empty / implausibly long, is skipped and reported in `malformed` for
 * the caller to log. A later line for a key wins over an earlier one (the
 * ledger is append-only, so the last word is the current one).
 */
export const parseDeclinedLedger = (text: string): LedgerParse => {
  const byKey = new Map<string, DeclineEntry>();
  const malformed: { line: number; why: string }[] = [];

  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed.push({ line: index + 1, why: "not JSON" });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      malformed.push({ line: index + 1, why: "not a JSON object" });
      return;
    }

    const record = parsed as Record<string, unknown>;
    const key = typeof record["key"] === "string" ? record["key"].trim() : "";
    if (key.length === 0 || key.length > KEY_MAX_CHARS) {
      malformed.push({ line: index + 1, why: "no usable `key`" });
      return;
    }
    byKey.set(key, {
      key,
      reason: flatten(record["reason"], REASON_MAX_CHARS),
      by: flatten(record["by"], 80),
      at: flatten(record["at"], 40),
    });
  });

  return { byKey, malformed };
};

// --- Reading keys back off a proposal ---------------------------------------

/**
 * The `maintenance-key:` lines in a PR body. Anchored to the start of a line so
 * prose quoting the phrase mid-sentence cannot register a key, and deduplicated
 * so a body repeating one is still one key.
 */
export const parseMaintenanceKeys = (body: string): readonly string[] => {
  const keys = new Set<string>();
  for (const match of body.matchAll(/^[ \t]*maintenance-key:[ \t]*(\S+)[ \t]*$/gm)) {
    const key = match[1];
    if (key !== undefined && key.length <= KEY_MAX_CHARS) keys.add(key);
  }
  return [...keys];
};

// --- The rule ----------------------------------------------------------------

/** Why a key is (or is not) suppressed. */
export type SuppressionVerdict =
  | { readonly status: "open" }
  | {
      readonly status: "declined";
      readonly reason: string;
      readonly by: string;
      readonly at: string;
    }
  | {
      readonly status: "cooling";
      /** epoch ms the cooldown expires. */
      readonly untilMs: number;
      /** `YYYY-MM-DD` the cooldown expires — the human-facing half. */
      readonly until: string;
      /** The PR whose close started it, and when. */
      readonly pr: number;
      readonly url: string;
      readonly closedAtMs: number;
    };

/** A key and the non-`open` verdict that keeps it out of a proposal. */
export type SuppressedKey = {
  readonly key: string;
  readonly verdict: Exclude<SuppressionVerdict, { status: "open" }>;
};

/** One-word (or one-token) rendering of a verdict, for logs and bodies. */
export const describeVerdict = (verdict: SuppressionVerdict): string =>
  verdict.status === "open"
    ? "open"
    : verdict.status === "declined"
      ? "declined"
      : `cooling-until-${verdict.until}`;

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Decide each candidate key — pure, so the rules are testable with plain data.
 *
 * Precedence: the ledger wins over everything (it is a permanent human
 * decision). Otherwise the most recent **closed-unmerged** PR carrying the key
 * starts a cooldown from its `closed_at`; a merged PR suppresses nothing (the
 * proposal was accepted), and a still-open PR suppresses nothing either — that
 * is the loop's WIP limit's job, not suppression's.
 *
 * A closed PR with no `closedAt` (which GitHub does not produce, but a degraded
 * read might) cannot date a cooldown, so it is ignored rather than guessed at.
 */
export const decideSuppression = (args: {
  readonly candidates: readonly string[];
  /** Keys the ledger permanently declined. */
  readonly declined: ReadonlyMap<string, DeclineEntry>;
  /** PRs that may carry the keys — `github.pullRequestHistory` output. */
  readonly priorProposals: readonly PullRequestHistoryRef[];
  readonly nowMs: number;
  readonly cooldownDays?: number;
}): ReadonlyMap<string, SuppressionVerdict> => {
  const cooldownMs = (args.cooldownDays ?? COOLDOWN_DAYS_DEFAULT) * DAY_MS;

  // key → the most recent close that could start a cooldown.
  const lastClose = new Map<string, PullRequestHistoryRef>();
  for (const pr of args.priorProposals) {
    if (pr.state !== "closed" || pr.mergedAt !== undefined || pr.closedAt === undefined) continue;
    for (const key of parseMaintenanceKeys(pr.body)) {
      const seen = lastClose.get(key);
      if (seen === undefined || (seen.closedAt ?? 0) < pr.closedAt) lastClose.set(key, pr);
    }
  }

  const verdicts = new Map<string, SuppressionVerdict>();
  for (const key of args.candidates) {
    const decline = args.declined.get(key);
    if (decline !== undefined) {
      verdicts.set(key, {
        status: "declined",
        reason: decline.reason,
        by: decline.by,
        at: decline.at,
      });
      continue;
    }

    const closed = lastClose.get(key);
    const closedAtMs = closed?.closedAt;
    if (closed !== undefined && closedAtMs !== undefined) {
      const untilMs = closedAtMs + cooldownMs;
      if (args.nowMs < untilMs) {
        verdicts.set(key, {
          status: "cooling",
          untilMs,
          until: isoDay(untilMs),
          pr: closed.number,
          url: closed.url,
          closedAtMs,
        });
        continue;
      }
    }

    verdicts.set(key, { status: "open" });
  }
  return verdicts;
};

// --- The report --------------------------------------------------------------

/**
 * What the caller acts on: what to propose, what it dropped, and what broke.
 *
 * Plain arrays, no `Map` — a run wraps this read in `step(...)`, and CF
 * Workflows persists a step's return value for replay. `decideSuppression`
 * keeps the map; the thing that crosses the durability boundary is data.
 */
export type SuppressionReport = {
  /** Keys that survived — propose these. */
  readonly allowed: readonly string[];
  /** Keys that did not, each with its reason. */
  readonly suppressed: readonly SuppressedKey[];
  /**
   * Non-empty when a source could not be read and its half of the rule was
   * skipped. The run MUST surface these — a silently un-suppressed proposal is
   * a duplicate, and a silently un-read ledger is how the loop forgets.
   */
  readonly degraded: readonly string[];
};

/** Split a verdict map into the allow/suppress halves the caller acts on. */
const partition = (
  candidates: readonly string[],
  verdicts: ReadonlyMap<string, SuppressionVerdict>,
): { allowed: string[]; suppressed: SuppressedKey[] } => {
  const allowed: string[] = [];
  const suppressed: SuppressedKey[] = [];
  for (const key of candidates) {
    const verdict = verdicts.get(key) ?? { status: "open" as const };
    if (verdict.status === "open") allowed.push(key);
    else suppressed.push({ key, verdict });
  }
  return { allowed, suppressed };
};

/** Everything proposes — the answer when there is nothing to suppress against. */
const allOpen = (
  candidates: readonly string[],
  degraded: readonly string[],
): SuppressionReport => ({
  allowed: [...candidates],
  suppressed: [],
  degraded,
});

export type CheckSuppressionArgs = {
  /** The candidate `maintenance-key`s this tick would propose. */
  readonly keys: readonly string[];
  /** The repo holding the ledger (and, normally, the proposals). */
  readonly ledgerRepo: string;
  /** Ledger path — defaults to {@link DECLINED_LEDGER_PATH}. */
  readonly ledgerPath?: string;
  /** Ledger ref (branch/sha) — defaults to the repo's default branch. */
  readonly ledgerRef?: string;
  /** The repo prior proposals were opened against — defaults to `ledgerRepo`. */
  readonly proposalRepo?: string;
  /** The head-branch prefix every proposal of this kind shares. */
  readonly headBranchPrefix: string;
  /** Now, in epoch ms — passed in so a run's clock is the one that decides. */
  readonly nowMs: number;
  /** Cooldown length — defaults to {@link COOLDOWN_DAYS_DEFAULT}. */
  readonly cooldownDays?: number;
};

/**
 * Read both sources and decide. **Never fails**: any read that errors is logged
 * at `warn`, named in `report.degraded`, and its half of the rule is skipped.
 *
 * No candidates ⇒ no reads at all: a tick with nothing to propose should not
 * spend two GitHub calls asking whether to propose it.
 */
export const checkSuppression = (args: CheckSuppressionArgs) =>
  Effect.gen(function* () {
    if (args.keys.length === 0) return allOpen(args.keys, []);

    const ledgerPath = args.ledgerPath ?? DECLINED_LEDGER_PATH;
    const proposalRepo = args.proposalRepo ?? args.ledgerRepo;
    const cooldownDays = args.cooldownDays ?? COOLDOWN_DAYS_DEFAULT;
    const degraded: string[] = [];

    // 1. The permanent declines. Absent is not an error — a ledger nobody has
    //    written yet declines nothing, which is exactly `{ found: false }`.
    const ledgerText = yield* github
      .readTextFile({
        repo: args.ledgerRepo,
        path: ledgerPath,
        ...(args.ledgerRef !== undefined ? { ref: args.ledgerRef } : {}),
      })
      .pipe(
        Effect.map((result) => (result.found ? result.content : "")),
        Effect.catchAll((err: GitHubApiError) =>
          Effect.gen(function* () {
            const why = `ledger ${args.ledgerRepo}:${ledgerPath} unreadable (GitHub ${err.status} ${err.reason}) — declines NOT applied this tick`;
            degraded.push(why);
            yield* io.log("warn", `suppression: ${why}`);
            return "";
          }),
        ),
      );

    const ledger = parseDeclinedLedger(ledgerText);
    for (const bad of ledger.malformed) {
      yield* io.log(
        "warn",
        `suppression: ${ledgerPath}:${bad.line} skipped — ${bad.why}. The rest of the ledger still applies.`,
      );
    }

    // 2. The cooldowns. Paginate no further back than the cooldown window —
    //    `updatedAt >= closedAt`, so nothing closed inside it can be missed.
    const priorProposals = yield* github
      .pullRequestHistory({
        repo: proposalRepo,
        headBranchPrefix: args.headBranchPrefix,
        state: "all",
        updatedWithinDays: cooldownDays,
      })
      .pipe(
        Effect.catchAll((err: GitHubApiError) =>
          Effect.gen(function* () {
            const why = `PR history for ${proposalRepo} (${args.headBranchPrefix}*) unreadable (GitHub ${err.status} ${err.reason}) — cooldowns NOT applied this tick`;
            degraded.push(why);
            yield* io.log("warn", `suppression: ${why}`);
            return [] as readonly PullRequestHistoryRef[];
          }),
        ),
      );

    const verdicts = decideSuppression({
      candidates: args.keys,
      declined: ledger.byKey,
      priorProposals,
      nowMs: args.nowMs,
      cooldownDays,
    });
    const { allowed, suppressed } = partition(args.keys, verdicts);

    if (suppressed.length > 0) {
      yield* io.log(
        "info",
        `suppression: ${suppressed.length} of ${args.keys.length} key(s) suppressed — ${suppressed
          .map((s) => `${s.key} (${describeVerdict(s.verdict)})`)
          .join(", ")}`,
      );
    }

    return { allowed, suppressed, degraded };
  });

/**
 * The suppression note a proposal carries — markdown lines, empty when there is
 * nothing to say.
 *
 * A shorter list of findings with no explanation reads as "fewer problems",
 * which is the opposite of true. Every run that suppresses must print this in
 * both its PR body and its digest.
 */
export const renderSuppressionNote = (report: SuppressionReport): readonly string[] => {
  if (report.suppressed.length === 0 && report.degraded.length === 0) return [];

  const lines: string[] = [];
  if (report.suppressed.length > 0) {
    const declined = report.suppressed.filter((s) => s.verdict.status === "declined").length;
    const cooling = report.suppressed.length - declined;
    lines.push(
      `**Suppressed: ${report.suppressed.length}** — ${declined} previously declined, ${cooling} in cooldown. Not fewer problems; fewer *proposals*.`,
      "",
    );
    for (const { key, verdict } of report.suppressed) {
      lines.push(
        verdict.status === "declined"
          ? `- \`${key}\` — declined${verdict.at !== "" ? ` ${verdict.at}` : ""}${
              verdict.by !== "" ? ` by ${verdict.by}` : ""
            }${verdict.reason !== "" ? `: ${verdict.reason}` : ""}`
          : `- \`${key}\` — closed unmerged in [#${verdict.pr}](${verdict.url}) on ${isoDay(
              verdict.closedAtMs,
            )}; cooling until ${verdict.until}`,
      );
    }
    lines.push("");
  }

  for (const why of report.degraded) {
    lines.push(
      `> ⚠️ Suppression degraded — ${why}. Proposed anyway; a duplicate is the safe failure.`,
      "",
    );
  }
  return lines;
};
