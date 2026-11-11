// The trifecta rule at admission: intake computes an execution's three data classes from the trigger's facts, and an
// execution whose classes are all true concludes `failure` with `policy: trifecta` before placement. Signed webhooks
// through the route group, the fake GitHub reads and mameko's real admission transaction on SQLite.
import { FollowOnSubmitter } from "@fractalboxdev/flare-dispatch-github";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { followOnSubmitterLayer } from "./follow-on.ts";
import {
  CATALOG,
  checkSuiteRerequested,
  HEAD,
  harness,
  manifest,
  pullRequestPayload,
  REPO,
  repoWithManifest,
  signedWebhook,
  testRun,
  type Harness,
  type HarnessOptions,
} from "./harness.test-support.ts";
import { handleIntake } from "./routes.ts";
import { dataClassesOf, submission } from "./submit.ts";

/** `triage` reaches the Cloudflare API from its agent phase; `lint` keeps the agent profile's base grants. */
const TRIFECTA_CATALOG = {
  ...CATALOG,
  triage: testRun("triage", {
    grants: { setup: [], agent: ["cf-api"] },
    cooldown: { seconds: 300, scope: () => "all" },
  }),
};

const TRIFECTA_MANIFEST = manifest([
  { recipe: "triage", triggers: ["pull_request"] },
  { recipe: "lint", triggers: ["pull_request"] },
]);

const trifectaHarness = (settings: HarnessOptions["settings"] = {}) =>
  harness({
    settings: {
      catalog: (name) => TRIFECTA_CATALOG[name as keyof typeof TRIFECTA_CATALOG],
      ...settings,
    },
    repos: { [REPO]: repoWithManifest(TRIFECTA_MANIFEST) },
  });

/** A pull request webhook with the repository's visibility and the author's association set as given. */
const pullRequest = (
  options: { fork?: boolean; private?: boolean; association?: string; head?: string } = {},
) => {
  const p = pullRequestPayload({
    head: options.head ?? HEAD,
    ...(options.fork === true ? { headRepo: "mallory/app" } : {}),
  });
  return {
    ...p,
    repository: {
      ...p.repository,
      ...(options.private === undefined ? {} : { private: options.private }),
    },
    pull_request: {
      ...p.pull_request,
      ...(options.association === undefined ? {} : { author_association: options.association }),
    },
  };
};

const deliver = async (h: Harness, payload: unknown, delivery = "d-1", event = "pull_request") =>
  h.run(handleIntake(await signedWebhook(event, payload, { delivery }), "webhooks/github"));

/** Each execution of one run, by attempt: its status and reason, and whether it has a placement row. */
const attempts = (h: Harness, run: string) =>
  h
    .rows(
      `select r.attempt, e.status, e.reason,
         (select count(*) from placements p where p.execution_id = e.id) as placed
       from intake_records r join executions e on e.id = r.execution_id where r.run = ? order by r.attempt`,
      run,
    )
    .map((r) => ({
      attempt: r.attempt,
      status: r.status,
      reason: r.reason,
      placed: Number(r.placed) > 0,
    }));

/** Each run's execution: its status and reason, whether it has a placement row, and its record's hold. */
const outcomes = (h: Harness, sha = HEAD) =>
  Object.fromEntries(
    h
      .rows(
        `select r.run, e.status, e.reason, r.not_before,
           (select count(*) from placements p where p.execution_id = e.id) as placed
         from intake_records r join executions e on e.id = r.execution_id where r.sha = ?`,
        sha,
      )
      .map((r) => [
        r.run as string,
        {
          status: r.status,
          reason: r.reason,
          placed: Number(r.placed) > 0,
          held: r.not_before !== null,
        },
      ]),
  );

const refused = { status: "failure", reason: "policy: trifecta", placed: false, held: false };

