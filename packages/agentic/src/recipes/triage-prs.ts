// `triage-prs`: each open pull request's state (check health, review state, days since last update, labels) read from
// GitHub, a deterministic route to one of `auto-merge`, `nudge`, `unstick` and `ask`, an optional `transform` digest line
// per pull request, and one staged digest under `.flare-dispatch/triage/` (specs/runs/agentic.md § `triage-prs`). The
// route is computed before the model call and never reads its answer; the run returns no intent of its own.
import type { RunResult } from "@fractalboxdev/mameko-run";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { promptMessages, sanitizeModelText } from "../boundary.ts";
import { checkSuppression, suppressionKey, suppressionReadFailed } from "../suppression/ledger.ts";
import { ReadFailed } from "./spec-drift-pr.ts";
import { Checkout, ModelClient, StagedWrites } from "./services.ts";

export const TriagePrsInput = Schema.Struct({
  repo: Schema.Struct({ owner: Schema.String, name: Schema.String }),
  baseBranch: Schema.String,
});
export type TriagePrsInput = typeof TriagePrsInput.Type;

/** The branch of the digest's staged write, which the catalogue's writeback block names (FD-AGT-080). */
export const TRIAGE_PRS_BRANCH = "flare-dispatch/triage";
/** The path allowlist of the digest's staged write (FD-AGT-080). */
export const TRIAGE_PRS_ALLOWLIST = [".flare-dispatch/triage/**"] as const;

/** The routes a pull request takes, in digest order (FD-AGT-078). */
export const TRIAGE_ROUTES = ["auto-merge", "nudge", "unstick", "ask"] as const;
export type TriageRoute = (typeof TRIAGE_ROUTES)[number];

export type CheckHealth = "passing" | "failing" | "pending" | "none";
export type ReviewState = "approved" | "changes-requested" | "none";

/** Labels that hold a pull request for a maintainer's decision, compared case-insensitively. */
export const HOLD_LABELS = ["do-not-merge", "wip", "blocked", "on-hold"] as const;
/** Days a pull request with pending checks waits before it routes to `unstick`. */
export const PENDING_STUCK_DAYS = 1;
/** Days a pull request without an approval waits before it routes to `nudge`. */
export const NUDGE_AFTER_DAYS = 3;
/** Open pull requests one execution routes, newest update first. */
export const MAX_OPEN_PRS = 100;
/** Characters of a digest line. */
export const DIGEST_LINE_MAX_CHARS = 160;
/** Characters of a pull-request title in the digest. */
export const TITLE_MAX_CHARS = 120;
/** Pages of 100 check runs or reviews read per pull request; a longer list fails the read rather than truncate it. */
export const MAX_DETAIL_PAGES = 10;

export interface CheckRun {
  readonly name: string;
  /** GitHub's `status`: `queued`, `in_progress` or `completed`. */
  readonly status: string;
  /** GitHub's `conclusion`, null until the check completes. */
  readonly conclusion: string | null;
}

export interface Review {
  readonly author: string;
  /** GitHub's review `state`: `APPROVED`, `CHANGES_REQUESTED`, `DISMISSED`, `COMMENTED` or `PENDING`. */
  readonly state: string;
}

export interface OpenPullRequest {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  /** GitHub's `author_association` of the pull request's author. */
  readonly authorAssociation: string;
  readonly draft: boolean;
  /** `updated_at` in epoch milliseconds. */
  readonly updatedAt: number;
  readonly labels: readonly string[];
  /** The check runs of the head commit. */
  readonly checkRuns: readonly CheckRun[];
  /** The reviews in the order GitHub submitted them. */
  readonly reviews: readonly Review[];
}

/** The repository's open pull requests with their head checks and reviews. A failed read fails the run. */
export class PullRequestsRead extends Context.Service<
  PullRequestsRead,
  {
    readonly openPullRequests: (
      repository: string,
    ) => Effect.Effect<readonly OpenPullRequest[], ReadFailed>;
  }
>()("@fractalboxdev/flare-dispatch-agentic/PullRequestsRead") {}

const PullsPage = Schema.Array(
  Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    draft: Schema.optionalKey(Schema.Boolean),
    updated_at: Schema.String,
    user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
    author_association: Schema.String,
    labels: Schema.Array(Schema.Struct({ name: Schema.String })),
    head: Schema.Struct({ sha: Schema.String }),
  }),
);
const CheckRunsPage = Schema.Struct({
  total_count: Schema.Number,
  check_runs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
    }),
  ),
});
const ReviewsPage = Schema.Array(
  Schema.Struct({
    user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
    state: Schema.String,
  }),
);
const decodePulls = Schema.decodeUnknownSync(PullsPage);
const decodeCheckRuns = Schema.decodeUnknownSync(CheckRunsPage);
const decodeReviews = Schema.decodeUnknownSync(ReviewsPage);

