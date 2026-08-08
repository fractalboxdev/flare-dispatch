// Primitive: the auto-merge gate — the one place software reaches `main`
// without a human, and therefore the one place built to say no.
//
// The loop's process doc (§5, §9) is the spec. Config lives as a JSON file in
// the operator's control repo — the caller names the path — and is changed by
// PR. This primitive answers one question — *may this PR merge itself?* — and
// its answer is `no` unless every condition holds.
//
// --- Refusal is the default, structurally --------------------------------
//
// Not "defaults to false in the config" — *structurally*. `evaluate` starts
// from a refusal and can only ever return the permit it built by exhausting
// every condition; there is no early `return { permitted: true }`. An
// unreadable config, an unparseable config, a config missing a field, an
// unrecognised class, a repo nobody opted in: all land on the same refusal
// path. The only input that permits is one that satisfies the whole
// conjunction, and `enabled: false` short-circuits before any of it is read.
//
// --- What it trusts, and what it refuses to ------------------------------
//
// Exactly one field carries identity: `candidate.author`, as GitHub reports it.
// Everything derived from PR *text* — the `<!-- flare-dispatch: <run> -->`
// marker, the declared change class — is written by whoever opened the PR, so
// it is allowed to make the verdict stricter and never looser. `producedByRun`
// can refuse a candidate by naming a never-eligible run; it can never satisfy a
// condition, skip one, or stand in for authorship. Read the marker as a claim,
// not a credential.
//
// --- What this deliberately does NOT do -----------------------------------
//
// **It does not merge.** It returns a verdict; acting on a permit is the
// caller's, and today no caller can — there is no merge capability on
// `GithubService`, by design until the ladder below exists.
//
// **It does not implement the promotion ladder.** §5 has classes earning
// autonomy over 10 then 20 consecutive clean merges. That ladder is the thing
// that turns eligibility into permission, and it needs a merge record nothing
// yet keeps. So this primitive answers *eligibility* only, and a permitted
// verdict still carries `rung: 0` — lights-on, human merges. Guessing a class
// has earned rung 1 is exactly what the ladder exists to replace, so the
// absence is recorded rather than approximated (`LADDER_NOT_IMPLEMENTED`).
//
// Rides on the `github` and `io` capabilities. Layer: 03-dsl § Primitives.

import { Effect } from "effect";
import type { GitHubApiError } from "../errors";
import { github } from "../services/github";
import { io } from "../services/io";

/**
 * Where the allowlist lives, in the control repo — the fallback only.
 *
 * Callers name their own path, and any real deployment does. This default
 * describes no particular operator's directory layout: the package is public,
 * and a control repo's file tree is the operator's business, not this
 * primitive's.
 */
export const AUTOMERGE_CONFIG_PATH = "maintenance/automerge.json";

/**
 * The rung a permitted class sits on. Always 0 until the promotion ladder is
 * built — see the module header. Exported so the caller can say so out loud.
 */
export const LADDER_NOT_IMPLEMENTED = 0 as const;

/**
 * The allowlist, as parsed. Every field defaults to its most restrictive value,
 * so a config missing a key is never more permissive than one that sets it.
 */
export type AutomergeConfig = {
  readonly enabled: boolean;
  /** Repos opted in. Empty ⇒ nothing is eligible anywhere. */
  readonly repos: readonly string[];
  /** Change classes opted in. Empty ⇒ nothing is eligible. */
  readonly classes: readonly string[];
  /**
   * The logins the allowlist accepts as non-human authors — the loop's own app
   * login and any dependency bot the operator vouches for.
   *
   * **This is the only source of authorship.** Not the PR body, not a marker,
   * not anything else a PR author can type. Absent reads as empty, and empty
   * means nothing is ever eligible anywhere — including the loop's own PRs.
   * That is the correct default: §5 says "never a human, never an external
   * contributor", and an author nobody has vouched for is indistinguishable
   * from both. An operator turning the lane on must add the loop's bot login
   * here by PR, which is the reviewable act that grants the loop this power.
   */
  readonly botAuthors: readonly string[];
  /** Path globs that disqualify a whole PR if the diff touches one. */
  readonly sensitivePaths: readonly string[];
  /** Runs whose output is never auto-mergeable, on any repo, in any class. */
  readonly neverEligibleRuns: readonly string[];
  /** Per-repo per-day cap on auto-merges. */
  readonly dailyRateLimit: number;
};

/**
 * The config a caller gets when the real one cannot be read or believed.
 * Everything empty, `enabled: false` — refusing is what an unknown policy
 * means, and this value makes that the same code path as a known-off one.
 */
export const AUTOMERGE_CONFIG_CLOSED: AutomergeConfig = {
  enabled: false,
  repos: [],
  classes: [],
  botAuthors: [],
  sensitivePaths: [],
  neverEligibleRuns: [],
  dailyRateLimit: 0,
};

