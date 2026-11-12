// A reproduction execution's outbox row drains twice through the isolate's actuators, as the composition builds them: a
// `dispatch.followOn` row of it is refused on the first pass, and a replay of the same row, as a drainer that lost its
// claim sends it again, is refused again. Neither pass starts an execution or writes a dedup key; the same row of an
// execution that is not a reproduction admits its child.
import { d1OutboxStore, insertOutboxRows } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { drainOnce } from "@fractalboxdev/mameko-coordinator";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { NOW } from "../conclude.test-support.ts";
import { appDeploy, followOnRow, INTENT_KEY, PARENT, type AppDeploy } from "../follow-on.test-support.ts";

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
    .prepare("select intent_key, state, external_ref, last_error from outbox where kind = 'dispatch.followOn'")
    .all();

const asReproduction = (deploy: AppDeploy) =>
  deploy.db.sqlite
    .prepare("update intake_records set placement_constraint = 'reproduction' where execution_id = ?")
    .run(PARENT);

describe("a reproduction execution's outbox rows under a replayed apply", () => {
  it("[FD-PROV-065] the control plane applies no outbox row of a reproduction execution, on the first apply or a replay", async () => {
    const deploy = await appDeploy();
    asReproduction(deploy);
    await insert(deploy);
    await drain(deploy, NOW + 1_000);
    const refused = outbox(deploy);
    expect(refused).toEqual([
      {
        intent_key: INTENT_KEY,
        state: "refused",
        external_ref: null,
        last_error: expect.stringContaining("reproduction"),
      },
    ]);

    // The replayed step inserts the row again and the drainer lost its answer: the row is back in flight under an
    // expired claim, and later passes send it again.
    await insert(deploy);
    deploy.db.sqlite
      .prepare(
        `update outbox set state = 'in_flight', claim_token = 'lost', claim_expires_at = ?, external_ref = null,
           applied_at = null`,
      )
      .run(NOW + 2_000);
    for (let pass = 1; pass <= 4; pass++) await drain(deploy, NOW + pass * 15 * 60_000);
    expect(outbox(deploy)).toEqual(refused);
    expect(deploy.children()).toEqual([]);
    expect(deploy.db.sqlite.prepare("select canonical from dedup_keys").all()).toEqual([]);
    expect(deploy.starts).toEqual([]);

    // The same row of an execution that is not a reproduction admits its child.
    const other = await appDeploy();
    await insert(other);
    await drain(other, NOW + 1_000);
    expect(other.children()).toHaveLength(1);
    expect(outbox(other)).toMatchObject([{ intent_key: INTENT_KEY, state: "applied" }]);
  });
});
