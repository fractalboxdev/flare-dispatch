// The control plane's `ConcludeFacts`: the intake record beside mameko's rows on D1, with the check run's log link
// minted under the API's link key.
import { checkLinkToken } from "@fractalboxdev/flare-dispatch-api/link-token";
import { ConcludeFacts } from "@fractalboxdev/flare-dispatch-github";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ControlPlaneEnv } from "../src/config.ts";
import { concludeFactsLayer } from "../src/github.ts";
import { envOf, LINK_KEY, ORIGIN, seedExecution } from "./conclude.test-support.ts";

const factsOf = (env: ControlPlaneEnv, executionId: string) =>
  Effect.runPromise(
    ConcludeFacts.use((f) => f.of(executionId)).pipe(Effect.provide(concludeFactsLayer(env))),
  );

describe("the control plane's conclude facts", () => {
  it("[FD-GH-013] the details URL is the execution's log viewer link with a link token bound to it", async () => {
    const db = await migratedD1();
    await seedExecution(db, "exec-1", "success");
    const facts = await factsOf(envOf(db, { PUBLIC_ORIGIN: ORIGIN, LINK_KEY }), "exec-1");
    const url = new URL(facts!.detailsUrl!);
    expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}/v1/executions/exec-1/logs`);
    const token = url.searchParams.get("t")!;
    const check = (objectId: string) =>
      checkLinkToken(LINK_KEY, token, {
        purpose: "logs",
        objectId,
        nowS: Math.floor(Date.now() / 1000),
        currentEpoch: 0,
      });
    expect(await check("exec-1")).toEqual({ _tag: "Granted" });
    expect(await check("exec-2")).toEqual({ _tag: "Invalid" });
  });

  it("[FD-GH-013] a deploy that names no public origin writes no details URL", async () => {
    const db = await migratedD1();
    await seedExecution(db, "exec-1", "success");
    expect((await factsOf(envOf(db, { LINK_KEY }), "exec-1"))?.detailsUrl).toBeUndefined();
  });

  it("[FD-GH-008] [FD-GH-015] reads the name, attempt, class and recorded outcome from the execution's records", async () => {
    const db = await migratedD1();
    await seedExecution(db, "exec-1");
    db.sqlite
      .prepare(
        "update executions set status = 'skipped', reason = 'not-applicable: draft-pr' where id = ?",
      )
      .run("exec-1");
    expect(await factsOf(envOf(db), "exec-1")).toMatchObject({
      name: "flare-dispatch/check:ci",
      headSha: "b".repeat(40),
      attempt: 1,
      details: {
        class: "required",
        executor_kind: null,
        placement_reason: "not placed",
      },
      recorded: {
        _tag: "skipped",
        reason: "not-applicable",
        detail: "draft-pr",
      },
    });
    expect(await factsOf(envOf(db), "unknown")).toBeNull();
  });
});
