// The dedup recipes' canonical strings and the request digest of the `idempotency-key` recipe.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { canonicalJson, requestKey, validIdempotencyKey, type KeyedRequest } from "./dedup.ts";

const base: KeyedRequest = {
  run: "check",
  label: null,
  repo: "acme/app",
  sha: "a".repeat(40),
  idempotency: null,
  followOn: null,
  attempt: 1,
  cronMinute: null,
  local: null,
};
const key = (r: Partial<KeyedRequest>) => Effect.runPromise(requestKey({ ...base, ...r }));

describe("dedup recipes", () => {
  it("[FD-INT-009] the commit recipe returns <run>[:<label>]:<owner>/<repo>:<sha> with no trigger kind", async () => {
    expect((await key({})).canonical).toBe(`check:acme/app:${"a".repeat(40)}`);
    expect((await key({ label: "ci" })).canonical).toBe(`check:ci:acme/app:${"a".repeat(40)}`);
    const k = await key({});
    expect(k).toMatchObject({ recipe: "commit", requestDigest: null, onMismatch: "duplicate" });
    expect(k.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("[FD-INT-054] an attempt n >= 2 appends :attempt-<n>", async () => {
    expect((await key({ label: "ci", attempt: 3 })).canonical).toBe(
      `check:ci:acme/app:${"a".repeat(40)}:attempt-3`,
    );
  });

  it("[FD-INT-053] a cron trigger keys on the scheduled minute in ISO 8601 UTC", async () => {
    expect((await key({ cronMinute: Date.UTC(2026, 10, 4, 3, 0, 42) })).canonical).toBe(
      "check:acme/app:cron:2026-11-04T03:00:00.000Z",
    );
  });

  it("[FD-INT-061] a local submit keys on the lease, run, tree hash and inputs digest", async () => {
    expect(
      (await key({ local: { leaseId: "L1", treeHash: "t", inputsDigest: "d" } })).canonical,
    ).toBe("local:L1:check:t:d");
  });

  it("[FD-GH-088] a follow-on intent keys on <execution_id>/<intent_key>", async () => {
    expect(
      (await key({ followOn: { executionId: "E1", intentKey: "run:review:0" } })).canonical,
    ).toBe("E1/run:review:0");
  });

  it("[FD-INT-010] an Idempotency-Key wins over every other recipe and digests the canonical body for conflict", async () => {
    const a = await key({ idempotency: { key: "k-1", body: { b: 1, a: [2, { d: 1, c: 2 }] } } });
    const b = await key({ idempotency: { key: "k-1", body: { a: [2, { c: 2, d: 1 }], b: 1 } } });
    const c = await key({ idempotency: { key: "k-1", body: { a: 1 } } });
    expect(a).toMatchObject({
      recipe: "idempotency-key",
      canonical: "idem:acme/app:k-1",
      onMismatch: "conflict",
    });
    expect(a.requestDigest).toBe(b.requestDigest);
    expect(c.requestDigest).not.toBe(a.requestDigest);
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [1] } })).toBe('{"a":{"c":[1]},"b":1}');
  });

  it("[FD-INT-011] accepts 1 to 128 characters of [A-Za-z0-9._:-] and nothing else", () => {
    expect(validIdempotencyKey("a")).toBe(true);
    expect(validIdempotencyKey("A.b_c:d-9".padEnd(128, "x"))).toBe(true);
    expect(validIdempotencyKey("")).toBe(false);
    expect(validIdempotencyKey("x".repeat(129))).toBe(false);
    expect(validIdempotencyKey("a b")).toBe(false);
    expect(validIdempotencyKey("a/b")).toBe(false);
  });
});