export interface GithubPullRequestsReadConfig {
  /** The REST API root, `https://api.github.com` or an Enterprise host's `https://HOST/api/v3`. */
  readonly apiBase: string;
  /** The job's `fetch`; the egress proxy attaches any credential, so the Layer sends none of its own. */
  readonly fetch: typeof globalThis.fetch;
}

/** The `rel="next"` URL of a GitHub `Link` header, or undefined on the last page. */
const nextLink = (link: string | null) =>
  link
    ?.split(",")
    .map((part) => /<([^>]+)>\s*;\s*rel="next"/.exec(part)?.[1])
    .find((url) => url !== undefined);

/**
 * `PullRequestsRead` over GitHub's REST API: the first `MAX_OPEN_PRS` open pull requests by latest update, each with
 * every check run of its head commit and every review, following `Link: rel="next"` for up to `MAX_DETAIL_PAGES`
 * pages of 100. A request that fails, an answer other than 200, a body outside the shape, a next page off the API
 * origin, a list longer than `MAX_DETAIL_PAGES` pages and check runs fewer than the answer's `total_count` each fail
 * the read, so no route is taken on a partial list (FD-AGT-042).
 */
export const githubPullRequestsReadLayer = (
  config: GithubPullRequestsReadConfig,
): Layer.Layer<PullRequestsRead> =>
  Layer.succeed(PullRequestsRead, {
    openPullRequests: (repository) =>
      Effect.tryPromise({
        try: async () => {
          const apiBase = config.apiBase.replace(/\/+$/, "");
          const origin = new URL(apiBase).origin;
          const getUrl = async (url: string) => {
            const response = await config.fetch(url, {
              headers: {
                accept: "application/vnd.github+json",
                "x-github-api-version": "2022-11-28",
              },
            });
            const { pathname } = new URL(url);
            if (response.status !== 200)
              throw new Error(`GET ${pathname} answered ${response.status}`);
            const next = nextLink(response.headers.get("link"));
            if (next !== undefined && new URL(next).origin !== origin)
              throw new Error(`GET ${pathname} names a next page off ${origin}`);
            return { body: (await response.json()) as unknown, next };
          };
          const url = (path: string, query: Record<string, string>) =>
            `${apiBase}${path}?${new URLSearchParams(query)}`;
          const get = async (path: string, query: Record<string, string>) =>
            (await getUrl(url(path, query))).body;
          const getAll = async <A>(path: string, decode: (body: unknown) => readonly A[]) => {
            const items: A[] = [];
            let next: string | undefined = url(path, { per_page: "100" });
            for (let page = 0; next !== undefined; page++) {
              if (page === MAX_DETAIL_PAGES)
                throw new Error(`GET ${path} lists more than ${MAX_DETAIL_PAGES} pages`);
              const answer = await getUrl(next);
              items.push(...decode(answer.body));
              next = answer.next;
            }
            return items;
          };
          const root = `/repos/${repository}`;
          const pulls = decodePulls(
            await get(`${root}/pulls`, {
              state: "open",
              sort: "updated",
              direction: "desc",
              per_page: String(MAX_OPEN_PRS),
            }),
          );
          const out: OpenPullRequest[] = [];
          for (const p of pulls) {
            const checksPath = `${root}/commits/${p.head.sha}/check-runs`;
            let totalCount = 0;
            const checkRuns = await getAll(checksPath, (body) => {
              const page = decodeCheckRuns(body);
              totalCount = page.total_count;
              return page.check_runs;
            });
            if (checkRuns.length < totalCount)
              throw new Error(`GET ${checksPath} listed ${checkRuns.length} of ${totalCount} runs`);
            const reviews = await getAll(`${root}/pulls/${p.number}/reviews`, decodeReviews);
            out.push({
              number: p.number,
              title: p.title,
              author: p.user?.login ?? "ghost",
              authorAssociation: p.author_association,
              draft: p.draft ?? false,
              updatedAt: Date.parse(p.updated_at),
              labels: p.labels.map((l) => l.name),
              checkRuns,
              reviews: reviews.map((r) => ({ author: r.user?.login ?? "ghost", state: r.state })),
            });
          }
          return out;
        },
        catch: (cause) => new ReadFailed({ source: "pulls", detail: String(cause).slice(0, 200) }),
      }),
  });

/** Conclusions that need someone to act before the check can go green. */
const FAILING_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);
/** Conclusions that say nothing about the change: a path-filtered skip, a neutral report, a superseded cancel. */
const INERT_CONCLUSIONS = new Set(["skipped", "neutral", "cancelled"]);