/** Read a string array off untrusted JSON, dropping anything that is not one. */
const stringArray = (raw: unknown): readonly string[] =>
  Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];

/**
 * Parse `automerge.json`. Never throws: anything unparseable, non-object, or
 * shaped wrong yields {@link AUTOMERGE_CONFIG_CLOSED}, because a policy file we
 * cannot read is not a policy that permits.
 *
 * `enabled` must be the literal boolean `true`. A string `"true"`, a `1`, or a
 * missing key all read as false — the one field where a coercion would be a
 * catastrophe is the one field that gets no coercion.
 */
export const parseAutomergeConfig = (
  text: string,
): { readonly config: AutomergeConfig; readonly malformed?: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { config: AUTOMERGE_CONFIG_CLOSED, malformed: "not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { config: AUTOMERGE_CONFIG_CLOSED, malformed: "not a JSON object" };
  }

  const record = parsed as Record<string, unknown>;
  const limit = record["dailyRateLimit"];
  return {
    config: {
      enabled: record["enabled"] === true,
      repos: stringArray(record["repos"]),
      classes: stringArray(record["classes"]),
      botAuthors: stringArray(record["botAuthors"]),
      sensitivePaths: stringArray(record["sensitivePaths"]),
      neverEligibleRuns: stringArray(record["neverEligibleRuns"]),
      dailyRateLimit: typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : 0,
    },
  };
};

/**
 * Read the allowlist from the control repo.
 *
 * **Unreadable means refuse**, and loudly — the inverse of `checkSuppression`,
 * which fails open. The asymmetry is the point: failing open on suppression
 * costs a duplicate PR, and failing open here would merge to `main` on a
 * network blip. An absent file is treated the same as an unreadable one; the
 * loop's config existing is not optional.
 */
export const loadAutomergeConfig = (opts: {
  readonly repo: string;
  readonly path?: string;
  readonly ref?: string;
}) =>
  Effect.gen(function* () {
    const path = opts.path ?? AUTOMERGE_CONFIG_PATH;
    const result = yield* github
      .readTextFile({
        repo: opts.repo,
        path,
        ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
      })
      .pipe(
        Effect.catchAll((err: GitHubApiError) =>
          Effect.gen(function* () {
            yield* io.log(
              "warn",
              `automerge: ${opts.repo}:${path} unreadable (GitHub ${err.status} ${err.reason}) — refusing every auto-merge this tick`,
            );
            return { found: false } as const;
          }),
        ),
      );

    if (!result.found) {
      yield* io.log(
        "warn",
        `automerge: no ${path} in ${opts.repo} — refusing every auto-merge this tick`,
      );
      return AUTOMERGE_CONFIG_CLOSED;
    }

    const { config, malformed } = parseAutomergeConfig(result.content);
    if (malformed !== undefined) {
      yield* io.log(
        "warn",
        `automerge: ${path} in ${opts.repo} is ${malformed} — refusing every auto-merge this tick`,
      );
    }
    return config;
  });

// --- The verdict -------------------------------------------------------------

/** Everything the gate needs to know about a PR. All of it is already read. */
export type MergeCandidate = {
  readonly repo: string;
  readonly number: number;
  /** The login that opened it. A human author is never eligible. */
  readonly author: string;
  /**
   * The loop run a PR *claims* produced it — parsed out of the PR body, which
   * anyone who can open a PR can write.
   *
   * **Untrusted, and it may only ever narrow.** It is matched against
   * `neverEligibleRuns` to refuse more, and it is evidence of nothing else —
   * in particular it is not evidence of who authored the PR. Forging it can
   * only move a candidate toward refusal; omitting it cannot skip a condition.
   * Authorship is read from {@link MergeCandidate.author}, which comes from
   * GitHub, not from the body.
   */
  readonly producedByRun?: string;
  /** The declared change class (`dependency-patch`, `formatting-only`, …). */
  readonly changeClass?: string;
  /** Repo-relative paths the diff touches. */
  readonly changedPaths: readonly string[];
  /** Every required check reporting green. */
  readonly checksGreen: boolean;
  /** `pr-review` has posted its verdict. */
  readonly reviewPosted: boolean;
  /** Auto-merges already performed on this repo today. */
  readonly mergesToday: number;
};

/** Why the gate refused, in the order the conditions are checked. */
export type RefusalReason =
  | "disabled"
  | "repo-not-opted-in"
  | "class-not-opted-in"
  | "never-eligible-run"
  | "human-author"
  | "sensitive-path"
  | "checks-not-green"
  | "review-not-posted"
  | "rate-limited";

export type MergeVerdict =
  | { readonly permitted: false; readonly reason: RefusalReason; readonly detail: string }
  | { readonly permitted: true; readonly rung: typeof LADDER_NOT_IMPLEMENTED };

