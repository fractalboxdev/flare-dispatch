import { Effect } from "effect";
import { expect, it } from "vitest";
import { commentDatabase } from "./comment-writes.test-support.ts";
import { d1CommentWrites } from "./comment-writes.ts";

it("independent SQL owners admit one external attempt and a stale owner cannot release its replacement", async () => {
  const db = commentDatabase();
  const a = d1CommentWrites(db),
    b = d1CommentWrites(db);
  const old = { token: "first", receipt: "first receipt" },
    next = { token: "second", receipt: "second receipt" };
  const claims = await Promise.all([
    Effect.runPromise(a.claim("pr", old)),
    Effect.runPromise(b.claim("pr", next)),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const winner = claims[0] ? old : next;
  expect(await Effect.runPromise(b.read("pr"))).toEqual(winner);
  await Effect.runPromise(a.release("pr", winner.token));
  expect(await Effect.runPromise(b.claim("pr", next))).toBe(true);
  await Effect.runPromise(a.release("pr", "first"));
  expect(await Effect.runPromise(a.read("pr"))).toEqual(next);
});