/**
 * The head commit's check health: `failing` when any check concluded failing, else `pending` when any check has not
 * completed, else `passing` when any check succeeded, else `none`.
 */
export const checkHealth = (runs: readonly CheckRun[]): CheckHealth => {
  if (runs.some((r) => r.status === "completed" && FAILING_CONCLUSIONS.has(r.conclusion ?? "")))
    return "failing";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  const decisive = runs.filter((r) => !INERT_CONCLUSIONS.has(r.conclusion ?? ""));
  return decisive.some((r) => r.conclusion === "success") ? "passing" : "none";
};

/**
 * The review state from each reviewer's latest decisive review: `changes-requested` when any reviewer's stands at
 * changes requested, else `approved` when any stands approved, else `none`. A comment leaves a reviewer's state as it
 * was; a dismissal clears it.
 */
export const reviewState = (reviews: readonly Review[]): ReviewState => {
  const latest = new Map<string, string>();
  for (const r of reviews)
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") latest.set(r.author, r.state);
    else if (r.state === "DISMISSED") latest.delete(r.author);
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "changes-requested";
  return states.includes("APPROVED") ? "approved" : "none";
};

export interface PrState {
  readonly checks: CheckHealth;
  readonly review: ReviewState;
  readonly daysSinceUpdate: number;
  readonly labels: readonly string[];
  readonly draft: boolean;
}

/** The pull request's state, derived from GitHub's fields alone (FD-AGT-078). */
export const prState = (pr: OpenPullRequest, now: number): PrState => ({
  checks: checkHealth(pr.checkRuns),
  review: reviewState(pr.reviews),
  daysSinceUpdate: Math.max(0, Math.floor((now - pr.updatedAt) / 86_400_000)),
  labels: pr.labels,
  draft: pr.draft,
});

const held = (s: PrState) =>
  s.draft || s.labels.some((l) => (HOLD_LABELS as readonly string[]).includes(l.toLowerCase()));

/**
 * The one route a state takes (FD-AGT-078), first match wins: a draft or a hold label `ask`s; failing checks, and
 * checks pending for `PENDING_STUCK_DAYS` days, `unstick`; passing checks with an approval take `auto-merge`; a pull
 * request without an approval and quiet for `NUDGE_AFTER_DAYS` days takes `nudge`; every other state `ask`s.
 */
export const routeOf = (s: PrState): TriageRoute => {
  if (held(s)) return "ask";
  if (s.checks === "failing") return "unstick";
  if (s.checks === "pending" && s.daysSinceUpdate >= PENDING_STUCK_DAYS) return "unstick";
  if (s.checks === "passing" && s.review === "approved") return "auto-merge";
  if (s.review !== "approved" && s.daysSinceUpdate >= NUDGE_AFTER_DAYS) return "nudge";
  return "ask";
};