/**
 * Does a path match one of the config's sensitive globs?
 *
 * Three shapes, matched literally rather than by a general glob engine — the
 * config uses exactly these and a looser matcher is a way to accidentally not
 * match: a trailing `/` is a directory prefix (`specs/`), a `*x*` is a
 * substring (`*secret*`), anything else is an exact filename match at any depth
 * (`CODEOWNERS`, `wrangler.jsonc`).
 */
export const matchesSensitivePath = (path: string, pattern: string): boolean => {
  if (pattern.endsWith("/")) return path === pattern.slice(0, -1) || path.startsWith(pattern);
  if (pattern.startsWith("*") && pattern.endsWith("*") && pattern.length > 2) {
    return path.toLowerCase().includes(pattern.slice(1, -1).toLowerCase());
  }
  return path === pattern || path.endsWith(`/${pattern}`);
};

/**
 * Evaluate one candidate against the allowlist — pure.
 *
 * Conditions are checked cheapest-and-most-decisive first, and the FIRST
 * failure is the reported reason, so a digest line names the one thing that
 * would have to change. There is no path to `permitted: true` that skips a
 * condition: the permit is constructed once, at the end, after all of them.
 */
export const evaluateAutomerge = (
  config: AutomergeConfig,
  candidate: MergeCandidate,
): MergeVerdict => {
  if (!config.enabled) {
    return { permitted: false, reason: "disabled", detail: "auto-merge is off in automerge.json" };
  }
  if (!config.repos.includes(candidate.repo)) {
    return {
      permitted: false,
      reason: "repo-not-opted-in",
      detail: `${candidate.repo} is not on the auto-merge opt-in list`,
    };
  }
  // A run named in `neverEligibleRuns` is refused before the class is even
  // considered: §5 makes these ineligible "in any class on any repo", so a
  // class opt-in must not be able to reach past it.
  if (
    candidate.producedByRun !== undefined &&
    config.neverEligibleRuns.includes(candidate.producedByRun)
  ) {
    return {
      permitted: false,
      reason: "never-eligible-run",
      detail: `${candidate.producedByRun} is never auto-mergeable — its diff is loop-authored prose`,
    };
  }
  if (candidate.changeClass === undefined || !config.classes.includes(candidate.changeClass)) {
    return {
      permitted: false,
      reason: "class-not-opted-in",
      detail: `change class ${candidate.changeClass ?? "(undeclared)"} is not on the allowlist`,
    };
  }
  // "The author is the loop itself or a configured dependency bot — never a
  // human, never an external contributor".
  //
  // This reads ONLY `candidate.author`, which GitHub reports, and it is checked
  // unconditionally. It used to be skipped whenever the PR body carried a
  // recognised `<!-- flare-dispatch: <run> -->` marker, on the theory that a
  // marker meant the loop wrote the PR. It does not: the body is authored by
  // whoever opened the PR, so that made "paste one HTML comment" a complete
  // bypass of the one condition standing between a human's PR and a merge
  // permit. A self-declared identity is not an identity. Anyone the config has
  // not vouched for is a human as far as the gate is concerned, including an
  // author it simply cannot place — and with `botAuthors` empty, that is
  // everyone.
  if (!config.botAuthors.includes(candidate.author)) {
    return {
      permitted: false,
      reason: "human-author",
      detail: `${candidate.author || "(unknown author)"} is not the loop or a configured bot`,
    };
  }
  const sensitive = candidate.changedPaths.find((path) =>
    config.sensitivePaths.some((pattern) => matchesSensitivePath(path, pattern)),
  );
  if (sensitive !== undefined) {
    return {
      permitted: false,
      reason: "sensitive-path",
      detail: `diff touches ${sensitive}`,
    };
  }
  if (!candidate.checksGreen) {
    return {
      permitted: false,
      reason: "checks-not-green",
      detail: "a required check is not green",
    };
  }
  if (!candidate.reviewPosted) {
    return { permitted: false, reason: "review-not-posted", detail: "pr-review has not posted" };
  }
  if (candidate.mergesToday >= config.dailyRateLimit) {
    return {
      permitted: false,
      reason: "rate-limited",
      detail: `${candidate.repo} is at its daily auto-merge limit (${config.dailyRateLimit})`,
    };
  }
  return { permitted: true, rung: LADDER_NOT_IMPLEMENTED };
};

/**
 * One-line rendering of a verdict for a digest.
 *
 * A permit still reads as "eligible, not merged", because the ladder that would
 * turn eligibility into a merge does not exist and nothing may imply it does.
 */
export const describeVerdict = (verdict: MergeVerdict): string =>
  verdict.permitted
    ? "eligible (rung 0 — lights-on; a human still merges)"
    : `refused: ${verdict.reason} — ${verdict.detail}`;
