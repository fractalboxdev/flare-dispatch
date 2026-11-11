// FlareDispatch's `supersessionKey` binding through mameko's admission on host-cloudflare's D1 under workerd: intake
// submits each request with the key the binding returns, and admission's supersession (MAMEKO-ADM-061, MAMEKO-ADM-062)
// acts on that key alone.
import {
  catalogRuns,
  d1Admission,
  d1IntakeStore,
  d1ShedRecorder,
  IntakeConfig,
  migrateIntake,
  submission,
  submit,
  type IntakeSettings,
  type Submission,
} from "@fractalboxdev/flare-dispatch-intake";
import { recordingResolver } from "@fractalboxdev/flare-dispatch-intake/testing";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { runD1Migrations, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = "acme/app";
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const catalog = catalogRuns("development");

let mf: Miniflare;
beforeAll(() => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    compatibilityDate: "2026-05-01",
    d1Databases: ["DB0", "DB1"],
  });
}, 60_000);
afterAll(() => mf?.dispose());

let planes = 0;
const plane = async () => {
  const db = (await mf.getD1Database(`DB${planes++}`)) as unknown as D1Like;
  await runD1Migrations(db);
  await Effect.runPromise(migrateIntake(db));
  const profile = buildProfile("development");
  const settings: IntakeSettings = {
    catalog,
    profile,
    appId: 1,
    webhookSecret: undefined,
    webhookEvents: undefined,
    writeCredentialIn: () => null,
    allows: () => true,
    confidentiality: () => "unclassified",
  };
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(IntakeConfig, settings),
      d1Admission(db, profile),
      d1IntakeStore(db),
      d1ShedRecorder(db),
      // Every request resolves to `interactive`, whose terminal outcome is not `deferred`, so no coalescing of a
      // (run, scope) queue (MAMEKO-ADM-041) acts beside supersession.
      recordingResolver([], () => ({
        _tag: "Class",
        class: "interactive",
        labels: [],
        alarm: null,
      })),
    ).pipe(Layer.provideMerge(TestClock.layer())),
  );
  await runtime.runPromise(TestClock.setTime(NOW));
  /** Submits one request a second after the previous one, so admission orders the members by `enqueued_at`. */
  const send = async (s: Submission) => {
    await runtime.runPromise(TestClock.adjust(1_000));
    return (await runtime.runPromise(submit(s))).executionId;
  };
  const row = async (id: string) =>
    (
      await db
        .prepare("select status, reason, supersession_key as key from executions where id = ?")
        .bind(id)
        .all()
    ).results[0] as { status: string; reason: string | null; key: string | null } | undefined;
  return { send, row, dispose: () => runtime.dispose() };
};

let n = 0;
/** A request of `run` at a fresh commit, from a pull request's `pull_request` webhook unless `fields` says otherwise. */
const request = (run: string, fields: Partial<Submission> = {}) =>
  submission({
    run: catalog(run)!,
    trigger: "webhook",
    event: "pull_request",
    repo: REPO,
    sha: String(++n).padStart(40, "0"),
    ref: "refs/pull/7/head",
    inputs: {},
    cacheTrigger: { _tag: "PullRequest", number: 7 },
    ...fields,
  });

describe("the supersessionKey binding through mameko's admission on D1", () => {
  it("[FD-PROF-027] a pull-request request of a superseding run joins <owner>/<repo>:<number>:<run>[:<label>], and every other request joins none", async () => {
    const p = await plane();
    try {
      const keyOf = async (s: Submission) => (await p.row(await p.send(s)))!.key;
      expect(await keyOf(request("check"))).toBe(`${REPO}:7:check`);
      expect(await keyOf(request("oxlint", { label: "web" }))).toBe(`${REPO}:7:oxlint:web`);
      expect(await keyOf(request("offload-test"))).toBe(`${REPO}:7:offload-test`);
      expect(await keyOf(request("pr-review"))).toBe(`${REPO}:7:pr-review`);
      // A run that does not declare `supersede`, and a request from no pull request, join no group.
      expect(await keyOf(request("improve-pr"))).toBeNull();
      expect(
        await keyOf(
          request("check", {
            event: "push",
            ref: "refs/heads/main",
            cacheTrigger: { _tag: "Push", ref: "refs/heads/main", protected: true },
          }),
        ),
      ).toBeNull();
      expect(
        await keyOf(
          request("check", { event: "merge_group", cacheTrigger: { _tag: "MergeGroup" } }),
        ),
      ).toBeNull();
      expect(await keyOf(request("check", { trigger: "cron", event: null }))).toBeNull();
    } finally {
      await p.dispose();
    }
  }, 60_000);

  it("[FD-PROF-027] admission supersedes by the key alone: a newer member cancels the older one of its group and no other", async () => {
    const p = await plane();
    try {
      const older = await p.send(request("check", { label: "unit" }));
      const sibling = await p.send(request("check", { label: "e2e" }));
      const otherPr = await p.send(
        request("check", { label: "unit", cacheTrigger: { _tag: "PullRequest", number: 8 } }),
      );
      const newer = await p.send(request("check", { label: "unit" }));
      expect(await p.row(older)).toEqual({
        status: "cancelled",
        reason: "superseded",
        key: `${REPO}:7:check:unit`,
      });
      for (const id of [sibling, otherPr, newer]) expect((await p.row(id))!.status).toBe("pending");
    } finally {
      await p.dispose();
    }
  }, 60_000);
});
