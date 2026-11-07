// The follow-on admission port behind the `dispatch.followOn` applier, and the probes' ops intents on the outbox.
import { FollowOnSubmitter, insertOpsIntent } from "@fractalboxdev/flare-dispatch-github";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { followOnSubmitterLayer } from "./follow-on.ts";
import {
  bodyOf,
  harness,
  HEAD,
  pullRequestPayload,
  REPO,
  signedWebhook,
} from "./harness.test-support.ts";
import { handleIntake } from "./routes.ts";
import { migratedD1 } from "./testing.ts";

const submit = (
  h: Awaited<ReturnType<typeof harness>>,
  executionId: string,
  inputs: unknown = { sha: HEAD },
) =>
  h.run(
    FollowOnSubmitter.use((s) =>
      s.submit({ executionId, intentKey: "run:review:0", run: "lint", label: null, inputs }),
    ).pipe(Effect.provide(followOnSubmitterLayer)),
  );

describe("dispatch.followOn", () => {
  it("FD-GH-088 a repeated apply submits one request keyed <execution_id>/<intent_key> on the parent's commit", async () => {
    const h = await harness();
    const opened = await bodyOf(
      await h.run(
        handleIntake(await signedWebhook("pull_request", pullRequestPayload()), "webhooks/github"),
      ),
    );
    const parent = (opened.executions as string[])[0]!;
    const first = await submit(h, parent);
    const again = await submit(h, parent);
    expect(first).toEqual(again);
    expect(first).toMatchObject({ _tag: "admitted" });
    const child = h
      .records()
      .find((r) => r.execution_id === (first as { executionId: string }).executionId)!;
    expect(child).toMatchObject({ run: "lint", repo: REPO, sha: HEAD });
    // `lint` ran on the parent's commit moments ago, so the follow-on is held for its cooldown window (FD-INT-057)
    // and its key waits with the held request until admission.
    expect(
      h.rows(
        `select canonical from dedup_keys where canonical like ?1
         union all
         select json_extract(admit_json, '$.dedup.canonical') from intake_held
         where json_extract(admit_json, '$.dedup.canonical') like ?1`,
        `${parent}/%`,
      ),
    ).toEqual([{ canonical: `${parent}/run:review:0` }]);
  });

  it("FD-GH-088 a follow-on of an unknown execution is refused and admits nothing", async () => {
    const h = await harness();
    expect(await submit(h, "no-such-execution")).toMatchObject({ _tag: "refused" });
    expect(h.executions()).toEqual([]);
  });
});

describe("ops intents", () => {
  it("FD-GH-089 a probe inserts its ops intent once, keyed ops:<key>, scoped to the repository it names", async () => {
    const db = await migratedD1();
    const intent = {
      kind: "canary.push" as const,
      scopeId: "acme/fixture",
      key: "canary:2026-11-04T12:00Z",
      payload: { branch: "canary", tick_time: "2026-11-04T12:00Z" },
      limitKey: "7",
      now: 1,
    };
    await Effect.runPromise(insertOpsIntent(db, intent));
    await Effect.runPromise(insertOpsIntent(db, intent));
    expect(
      db.sqlite
        .prepare("select execution_id, scope_id, intent_key, kind, limit_key, state from outbox")
        .all(),
    ).toEqual([
      {
        execution_id: null,
        scope_id: "acme/fixture",
        intent_key: "ops:canary:2026-11-04T12:00Z",
        kind: "canary.push",
        limit_key: "7",
        state: "pending",
      },
    ]);
  });
});