/** A digest line or title as one markdown-inert line: no newline, code span, table cell, HTML, mention or URL. */
export const flattenLine = (raw: string, max: number) => {
  const flat = raw
    .replace(/\s+/g, " ")
    .replace(/[`|<>]/g, "")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "[link]")
    .replace(/@/g, "@​")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The digest line written when the model call fails or answers nothing: the state in words. */
export const templatedLine = (s: PrState) =>
  `checks ${s.checks}, review ${s.review}, ${s.daysSinceUpdate} d since update`;

const SYSTEM = [
  "You write one line of a pull-request triage digest for a maintainer.",
  `Answer with the line alone, at most ${DIGEST_LINE_MAX_CHARS} characters, plain text, no links or mentions.`,
  "Describe what the pull request needs next given its state. The route is decided; do not change or restate it.",
].join("\n");

/**
 * The digest line of one pull request (FD-AGT-079): one `transform` call given the route and the derived state; the
 * title enters the prompt only from a trusted author, since the recipe declares no untrusted input. A failed call or
 * an empty answer writes the templated line.
 */
const digestLine = (pr: OpenPullRequest, s: PrState, route: TriageRoute) =>
  Effect.gen(function* () {
    const model = yield* ModelClient;
    const text = yield* model.complete({
      callSite: "digest",
      tier: "transform",
      maxTokens: 80,
      messages: promptMessages({
        system: SYSTEM,
        instruction: `Pull request #${pr.number}: route ${route}, checks ${s.checks}, review ${s.review}, ${s.daysSinceUpdate} days since last update, labels: ${
          s.labels.length === 0 ? "none" : s.labels.join(", ")
        }.`,
        texts: [{ author: pr.author, association: pr.authorAssociation, text: pr.title }],
        untrustedInput: false,
      }),
    });
    const line = flattenLine(sanitizeModelText(text), DIGEST_LINE_MAX_CHARS);
    return line === "" ? templatedLine(s) : line;
  }).pipe(Effect.catchTag("ModelCallError", () => Effect.succeed(templatedLine(s))));

export interface RoutedPr {
  readonly number: number;
  readonly title: string;
  readonly state: PrState;
  readonly route: TriageRoute;
  readonly line: string;
}

/** The digest's path for a day, `YYYY-MM-DD`. */
export const triageDigestPath = (day: string) => `.flare-dispatch/triage/prs-${day}.md`;

const ROUTE_HEADING: Record<TriageRoute, string> = {
  "auto-merge": "Auto-merge: checks pass and a reviewer approved",
  nudge: "Nudge: waiting on a review or the author",
  unstick: "Unstick: checks fail or stall",
  ask: "Ask: needs a maintainer's decision",
};

/** The digest file: a count per route, then one section per non-empty route in `TRIAGE_ROUTES` order. */
export const renderDigest = (day: string, routed: readonly RoutedPr[]) => {
  const count = (r: TriageRoute) => routed.filter((p) => p.route === r).length;
  const lines = [
    `# Pull request triage, ${day}`,
    "",
    `${routed.length} open pull requests: ${TRIAGE_ROUTES.map((r) => `${count(r)} ${r}`).join(", ")}.`,
    "",
    "Each route is a recommendation. This report merges, assigns and closes nothing.",
    "",
  ];
  for (const route of TRIAGE_ROUTES) {
    const inRoute = routed.filter((p) => p.route === route);
    if (inRoute.length === 0) continue;
    lines.push(`## ${ROUTE_HEADING[route]} (${inRoute.length})`, "");
    for (const p of inRoute)
      lines.push(
        `- #${p.number} ${p.title}: ${p.line}`,
        `  - checks ${p.state.checks} · review ${p.state.review} · ${p.state.daysSinceUpdate} d since update · labels: ${
          p.state.labels.length === 0
            ? "none"
            : p.state.labels.map((l) => flattenLine(l, 50)).join(", ")
        }`,
      );
    lines.push("");
  }
  return lines.join("\n");
};

/**
 * The `triage-prs` body. A suppressed key reads nothing and stages nothing (FD-AGT-043). Each open pull request is
 * routed from its derived state before its digest call, so no route reads model output (FD-AGT-078, FD-AGT-079). The
 * routes leave the run as one staged write on `TRIAGE_PRS_BRANCH` under `.flare-dispatch/triage/`, and the run appends
 * no intent, so it carries no merge, assignment or close (FD-AGT-080). A repository with no open pull request stages
 * nothing.
 */
export const runTriagePrs = (input: TriagePrsInput) =>
  Effect.gen(function* () {
    const suppressed = yield* checkSuppression(suppressionKey(input.repo, TRIAGE_PRS_BRANCH));
    if (suppressed) return { _tag: "success" } satisfies RunResult;
    const now = yield* Clock.currentTimeMillis;
    const read = yield* PullRequestsRead;
    // The Layer requests `MAX_OPEN_PRS`; the slice bounds any other `PullRequestsRead`.
    const open = (yield* read.openPullRequests(`${input.repo.owner}/${input.repo.name}`)).slice(
      0,
      MAX_OPEN_PRS,
    );
    if (open.length === 0) return { _tag: "success" } satisfies RunResult;
    const routed: RoutedPr[] = [];
    for (const pr of open) {
      const state = prState(pr, now);
      const route = routeOf(state);
      routed.push({
        number: pr.number,
        title: flattenLine(pr.title, TITLE_MAX_CHARS),
        state,
        route,
        line: yield* digestLine(pr, state, route),
      });
    }
    const day = new Date(now).toISOString().slice(0, 10);
    const path = triageDigestPath(day);
    const checkout = yield* Checkout;
    yield* checkout.write(path, renderDigest(day, routed));
    const stage = yield* StagedWrites;
    yield* stage.stage({
      branch: TRIAGE_PRS_BRANCH,
      baseBranch: input.baseBranch,
      message: `docs(triage): route ${routed.length} open pull requests`,
      pr: {
        title: `Pull request triage, ${day}`,
        body: `Routes of ${routed.length} open pull requests. Each route is a recommendation; nothing is merged, assigned or closed.`,
        draft: true,
        labels: ["triage-prs"],
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
      StageFailed: (e) =>
        Effect.succeed({
          _tag: "failure",
          reason: `infra: stage: ${e.detail}`,
        } satisfies RunResult),
    }),
  );
