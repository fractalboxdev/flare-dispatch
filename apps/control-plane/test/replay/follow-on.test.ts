// A `dispatch.followOn` row drains twice through the isolate's actuators: the first apply admits the child, and a
// replay of the same row, as a drainer that lost its claim after applying sends it again, answers the same child. The
// second pass starts no second execution and writes no second dedup key.
import { d1OutboxStore, insertOutboxRows } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { drainOnce } from "@fractalboxdev/mameko-coordinator";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { NOW } from "../conclude.test-support.ts";
import {
  appDeploy,
  followOnRow,
  INTENT_KEY,
  PARENT,
  type AppDeploy,
} from "../follow-on.test-support.ts";

const insert = (deploy: AppDeploy) =>
  insertOutboxRows(deploy.db, [
    {
      id: `${PARENT}:${INTENT_KEY}`,
      limitKey: "7",
      tier: "effect",
      priority: 2,
      classRank: 1,
      drawsReserve: false,
      intent: followOnRow(),
      row: newRow({ effectClass: "replay-safe", insertedAt: NOW }),
    },
  ]);

const drain = (deploy: AppDeploy, now: number) =>
  Effect.runPromise(
    drainOnce({
      now,
      token: (id) => `tok-${id}-${now}`,
      random: () => 0,
      actuatorOf: { "dispatch.followOn": "followOn" },
    }).pipe(Effect.provide(d1OutboxStore(deploy.db)), Effect.provide(deploy.services)),
  );

const outbox = (deploy: AppDeploy) =>
  deploy.db.sqlite
    .prepare(
      "select intent_key, kind, state, external_ref from outbox where kind = 'dispatch.followOn'",
    )
    .all();

describe("the dispatch.followOn row under a replayed apply", () => {
  it("[FD-GH-088] a replayed apply of one follow-on row answers the child the first apply admitted and starts no second execution", async () => {
    const deploy = await appDeploy();
    await insert(deploy);
    await drain(deploy, NOW + 1_000);
    const [child] = deploy.children();
    expect(child).toMatchObject({ run: "deploy-smoke" });
    expect(outbox(deploy)).toEqual([
      {
        intent_key: INTENT_KEY,
        kind: "dispatch.followOn",
        state: "applied",
        external_ref: child!.execution_id,
      },
    ]);

    // The parent's replayed step inserts the intent again, and the drainer that applied it lost its answer: the row is
    // back in flight under an expired claim. The claim's expiry makes it ambiguous, a replay-safe row goes back to
    // pending without a lookup, and a later pass sends it again.
    await insert(deploy);
    deploy.db.sqlite
      .prepare(
        `update outbox set state = 'in_flight', claim_token = 'lost', claim_expires_at = ?, external_ref = null,
           applied_at = null where kind = 'dispatch.followOn'`,
      )
      .run(NOW + 2_000);
    for (let pass = 1; pass <= 4; pass++) await drain(deploy, NOW + pass * 15 * 60_000);
    expect(
      deploy.db.sqlite.prepare("select sends from outbox where kind = 'dispatch.followOn'").all(),
    ).toEqual([{ sends: 2 }]);

    expect(outbox(deploy)).toEqual([
      {
        intent_key: INTENT_KEY,
        kind: "dispatch.followOn",
        state: "applied",
        external_ref: child!.execution_id,
      },
    ]);
    expect(deploy.children()).toEqual([child]);
    expect(deploy.db.sqlite.prepare("select canonical from dedup_keys").all()).toEqual([
      { canonical: `${PARENT}/${INTENT_KEY}` },
    ]);
    expect(deploy.starts.map((p) => p.executionId)).toEqual([child!.execution_id]);
  });
});
