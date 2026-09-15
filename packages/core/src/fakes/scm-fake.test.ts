// Scm fake unit tests — the provider-neutral source-control simulator.

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { scm, type ChangeRef } from "../services/scm";
import { makeScmFake } from "./scm-fake";

const ref: ChangeRef = {
  project: "group/project",
  number: 7,
  headSha: "head123",
  baseSha: "base456",
};

describe("makeScmFake", () => {
  it("fetchDiff returns the canned diff and records the ref", async () => {
    const { layer, state } = makeScmFake({ diff: "diff --git a/x b/x\n+y\n" });
    const got = await Effect.runPromise(
      scm.fetchDiff(ref).pipe(Effect.provide(layer)),
    );
    expect(got.diff).toBe("diff --git a/x b/x\n+y\n");
    expect(got.truncated).toBeUndefined();
    expect(state.fetchDiffCalls).toEqual([ref]);
    expect(state.postReviewCalls).toHaveLength(0);
  });

  it("fetchDiff carries a configured truncated/pages flag", async () => {
    const { layer } = makeScmFake({ diff: "d", truncated: true, pages: 50 });
    const got = await Effect.runPromise(
      scm.fetchDiff(ref).pipe(Effect.provide(layer)),
    );
    expect(got).toEqual({ diff: "d", truncated: true, pages: 50 });
  });

  it("postReview records the note and returns the canned noteId", async () => {
    const { layer, state } = makeScmFake();
    const result = await Effect.runPromise(
      scm.postReview({ ref, body: "AI review" }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual({ noteId: "fake-note-1" });
    expect(state.postReviewCalls).toHaveLength(1);
    expect(state.postReviewCalls[0]).toEqual({ ref, body: "AI review" });
  });

  it("postReview honors a configured noteId (including null, for a degraded post)", async () => {
    const { layer } = makeScmFake({ noteId: null });
    const result = await Effect.runPromise(
      scm.postReview({ ref, body: "AI review" }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual({ noteId: null });
  });

  it("updateReview records the call and succeeds", async () => {
    const { layer, state } = makeScmFake();
    await Effect.runPromise(
      scm.updateReview({ ref, noteId: "fake-note-1", body: "updated" }).pipe(Effect.provide(layer)),
    );
    expect(state.updateReviewCalls).toHaveLength(1);
    expect(state.updateReviewCalls[0]).toEqual({ ref, noteId: "fake-note-1", body: "updated" });
  });

  it("defaults to a valid one-file unified diff", async () => {
    const { layer } = makeScmFake();
    const got = await Effect.runPromise(
      scm.fetchDiff(ref).pipe(Effect.provide(layer)),
    );
    expect(got.diff).toContain("diff --git");
    expect(got.diff).toContain("+++ b/");
  });
});