describe("the trifecta rule at admission", () => {
  it("[FD-AGT-005] a fork pull request on a private repository concludes failure with policy: trifecta, before placement, for a run whose agent egress reaches another host", async () => {
    const h = await trifectaHarness();
    await deliver(h, pullRequest({ fork: true, private: true }));
    const byRun = outcomes(h);
    expect(byRun.triage).toEqual(refused);
    // `lint` keeps the agent profile's base grants, so it is not outbound and reaches placement.
    expect(byRun.lint).toMatchObject({
      status: "failure",
      reason: "placement: no eligible executor",
    });
    expect(h.recorded.started).toEqual([]);
    // No check.open row: the execution concluded before admission wrote the rows of its admitted kinds.
    expect(h.rows("select id from outbox")).toEqual([]);
  });

  it("[FD-AGT-005] text from a principal outside OWNER, MEMBER and COLLABORATOR makes the input untrusted on a same-repository pull request", async () => {
    const untrusted = await trifectaHarness();
    await deliver(untrusted, pullRequest({ association: "NONE" }));
    expect(outcomes(untrusted).triage).toEqual(refused);
    expect(untrusted.recorded.started).toEqual([]);

    const trusted = await trifectaHarness();
    await deliver(trusted, pullRequest({ association: "MEMBER" }));
    expect(outcomes(trusted).triage).toEqual({
      status: "pending",
      reason: null,
      placed: true,
      held: false,
    });
  });

  it("[FD-AGT-005] a public repository in non-confidential mode holds no private data, so a fork pull request is not refused for the trifecta", async () => {
    const open = await trifectaHarness({ confidentiality: () => "non-confidential" });
    await deliver(open, pullRequest({ fork: true, private: false }));
    expect(outcomes(open).triage?.reason).toBe("placement: no eligible executor");

    // A private repository, or one whose visibility the payload does not state, holds private data in any mode.
    for (const visibility of [true, undefined]) {
      const closed = await trifectaHarness({ confidentiality: () => "non-confidential" });
      await deliver(
        closed,
        pullRequest({ fork: true, ...(visibility === undefined ? {} : { private: visibility }) }),
      );
      expect(outcomes(closed).triage).toEqual(refused);
    }
  });

  it("[FD-AGT-005] a refused request concludes at once inside its run's cooldown window instead of being held", async () => {
    const h = await trifectaHarness();
    await deliver(h, pullRequest({ association: "MEMBER" }), "d-1");
    expect(outcomes(h).triage).toMatchObject({ status: "pending", held: false });

    const next = "e".repeat(40);
    await deliver(h, pullRequest({ association: "NONE", head: next }), "d-2");
    expect(outcomes(h, next).triage).toEqual(refused);
  });

  it("[FD-AGT-005] a rerequested check suite on a refused same-repository pull request concludes the next attempt failure with policy: trifecta again", async () => {
    const h = await trifectaHarness();
    await deliver(h, pullRequest({ association: "NONE" }));
    await deliver(h, checkSuiteRerequested(), "d-2", "check_suite");
    expect(attempts(h, "triage")).toEqual([
      { attempt: 1, status: "failure", reason: "policy: trifecta", placed: false },
      { attempt: 2, status: "failure", reason: "policy: trifecta", placed: false },
    ]);
    expect(h.recorded.started).toEqual([]);
  });

  it("[FD-AGT-005] a follow-on of an execution started by untrusted input keeps its parent's data classes", async () => {
    const h = await trifectaHarness();
    await deliver(h, pullRequest({ association: "NONE" }));
    const parent = h.rows("select execution_id from intake_records where run = 'lint'")[0]!
      .execution_id as string;
    const child = await h.run(
      FollowOnSubmitter.use((s) =>
        s.submit({
          executionId: parent,
          intentKey: "run:triage:0",
          run: "triage",
          label: null,
          inputs: { sha: HEAD },
        }),
      ).pipe(Effect.provide(followOnSubmitterLayer)),
    );
    expect(child).toMatchObject({ _tag: "admitted" });
    const id = (child as { executionId: string }).executionId;
    expect(
      h.rows(
        `select r.input_associations_json, e.status, e.reason from intake_records r
         join executions e on e.id = r.execution_id where r.execution_id = ?`,
        id,
      ),
    ).toEqual([
      { input_associations_json: '["NONE"]', status: "failure", reason: "policy: trifecta" },
    ]);
  });

  it("[FD-AGT-005] computes the classes from the submission: fork head, base and run agent grants, and the confidentiality mode", () => {
    const profile = buildProfile("production");
    const base = submission({
      run: CATALOG.lint!,
      trigger: "webhook",
      repo: REPO,
      sha: HEAD,
      ref: "refs/heads/feature",
      inputs: {},
    });
    expect(dataClassesOf(profile, base, "unclassified")).toEqual({
      privateData: true,
      untrustedInput: false,
      outbound: false,
    });
    expect(
      dataClassesOf(
        profile,
        { ...base, run: TRIFECTA_CATALOG.triage, trigger: "fork-pr" },
        "unclassified",
      ),
    ).toEqual({ privateData: true, untrustedInput: true, outbound: true });
    expect(
      dataClassesOf(profile, { ...base, repositoryPublic: true }, "non-confidential").privateData,
    ).toBe(false);
    expect(
      dataClassesOf(profile, { ...base, repositoryPublic: true }, "unclassified").privateData,
    ).toBe(true);
  });
});
