// A statement logged after its execution's check run concluded: the conclusion shows it `log-pending`, the append's
// success records a `cp:check:provenance:<digest>` row, and the drain renders the summary again with the statement's
// inclusion proof and subject links (FD-PROV-042).
import {
  applyLogAppend,
  d1LogAppendStore,
  LogAppendStore,
  SubjectRetention,
  TransparencyLogs,
} from "@fractalboxdev/flare-dispatch-cache";
import {
  ActuatorRateLimitLive,
  CheckRunApplierLive,
  insertProvenanceRefresh,
  installationQuotaLayer,
  PROVENANCE_REFRESH_KEY,
} from "@fractalboxdev/flare-dispatch-github";
import { fakeGithub, fakeGithubLayers } from "@fractalboxdev/flare-dispatch-github/testing";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { drainOnce, ExecutionSteps } from "@fractalboxdev/mameko-coordinator";
import { d1OutboxStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { concludeKindOf, executionConfig, type ControlPlaneEnv } from "../src/config.ts";
import { concludeFactsLayer, statementLoggedLayer } from "../src/github.ts";
import {
  envOf,
  LINK_KEY,
  ORIGIN,
  seedExecution,
  seedStatement,
  type TestD1,
} from "./conclude.test-support.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const SUBJECT = "1".repeat(64);
const PROOF_URL = `${ORIGIN}/v1/provenance/log/proof/inclusion?leaf_index=4`;

const succeed = (db: TestD1, executionId: string) =>
  Effect.runPromise(
    ExecutionSteps.use((steps) =>
      steps.applyOutbox(executionId, { _tag: "Success", epoch: 1 }, null),
    ).pipe(
      Effect.provide(
        d1ExecutionSteps(db, {
          ...executionConfig(buildProfile("production")),
          meteredCost: () => Effect.succeed(0),
        }),
      ),
    ),
  );

const drain = (env: ControlPlaneEnv, gh: ReturnType<typeof fakeGithub>, now: number) =>
  Effect.runPromise(
    drainOnce({
      now,
      token: (id) => `tok-${id}-${now}`,
      random: () => 0,
      actuatorOf: { "check.conclude": "checkRun" },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          d1OutboxStore(env.DB),
          CheckRunApplierLive.pipe(
            Layer.provide(Layer.merge(fakeGithubLayers(gh), concludeFactsLayer(env))),
          ),
          ActuatorRateLimitLive.pipe(
            Layer.provide(Layer.merge(installationQuotaLayer(), fakeGithubLayers(gh))),
          ),
        ),
      ),
    ),
  );

/**
 * The log-append drain's services: the D1 store, whose `get` this harness answers through `forExecution` since the
 * Node SQLite D1 has no `first`; the private log answering leaf 4; a retention that keeps nothing; and the control
 * plane's `StatementLogged`.
 */
const appendLayer = (env: ControlPlaneEnv) => {
  const store = d1LogAppendStore(env.DB as unknown as D1Database);
  return Layer.mergeAll(
    Layer.succeed(LogAppendStore, {
      ...store,
      get: (digest) =>
        Effect.map(
          store.forExecution("exec-1"),
          (intents) => intents.find((i) => i.envelopeDigest === digest) ?? null,
        ),
    }),
    Layer.succeed(TransparencyLogs, {
      rekor: () => Effect.die("the statement goes to the private log"),
      private: () =>
        Effect.succeed({
          log: "private" as const,
          logIndex: 4,
          entryId: "leaf-hash-4",
          integratedTime: 1_700_000_000_000,
        }),
    }),
    Layer.succeed(SubjectRetention, { retain: () => Effect.void }),
    statementLoggedLayer(env),
  );
};

const refreshRows = (db: TestD1) =>
  db.sqlite
    .prepare("select intent_key, kind, state from outbox where intent_key like ? order by id")
    .all(`${PROVENANCE_REFRESH_KEY}:%`);

describe("a statement logged after the conclusion", () => {
  it("[FD-PROV-042] the check run concludes with the statement log-pending, and the append's success renders the summary again with its inclusion proof and subject links", async () => {
    const db = await migratedD1();
    const env = envOf(db, { PUBLIC_ORIGIN: ORIGIN, LINK_KEY });
    await seedExecution(db, "exec-1");
    seedStatement(db, {
      envelopeDigest: DIGEST,
      executionId: "exec-1",
      log: "private",
      subject: SUBJECT,
    });
    const gh = fakeGithub();

    await succeed(db, "exec-1");
    const now = Date.now() + 1_000;
    await drain(env, gh, now);
    expect(gh.runs).toHaveLength(1);
    expect(gh.runs[0]).toMatchObject({ status: "completed", conclusion: "success" });
    expect(gh.runs[0]!.output.summary).toContain("log-pending");
    expect(gh.runs[0]!.output.summary).not.toContain(PROOF_URL);

    // The append succeeds after the conclusion was applied.
    await Effect.runPromise(
      applyLogAppend(DIGEST, now + 1_000).pipe(Effect.provide(appendLayer(env))),
    );
    expect(refreshRows(db)).toEqual([
      {
        intent_key: `${PROVENANCE_REFRESH_KEY}:${DIGEST}`,
        kind: "check.conclude",
        state: "pending",
      },
    ]);

    await drain(env, gh, now + 60_000);
    expect(gh.runs).toHaveLength(1);
    const summary = gh.runs[0]!.output.summary ?? "";
    expect(gh.runs[0]).toMatchObject({ status: "completed", conclusion: "success" });
    expect(summary).toContain(`[inclusion proof](${PROOF_URL})`);
    expect(summary).toContain(`(${ORIGIN}/v1/provenance/executions/exec-1)`);
    expect(summary).toContain(`(${ORIGIN}/v1/provenance/subjects/sha256:${SUBJECT})`);
    expect(summary).not.toContain("log-pending");
    expect(refreshRows(db)).toMatchObject([{ state: "applied" }]);

    // A second notice of the same statement, as a retried append sends, adds no row.
    const kind = concludeKindOf(buildProfile("production"));
    await Effect.runPromise(
      insertProvenanceRefresh(db, kind, { executionId: "exec-1", envelopeDigest: DIGEST }, now),
    );
    expect(refreshRows(db)).toHaveLength(1);
  });

  it("[FD-PROV-042] a statement logged before its execution concludes adds no row: the conclusion reads it logged", async () => {
    const db = await migratedD1();
    await seedExecution(db, "exec-1");
    const kind = concludeKindOf(buildProfile("production"));
    const inserted = await Effect.runPromise(
      insertProvenanceRefresh(
        db,
        kind,
        { executionId: "exec-1", envelopeDigest: DIGEST },
        Date.now(),
      ),
    );
    expect(inserted).toBe(false);
    expect(refreshRows(db)).toEqual([]);
  });
});
