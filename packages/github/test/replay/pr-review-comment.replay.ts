// `pr-review`'s one review comment as a `V-REPLAY` workflow (specs/runs/agentic.md FD-AGT-053). Two executions review
// one pull request, the second after a new push: each runs `prReviewRun`'s workflow over fake reviewers, stages the
// run's `comment` and `check.annotations` intents under its epoch, accepts its outcome and drains the outbox to quiet
// onto a fake GitHub (github.replay.ts). The first execution creates the comment carrying `PR_REVIEW_MARKER`; the
// second updates that comment in place. A second run repeats every step over the same D1 and fakes, as an engine that
// lost its journal entries runs them again. Every GitHub call the comment applier makes is an effect.
import { executionId } from "@fractalboxdev/mameko-coordinator";
import { Effect, Layer } from "effect";
import type { ReplayEffect, ReplayWorkflow } from "../../../ops/src/verification/harness.ts";
import {
  fakeServices,
  payload,
  recorder,
} from "../../../agentic/src/recipes/fakes.test-support.ts";
import {
  PR_REVIEW_CHECK_NAME,
  type ReviewerFinding,
  type PrReviewInput,
} from "../../../agentic/src/recipes/pr-review.ts";
import { prReviewRun } from "../../../agentic/src/recipes/runs.ts";
import { plane, SHA, type Plane, type StagedIntent } from "./github.replay.ts";

const T0 = Date.UTC(2026, 10, 4, 13, 0, 0);
/** The execution that reviews the pull request first. */
export const FIRST = executionId(T0 + 1, () => 0.25);
/** The execution that reviews it again after a push. */
export const SECOND = executionId(T0 + 2, () => 0.25);
export const PULL = 7;

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,1 +1,1 @@",
  "+line 0",
].join("\n");

const input: PrReviewInput = {
  repo: { owner: "acme", name: "app" },
  number: PULL,
  baseSha: "a".repeat(40),
  headSha: SHA,
  draft: false,
  labels: [],
  authorLogin: "dev",
  authorAssociation: "MEMBER",
  forkHead: false,
  maxDiffChars: 100_000,
};

/** Each execution's reviewer answer: the first finds a warning, the second a failure on another line. */
export const FINDINGS: Readonly<Record<string, ReviewerFinding>> = {
  [FIRST]: {
    path: "src/a.ts",
    startLine: 1,
    endLine: 1,
    level: "warning",
    title: "first-review",
    message: "m",
  },
  [SECOND]: {
    path: "src/a.ts",
    startLine: 1,
    endLine: 1,
    level: "failure",
    title: "second-review",
    message: "m",
  },
};

/** One `pr-review` execution's body over fake reviewers, and the intents it emits as the runner stages them. */
const review = async (id: string): Promise<readonly StagedIntent[]> => {
  const rec = recorder();
  await Effect.runPromise(
    prReviewRun.workflow.execute(payload("pr-review", input, id)).pipe(
      Effect.provide(
        Layer.provideMerge(
          prReviewRun.layer,
          fakeServices(rec, {
            shell: (command) => ({
              exitCode: command.startsWith("git diff") ? 0 : 1,
              stdout: command.startsWith("git diff") ? DIFF : "",
              stderr: "",
            }),
            model: () => JSON.stringify({ findings: [FINDINGS[id]] }),
          }),
        ),
      ),
    ),
  );
  return rec.intents.map((i, n) => ({
    intent_key: `${i.step}:${n}`,
    kind: i.kind,
    payload: i.payload,
  }));
};

/** The side-output writes that touch issue comments. */
const COMMENT_CALLS = /^(listComments|createComment|updateComment)$/;

/** One run of both reviews, over `journal` or a fresh plane. */
export const reviews = async (journal: Plane | null) => {
  const p = journal ?? (await plane());
  const ghCalls = p.gh.calls.length;
  const sideCalls = p.side.calls.length;
  const outbox = new Set(p.rows<{ id: string }>("select id from outbox").map((r) => r.id));

  for (const id of [FIRST, SECOND]) {
    const intents = await review(id);
    await p.admit(id, PR_REVIEW_CHECK_NAME);
    await p.drainAll();
    await p.stage(id, intents);
    await p.accept(id);
    await p.terminal(id);
    await p.drainAll();
  }

  const effects: ReplayEffect[] = [
    ...p.gh.calls.slice(ghCalls).map((call): ReplayEffect => ({ kind: "github", key: call })),
    ...p.side.calls
      .slice(sideCalls)
      .filter((call) => COMMENT_CALLS.test(call))
      .map((call): ReplayEffect => ({ kind: "github", key: call })),
    ...p
      .rows<{ id: string }>("select id from outbox")
      .filter((r) => !outbox.has(r.id))
      .map((r): ReplayEffect => ({ kind: "intent", key: r.id })),
  ];
  return { journal: p, effects };
};

export const workflows: readonly ReplayWorkflow<Plane>[] = [
  {
    name: "pr-review-comment",
    ids: ["FD-AGT-053"],
    run: async (journal) => {
      const out = await reviews(journal);
      if (journal !== null) await out.journal.dispose();
      return out;
    },
  },
];
