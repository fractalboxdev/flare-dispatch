import { describe, expect, it } from "vitest";
import { dedupRecipes, type KeyedRequest } from "./dedup.ts";

const request = (over: Partial<KeyedRequest>): KeyedRequest => ({
  run: "stack-deploy",
  label: "production",
  repo: "o/r",
  sha: "a".repeat(40),
  idempotency: null,
  followOn: null,
  release: null,
  attempt: 1,
  cronMinute: null,
  local: null,
  ...over,
});

/** The first key a recipe returns, as mameko's `dedupKey` takes it. */
const keyOf = (r: KeyedRequest) => {
  for (const recipe of dedupRecipes) {
    const key = recipe.run(r);
    if (key !== null) return key;
  }
  return null;
};

describe("AWS build dedup keys", () => {
  it("[FD-GATE-134] keys a stack's apply on the commit, so a follow-on and a dispatch of one commit reach one execution", () => {
    const fromFollowOn = request({
      followOn: { executionId: "01JPUB", intentKey: "stack-deploy:production:0" },
    });
    const fromDispatch = request({ idempotency: { key: "k", body: {} } });
    expect(keyOf(fromFollowOn)).toBe(`stack-deploy:production:o/r:${"a".repeat(40)}`);
    expect(keyOf(fromDispatch)).toBe(keyOf(fromFollowOn));
  });

  it("[FD-GATE-128] keys a publish on the commit and its label", () => {
    expect(keyOf(request({ run: "image-publish", label: null }))).toBe(
      `image-publish:o/r:${"a".repeat(40)}`,
    );
    expect(keyOf(request({ run: "image-publish", label: "arm" }))).toBe(
      `image-publish:arm:o/r:${"a".repeat(40)}`,
    );
  });
});
