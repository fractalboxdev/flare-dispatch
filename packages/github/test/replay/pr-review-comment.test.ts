// `pr-review`'s review comment run twice over one journal (pr-review-comment.replay.ts): two reviews of one pull
// request keep one comment, and the second run makes no GitHub call, D1 write or intent the first did not.
import { describe, expect, it } from "vitest";
import { PR_REVIEW_MARKER } from "../../../agentic/src/recipes/pr-review.ts";
import { runReplays } from "../../../ops/src/verification/harness.ts";
import { intentMarker } from "../../src/side-applier.ts";
import type { Plane } from "./github.replay.ts";
import { FIRST, PULL, reviews, SECOND, workflows } from "./pr-review-comment.replay.ts";

const replayed = async () => {
  const runs: Awaited<ReturnType<typeof reviews>>[] = [];
  const extras = await runReplays([
    {
      ...workflows[0]!,
      run: async (journal) => {
        const out = await reviews(journal as Plane | null);
        runs.push(out);
        return out;
      },
    },
  ]);
  return { extras, first: runs[0]!.effects, second: runs[1]!.effects, p: runs[0]!.journal };
};

const commentCalls = (effects: readonly { kind: string; key: string }[]) =>
  effects.filter((e) => e.kind === "github" && /Comment/.test(e.key)).map((e) => e.key);

describe("pr-review's review comment under a replayed workflow", () => {
  it("[FD-AGT-053] two reviews of one pull request keep one marked comment, updated in place, and the replay makes no GitHub call", async () => {
    const { extras, first, second, p } = await replayed();
    try {
      expect(extras).toEqual([]);
      expect(second).toEqual([]);
      // The first review creates the comment; the second updates it in place.
      expect(commentCalls(first)).toEqual([
        "listComments",
        "createComment",
        "listComments",
        "updateComment",
      ]);
      const comments = p.side.comments.get(PULL) ?? [];
      expect(comments).toHaveLength(1);
      const body = comments[0]!.body;
      expect(body).toContain(PR_REVIEW_MARKER);
      expect(body).toContain("second-review");
      expect(body).not.toContain("first-review");
      expect(body).toContain(intentMarker({ executionId: SECOND, intentKey: "run:comment:0" }));
      // Each review's annotations reach its own check run.
      expect([...p.gh.annotations.values()].map((as) => as.map((x) => x.title))).toEqual([
        ["first-review"],
        ["second-review"],
      ]);
      expect(
        p.rows(
          "select execution_id, state, external_ref from outbox where kind = 'comment' order by execution_id",
        ),
      ).toEqual([
        { execution_id: FIRST, state: "applied", external_ref: String(comments[0]!.id) },
        { execution_id: SECOND, state: "applied", external_ref: String(comments[0]!.id) },
      ]);
    } finally {
      await p.dispose();
    }
  });
});
