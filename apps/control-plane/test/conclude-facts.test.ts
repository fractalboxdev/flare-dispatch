// The control plane's `ConcludeFacts`: the intake record beside mameko's rows on D1, with the check run's log link
// minted under the API's link key.
import { checkLinkToken } from "@fractalboxdev/flare-dispatch-api/link-token";
import { ConcludeFacts, ConcludeFactsUnavailable } from "@fractalboxdev/flare-dispatch-github";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ControlPlaneEnv } from "../src/config.ts";
import { concludeFactsLayer } from "../src/github.ts";
import { envOf, LINK_KEY, ORIGIN, seedExecution, seedStatement } from "./conclude.test-support.ts";

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

  it("[FD-CACHE-087] issues the log link token bound to one execution id, under the logs label, for at most 7 days", async () => {
    const db = await migratedD1();
    await seedExecution(db, "exec-1", "success");
    const env = envOf(db, { PUBLIC_ORIGIN: ORIGIN, LINK_KEY, LINK_LIFETIME_S: "604800" });
    const before = Math.floor(Date.now() / 1000);
    const token = new URL((await factsOf(env, "exec-1"))!.detailsUrl!).searchParams.get("t")!;
    const lifetime = Number(token.split(".")[0]) - before;
    expect(lifetime).toBeGreaterThanOrEqual(604_800);
    expect(lifetime).toBeLessThanOrEqual(604_800 + 5);
    const check = (purpose: "logs" | "artifact", objectId: string) =>
      checkLinkToken(LINK_KEY, token, {
        purpose,
        objectId,
        nowS: Math.floor(Date.now() / 1000),
        currentEpoch: 0,
      });
    expect(await check("logs", "exec-1")).toEqual({ _tag: "Granted" });
    expect(await check("logs", "exec-2")).toEqual({ _tag: "Invalid" });
    // The artifact label derives another key, so the token opens no artifact of the same id.
    expect(await check("artifact", "exec-1")).toEqual({ _tag: "Invalid" });
    const overLong = envOf(db, { PUBLIC_ORIGIN: ORIGIN, LINK_KEY, LINK_LIFETIME_S: "604801" });
    expect((await factsOf(overLong, "exec-1"))?.detailsUrl).toBeUndefined();
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
  it("[FD-PROV-042] links each of the execution's statements, its inclusion proof and its sha256 subjects from the recorded log-append intents", async () => {
    const db = await migratedD1();
    await seedExecution(db, "exec-1", "success");
    const app = "1".repeat(64);
    const lib = "2".repeat(64);
    seedStatement(db, {
      envelopeDigest: `sha256:${"a".repeat(64)}`,
      executionId: "exec-1",
      log: "private",
      subject: app,
      logged: { logIndex: 4, entryId: "leaf-hash-4" },
      insertedAt: 1,
    });
    seedStatement(db, {
      envelopeDigest: `sha256:${"b".repeat(64)}`,
      executionId: "exec-1",
      log: "rekor",
      subject: lib,
      insertedAt: 2,
    });
    // Another execution's statement is not this one's.
    seedStatement(db, {
      envelopeDigest: `sha256:${"c".repeat(64)}`,
      executionId: "exec-2",
      log: "private",
      subject: app,
      logged: { logIndex: 5, entryId: "leaf-hash-5" },
    });
    const facts = await factsOf(envOf(db, { PUBLIC_ORIGIN: ORIGIN, LINK_KEY }), "exec-1");
    expect(facts?.details.provenance).toEqual([
      {
        envelope_digest: `sha256:${"a".repeat(64)}`,
        status: "logged",
        statement_url: `${ORIGIN}/v1/provenance/executions/exec-1`,
        inclusion_proof_url: `${ORIGIN}/v1/provenance/log/proof/inclusion?leaf_index=4`,
        subjects: [
          { digest: `sha256:${app}`, url: `${ORIGIN}/v1/provenance/subjects/sha256:${app}` },
        ],
      },
      {
        envelope_digest: `sha256:${"b".repeat(64)}`,
        status: "log-pending",
        statement_url: `${ORIGIN}/v1/provenance/executions/exec-1`,
        inclusion_proof_url: null,
        subjects: [
          { digest: `sha256:${lib}`, url: `${ORIGIN}/v1/provenance/subjects/sha256:${lib}` },
        ],
      },
    ]);
    // An execution with no statement carries no provenance links.
    await seedExecution(db, "exec-3", "success");
    const none = await factsOf(envOf(db, { PUBLIC_ORIGIN: ORIGIN, LINK_KEY }), "exec-3");
    expect(none?.details).not.toHaveProperty("provenance");
  });

  it("[FD-PROV-042] a log-append store that cannot be read answers ConcludeFactsUnavailable, never a summary without the statements", async () => {
    const db = await migratedD1();
    await seedExecution(db, "exec-1", "success");
    // A view in the table's place: the store's schema and its read both fail.
    db.sqlite.exec("create view provenance_log_appends as select 1 as unrelated");
    const error = await Effect.runPromise(
      ConcludeFacts.use((f) => f.of("exec-1")).pipe(
        Effect.flip,
        Effect.provide(concludeFactsLayer(envOf(db, { PUBLIC_ORIGIN: ORIGIN, LINK_KEY }))),
      ),
    );
    expect(error).toBeInstanceOf(ConcludeFactsUnavailable);
  });
});
