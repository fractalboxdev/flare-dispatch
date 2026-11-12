// The webhook route end to end: signed fixtures through the route group, the fake GitHub reads and mameko's real
// admission transaction on SQLite.
import { GithubHttpError } from "@fractalboxdev/flare-dispatch-github";
import { fakeRepo } from "@fractalboxdev/flare-dispatch-github/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { catalogRuns } from "./catalog.ts";
import {
  admit,
  APP_ID,
  authenticated,
  BASE,
  bodyOf,
  drainHeldChecks,
  checkRunRerequested,
  checkSuiteRerequested,
  harness,
  HEAD,
  manifest,
  NOW,
  mergeGroupPayload,
  pullRequestPayload,
  pushPayload,
  REPO,
  repoWithManifest,
  signedWebhook,
  testRun,
  type Harness,
} from "./harness.test-support.ts";
import { cacheTriggerOf } from "./event.ts";
import { handleIntake } from "./routes.ts";
import { HELD_STATUS, IntakeStore, pullRequestClosedAt } from "./store.ts";
import { releaseHeld } from "./submit.ts";

const post = (h: Harness, request: Request) => h.run(handleIntake(request, "webhooks/github"));
const deliver = async (h: Harness, event: string, payload: unknown, delivery = "d-1") =>
  post(h, await signedWebhook(event, payload, { delivery }));

describe("webhook authentication", () => {
  it("[FD-INT-022] with no webhook secret every webhook answers 503 webhook_unconfigured and submits nothing", async () => {
    const h = await harness({ settings: { webhookSecret: undefined } });
    const r = await deliver(h, "pull_request", pullRequestPayload());
    expect(r!.status).toBe(503);
    expect((await bodyOf(r)).error).toBe("webhook_unconfigured");
    expect(h.executions()).toEqual([]);
  });

  it("[FD-INT-023] a body over 25 MiB answers 413 before it is verified", async () => {
    const h = await harness();
    const r = await post(
      h,
      new Request("https://cp.example.com/v1/webhooks/github", {
        method: "POST",
        headers: {
          "content-length": String(25 * 1024 * 1024 + 1),
          "x-hub-signature-256": "sha256=00",
        },
        body: "{}",
      }),
    );
    expect(r!.status).toBe(413);
    expect((await bodyOf(r)).error).toBe("payload_too_large");
  });

  it("[FD-INT-024] [FD-INT-025] a missing or mismatched signature answers 401 and submits nothing", async () => {
    const h = await harness();
    const missing = await post(h, await signedWebhook("push", pushPayload(), { signature: null }));
    const wrong = await post(h, await signedWebhook("push", pushPayload(), { secret: "other" }));
    const tampered = await post(h, await signedWebhook("push", pushPayload(), { tamper: true }));
    expect([missing!.status, wrong!.status, tampered!.status]).toEqual([401, 401, 401]);
    expect(h.executions()).toEqual([]);
    expect(h.reads.calls).toEqual([]);
  });

  it("[FD-INT-026] a signed webhook without X-GitHub-Delivery answers 400", async () => {
    const h = await harness();
    const r = await post(h, await signedWebhook("push", pushPayload(), { delivery: null }));
    expect(r!.status).toBe(400);
    expect(h.executions()).toEqual([]);
  });

  it("[FD-INT-027] an event outside intake.webhookEvents is ignored after the signature check; an empty list admits none", async () => {
    const h = await harness({ settings: { webhookEvents: ["push"] } });
    const r = await deliver(h, "pull_request", pullRequestPayload());
    expect(r!.status).toBe(202);
    expect(await bodyOf(r)).toEqual({ ignored: true, reason: "event_not_allowed" });
    const none = await harness({ settings: { webhookEvents: [] } });
    expect(await bodyOf(await deliver(none, "push", pushPayload()))).toEqual({
      ignored: true,
      reason: "event_not_allowed",
    });
    expect([...h.executions(), ...none.executions()]).toEqual([]);
    const unsigned = await post(
      h,
      await signedWebhook("pull_request", pullRequestPayload(), { secret: "x" }),
    );
    expect(unsigned!.status).toBe(401);
  });

  it("[FD-INT-031] a verified delivery records its time per installation", async () => {
    const h = await harness();
    await deliver(h, "push", pushPayload());
    expect(h.rows("select installation, verified_at from intake_deliveries")).toEqual([
      { installation: 7, verified_at: Date.UTC(2026, 10, 4, 12, 0, 0) },
    ]);
  });
});

describe("webhook to admission", () => {
  it("[FD-INT-001] [FD-INT-009] a pull request submits each listed run through admission, keyed by commit without the trigger", async () => {
    const h = await harness();
    const r = await deliver(h, "pull_request", pullRequestPayload());
    expect(r!.status).toBe(202);
    const body = await bodyOf(r);
    expect(body.executions).toHaveLength(2);
    expect(h.executions().map((e) => [e.run, e.status])).toEqual([
      ["check", "pending"],
      ["lint", "pending"],
    ]);
    expect(
      h.rows("select canonical from dedup_keys order by canonical").map((r) => r.canonical),
    ).toEqual([`check:ci:${REPO}:${HEAD}`, `lint:${REPO}:${HEAD}`]);
    expect(h.rows("select count(*) as n from placements")[0]!.n).toBe(2);
  });

  it("[FD-GATE-020] a labelled check entry reports under flare-dispatch/check:<label>, an unlabelled entry under flare-dispatch/<run>", async () => {
    const h = await harness({
      repos: {
        [REPO]: repoWithManifest(
          manifest([
            { recipe: "check", label: "ci", triggers: ["pull_request"] },
            { recipe: "lint", triggers: ["pull_request"] },
          ]),
        ),
      },
    });
    await deliver(h, "pull_request", pullRequestPayload());
    expect(h.recorded.resolved.map((r) => [r.run.name, r.checkName])).toEqual([
      ["check", "flare-dispatch/check:ci"],
      ["lint", "flare-dispatch/lint"],
    ]);
  });

  it("[FD-INT-003] a redelivery answers 202 with the same executions and duplicate: true", async () => {
    const h = await harness();
    const first = await bodyOf(await deliver(h, "pull_request", pullRequestPayload(), "d-1"));
    const again = await bodyOf(await deliver(h, "pull_request", pullRequestPayload(), "d-2"));
    expect(again).toEqual({ executions: first.executions, duplicate: true });
    expect(h.executions()).toHaveLength(2);
    expect(h.records()).toHaveLength(2);
  });

  it("[FD-INT-009] a push and a pull request for one run on one commit resolve to one execution", async () => {
    const h = await harness({
      repos: {
        [REPO]: repoWithManifest(
          manifest([{ recipe: "check", label: "ci", triggers: ["pull_request", "push"] }]),
        ),
      },
    });
    await deliver(h, "push", pushPayload("refs/heads/feature"));
    const pr = await bodyOf(await deliver(h, "pull_request", pullRequestPayload(), "d-2"));
    expect(pr.duplicate).toBe(true);
    expect(h.executions()).toHaveLength(1);
  });

  it("[FD-INT-015] a run the manifest does not list for the trigger, or the operator policy refuses, is not submitted", async () => {
    const h = await harness({ settings: { allows: (_, run) => run !== "lint" } });
    await deliver(h, "pull_request", pullRequestPayload());
    expect(h.executions().map((e) => e.run)).toEqual(["check"]);
    const push = await harness();
    await deliver(push, "push", pushPayload("refs/heads/feature"));
    expect(push.executions().map((e) => e.run)).toEqual(["check"]);
  });

  it("[FD-INT-016] the manifest is read at the base branch head for a pull request and at the pushed commit on the default branch", async () => {
    const h = await harness();
    await deliver(h, "pull_request", pullRequestPayload());
    expect(h.reads.calls).toContain(`branchHead ${REPO}`);
    const files = () => h.reads.calls.filter((c) => c.startsWith("file"));
    expect(files()).toHaveLength(1);
    const pushed = await harness({
      repos: {
        [REPO]: repoWithManifest(undefined, {
          files: {
            [`${HEAD}:.github/flare-dispatch.json`]: manifest([
              { recipe: "check", triggers: ["push"] },
            ]),
          },
        }),
      },
    });
    const r = await bodyOf(await deliver(pushed, "push", pushPayload("refs/heads/main", HEAD)));
    expect(r.executions).toHaveLength(1);
    expect(pushed.reads.calls).not.toContain(`branchHead ${REPO}`);
  });

  it("[FD-INT-017] [FD-INT-018] a manifest over 50 runs is invalid: nothing is submitted, a shed row and the manifest check run record it", async () => {
    const many = Array.from({ length: 51 }, () => ({ recipe: "lint", triggers: ["pull_request"] }));
    const h = await harness({ repos: { [REPO]: repoWithManifest(manifest(many)) } });
    const r = await deliver(h, "pull_request", pullRequestPayload());
    expect(r!.status).toBe(202);
    expect(h.executions()).toEqual([]);
    expect(h.sheds()).toEqual([{ scope_id: REPO, run: null, reason: "manifest: invalid" }]);
    expect(h.recorded.reported).toEqual([
      { repo: REPO, sha: BASE, errors: [expect.stringContaining("51 runs")] },
    ]);
  });

  it("[FD-INT-018] an entry whose parameters fail its recipe's schema makes the whole manifest invalid", async () => {
    const text = manifest([
      { recipe: "check", triggers: ["pull_request"], params: { steps: "not a list" } },
      { recipe: "lint", triggers: ["pull_request"] },
      { recipe: "missing", triggers: ["pull_request"] },
    ]);
    const h = await harness({ repos: { [REPO]: repoWithManifest(text) } });
    await deliver(h, "pull_request", pullRequestPayload());
    expect(h.executions()).toEqual([]);
    const errors = h.recorded.reported[0]!.errors;
    expect(errors.some((e) => e.startsWith("runs[0].params"))).toBe(true);
    expect(errors).toContain("runs[2].recipe: no recipe named missing");
  });

  it("[FD-INT-019] a manifest read that fails with a 5xx submits nothing and sheds manifest: unreadable", async () => {
    const h = await harness();
    h.reads.failures.set(
      `file ${REPO}`,
      new GithubHttpError({ status: 502, message: "bad gateway", rateLimited: false }),
    );
    await deliver(h, "pull_request", pullRequestPayload());
    expect(h.executions()).toEqual([]);
    expect(h.sheds()).toEqual([{ scope_id: REPO, run: null, reason: "manifest: unreadable" }]);
  });

  it("[FD-INT-020] a repository with no manifest submits nothing and sheds nothing", async () => {
    const h = await harness({ repos: { [REPO]: repoWithManifest(undefined, { files: {} }) } });
    const r = await bodyOf(await deliver(h, "pull_request", pullRequestPayload()));
    expect(r.executions).toEqual([]);
    expect(h.sheds()).toEqual([]);
  });

  it("[FD-INT-021] a decoded manifest is cached per (repository, commit) for at most 10 min", async () => {
    const h = await harness();
    const files = () => h.reads.calls.filter((c) => c.startsWith("file")).length;
    await deliver(h, "pull_request", pullRequestPayload({ head: "1".repeat(40) }));
    await deliver(h, "pull_request", pullRequestPayload({ head: "2".repeat(40) }), "d-2");
    expect(files()).toBe(1);
    await h.adjust(10 * 60_000);
    await deliver(h, "pull_request", pullRequestPayload({ head: "3".repeat(40) }), "d-3");
    expect(files()).toBe(2);
  });

  it("[FD-INT-028] the commit is the first present field: pull_request.head.sha over check_run.head_sha", async () => {
    const h = await harness();
    await deliver(h, "pull_request", {
      ...pullRequestPayload(),
      check_run: { id: 1, head_sha: "e".repeat(40) },
    });
    expect(h.records().every((r) => r.sha === HEAD)).toBe(true);
  });

  it("[FD-INT-029] an event with no commit field submits nothing and sheds intake: no commit", async () => {
    const h = await harness();
    const r = await deliver(h, "deployment_status", {
      action: "created",
      repository: { full_name: REPO },
    });
    expect(await bodyOf(r)).toEqual({ ignored: true, reason: "no_commit" });
    expect(h.sheds()).toEqual([{ scope_id: REPO, run: null, reason: "intake: no commit" }]);
  });

  it("[FD-INT-030] a pull request from a fork is recorded as fork-pr and class resolution returns untrusted-input", async () => {
    const h = await harness();
    await deliver(h, "pull_request", pullRequestPayload({ headRepo: "mallory/app" }));
    expect(h.recorded.resolved.every((r) => r.trigger === "fork-pr")).toBe(true);
    expect(h.records().map((r) => [r.trigger, r.labels_json])).toEqual([
      ["fork-pr", '["untrusted-input"]'],
      ["fork-pr", '["untrusted-input"]'],
    ]);
  });

  it("[FD-CACHE-019] [FD-CACHE-017] each record carries the trigger the cache namespaces read: a pull request's number, a push and whether it is to the default branch", async () => {
    const h = await harness();
    await deliver(h, "pull_request", pullRequestPayload({ number: 41 }));
    // One commit deduplicates across triggers, so the push goes to its own deployment.
    const push = await harness();
    await deliver(push, "push", pushPayload("refs/heads/feature"));
    expect(new Set(h.records().map((r) => r.cache_trigger_json))).toEqual(
      new Set([JSON.stringify({ _tag: "PullRequest", number: 41 })]),
    );
    expect(new Set(push.records().map((r) => r.cache_trigger_json))).toEqual(
      new Set([JSON.stringify({ _tag: "Push", ref: "refs/heads/feature", protected: false })]),
    );
    expect(cacheTriggerOf("push", { ref: "refs/heads/main" }, "main", false)).toEqual({
      _tag: "Push",
      ref: "refs/heads/main",
      protected: true,
    });
    expect(cacheTriggerOf("push", { ref: "refs/heads/feature" }, "main", false)).toEqual({
      _tag: "Push",
      ref: "refs/heads/feature",
      protected: false,
    });
    expect(cacheTriggerOf("merge_group", {}, "main", false)).toEqual({ _tag: "MergeGroup" });
    expect(cacheTriggerOf("check_suite", {}, "main", false)).toEqual({ _tag: "Other" });
  });

  it("[FD-INT-004] when admission fails the webhook answers 503 intake_unavailable and keeps no record", async () => {
    const h = await harness();
    h.db.sqlite.exec("drop table placements");
    const r = await deliver(h, "pull_request", pullRequestPayload());
    expect(r!.status).toBe(503);
    expect((await bodyOf(r)).error).toBe("intake_unavailable");
    expect(h.records()).toEqual([]);
  });
});

describe("installation events", () => {
  it("[FD-GH-066] an installation deleted, suspended or repositories-removed webhook evicts before it answers", async () => {
    const h = await harness();
    await deliver(h, "installation", { action: "deleted", installation: { id: 7 } });
    await deliver(h, "installation", { action: "suspend", installation: { id: 8 } }, "d-2");
    await deliver(h, "installation", { action: "created", installation: { id: 9 } }, "d-3");
    await deliver(
      h,
      "installation_repositories",
      {
        action: "removed",
        installation: { id: 7 },
        repositories_removed: [{ full_name: "acme/old" }],
      },
      "d-4",
    );
    expect(h.recorded.evicted).toEqual(["installation 7", "installation 8", "repo acme/old"]);
  });
});

describe("merge queue", () => {
  it("[FD-GH-075] checks_requested opens the base branch's required gating runs on the group's head", async () => {
    const h = await harness({
      repos: {
        [REPO]: repoWithManifest(undefined, { required: { main: ["flare-dispatch/check:ci"] } }),
      },
    });
    const r = await bodyOf(await deliver(h, "merge_group", mergeGroupPayload("checks_requested")));
    expect(r.executions).toHaveLength(1);
    expect(h.records().map((x) => [x.run, x.label, x.sha])).toEqual([["check", "ci", HEAD]]);
  });

  it("[FD-GH-075] admission inserts the check.open row of each required gating run on merge_group.head_sha", async () => {
    const group = "f".repeat(40);
    const h = await harness({
      repos: {
        [REPO]: repoWithManifest(undefined, { required: { main: ["flare-dispatch/check:ci"] } }),
      },
    });
    const r = await bodyOf(
      await deliver(h, "merge_group", mergeGroupPayload("checks_requested", group)),
    );
    const [executionId] = r.executions as string[];
    expect(
      h
        .rows("select kind, payload_json from outbox where execution_id = ?", executionId)
        .map((row) => ({ kind: row["kind"], payload: JSON.parse(row["payload_json"] as string) })),
    ).toEqual([
      { kind: "check.open", payload: { name: "flare-dispatch/check:ci", head_sha: group } },
    ]);
  });

  it("[FD-GH-075] a gating run whose check is not required opens nothing", async () => {
    const h = await harness();
    await deliver(h, "merge_group", mergeGroupPayload("checks_requested"));
    expect(h.executions()).toEqual([]);
  });

  it("[FD-GH-076] destroyed cancels every non-terminal execution on the group's head with merge-group-destroyed", async () => {
    const h = await harness({
      repos: {
        [REPO]: repoWithManifest(undefined, { required: { main: ["flare-dispatch/check:ci"] } }),
      },
    });
    const opened = await bodyOf(
      await deliver(h, "merge_group", mergeGroupPayload("checks_requested")),
    );
    const [executionId] = opened.executions as string[];
    const destroyed = await deliver(h, "merge_group", mergeGroupPayload("destroyed"), "d-2");
    expect(destroyed!.status).toBe(202);
    expect(h.rows("select status, reason from executions where id = ?", executionId)).toEqual([
      { status: "cancelled", reason: "merge-group-destroyed" },
    ]);
    // The execution's workflow and lease are cancelled with the declared cause.
    expect(h.recorded.workflowCancels).toEqual([{ executionId, cause: "merge-group-destroyed" }]);
    // The cancel writes the outcome row its check run concludes from.
    expect(
      h.rows("select kind from outbox where execution_id = ? order by kind", executionId),
    ).toEqual([{ kind: "check.conclude" }, { kind: "check.open" }]);
  });
});

/** Marks the execution of every record with the given status, as mameko's terminal write does. */
const settle = (h: Harness, status: string) =>
  h.db.sqlite.exec(`update executions set status = '${status}'`);

describe("check re-runs", () => {
  const firstRun = async () => {
    const h = await harness({
      repos: {
        [REPO]: repoWithManifest(
          manifest([{ recipe: "check", label: "ci", triggers: ["pull_request"] }]),
        ),
      },
    });
    const opened = await bodyOf(await deliver(h, "pull_request", pullRequestPayload()));
    return { h, id: (opened.executions as string[])[0]! };
  };

  it("[FD-INT-054] a rerequested check run submits attempt n + 1 with the attempt key suffix, the same name and class, and no cooldown", async () => {
    const { h, id } = await firstRun();
    settle(h, "failure");
    const r = await bodyOf(await deliver(h, "check_run", checkRunRerequested(id), "d-2"));
    expect(r.executions).toHaveLength(1);
    const [first, second] = h.records();
    expect(second).toMatchObject({
      run: "check",
      label: "ci",
      attempt: 2,
      family_root: id,
      class: first!.class,
    });
    expect(
      h.rows("select canonical from dedup_keys order by canonical").map((x) => x.canonical),
    ).toContain(`check:ci:${REPO}:${HEAD}:attempt-2`);
    expect(h.recorded.resolved).toHaveLength(1);
  });

  it("FD-INT-054 a re-run keeps the labels and the placement constraint of the attempt it re-runs", async () => {
    const h = await harness({
      repos: {
        [REPO]: repoWithManifest(manifest([{ recipe: "check", label: "ci", triggers: ["pull_request"] }])),
      },
      resolve: () => ({ _tag: "Class", class: "batch", labels: ["gpu"], alarm: null }),
    });
    const opened = await bodyOf(await deliver(h, "pull_request", pullRequestPayload()));
    const id = (opened.executions as string[])[0]!;
    settle(h, "failure");
    h.db.sqlite.exec(`update intake_records set placement_constraint = 'pinned-pool'`);
    await deliver(h, "check_run", checkRunRerequested(id), "d-2");
    const [first, second] = h.records();
    expect(JSON.parse(first!.labels_json as string)).toContain("gpu");
    expect(second!.labels_json).toBe(first!.labels_json);
    expect(second!.placement_constraint).toBe("pinned-pool");
  });

  it("[FD-INT-056] a rerequested check suite skips a local family, which posted no check run", async () => {
    const { h, id } = await firstRun();
    settle(h, "failure");
    h.db.sqlite.exec(`update intake_records set trigger = 'local', placement_constraint = 'local-only'`);
    const r = await bodyOf(await deliver(h, "check_suite", checkSuiteRerequested(), "d-2"));
    expect(r.executions).toEqual([]);
    expect(h.records().map((x) => x.family_root)).toEqual([id]);
  });

  it.each([
    ["foreign_app", (id: string) => checkRunRerequested(id, 1)],
    ["unknown_check_run", () => checkRunRerequested("no-such-execution")],
  ])(
    "FD-INT-055 a re-run naming %s submits nothing and sheds that reason",
    async (reason, payload) => {
      const { h, id } = await firstRun();
      settle(h, "failure");
      await deliver(h, "check_run", payload(id), "d-2");
      expect(h.records()).toHaveLength(1);
      expect(h.sheds().map((s) => s.reason)).toEqual([reason]);
    },
  );

  it("[FD-INT-055] a family with a non-terminal attempt sheds in_progress", async () => {
    const { h, id } = await firstRun();
    await deliver(h, "check_run", checkRunRerequested(id), "d-2");
    expect(h.sheds().map((s) => s.reason)).toEqual(["in_progress"]);
  });

  it("[FD-INT-055] a family with 5 attempts sheds attempts_exhausted", async () => {
    const { h, id } = await firstRun();
    for (let n = 2; n <= 5; n++) {
      settle(h, "failure");
      await deliver(h, "check_run", checkRunRerequested(id), `d-${n}`);
    }
    settle(h, "failure");
    await deliver(h, "check_run", checkRunRerequested(id), "d-6");
    expect(h.records().map((r) => r.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(h.sheds().map((s) => s.reason)).toEqual(["attempts_exhausted"]);
  });

  it("[FD-INT-055] an unregistered run sheds run_not_registered and undecodable inputs shed inputs_unreplayable", async () => {
    const { h, id } = await firstRun();
    settle(h, "failure");
    h.db.sqlite.exec(`update intake_records set inputs_json = '{"steps": 3}'`);
    await deliver(h, "check_run", checkRunRerequested(id), "d-2");
    h.db.sqlite.exec(`update intake_records set run = 'retired'`);
    await deliver(h, "check_run", checkRunRerequested(id), "d-3");
    expect(h.sheds().map((s) => s.reason)).toEqual(["inputs_unreplayable", "run_not_registered"]);
  });

  it("[FD-INT-056] a rerequested check suite re-runs every family whose latest attempt did not succeed", async () => {
    const { h } = await firstRun();
    const lint = await harness();
    await deliver(lint, "pull_request", pullRequestPayload());
    const [check, lintRow] = lint.executions();
    lint.db.sqlite.exec(`update executions set status = 'success' where id = '${check!.id}'`);
    lint.db.sqlite.exec(`update executions set status = 'failure' where id = '${lintRow!.id}'`);
    const r = await bodyOf(await deliver(lint, "check_suite", checkSuiteRerequested(), "d-2"));
    expect(r.executions).toHaveLength(1);
    expect(
      lint
        .records()
        .filter((x) => x.attempt === 2)
        .map((x) => x.run),
    ).toEqual(["lint"]);
    expect(h.records()).toHaveLength(1);
  });

  it("[FD-SPD-032] an attempt beyond the family's retry allowance admits against the interactive line", async () => {
    const { h, id } = await firstRun();
    settle(h, "failure");
    h.db.sqlite.exec(
      `insert into reservations (execution_id, class, hold_micro_usd, state, metered_micro_usd, updated_at)
       values ('${id}', 'interactive', 100, 'settled', 100, 0)`,
    );
    await deliver(h, "check_run", checkRunRerequested(id), "d-2");
    const second = h.records()[1]!;
    expect(second.spend_line).toBeNull();
    h.db.sqlite.exec(
      `insert into reservations (execution_id, class, hold_micro_usd, state, metered_micro_usd, updated_at)
       values ('${second.execution_id as string}', 'interactive', 100, 'settled', 100, 0)`,
    );
    settle(h, "failure");
    await deliver(h, "check_run", checkRunRerequested(id), "d-3");
    expect(h.records()[2]).toMatchObject({ attempt: 3, spend_line: "interactive" });
  });
});

describe("cooldown", () => {
  it("[FD-INT-057] [FD-INT-058] an execution within a run's window waits until the window ends; the window clamps to 60 s", async () => {
    const h = await harness();
    await deliver(h, "pull_request", pullRequestPayload({ head: "1".repeat(40) }));
    await h.adjust(10_000);
    await deliver(h, "pull_request", pullRequestPayload({ head: "2".repeat(40) }), "d-2");
    const lint = h.records().filter((r) => r.run === "lint");
    // `lint` declares 30 s, which clamps to 60 s from the first execution.
    expect(lint.map((r) => r.not_before)).toEqual([null, Date.UTC(2026, 10, 4, 12, 1, 0)]);
    expect(
      h
        .records()
        .filter((r) => r.run === "check")
        .every((r) => r.not_before === null),
    ).toBe(true);
  });

  it("[FD-INT-057] a request inside its window is held from admission until the window ends; the tick then admits it and arms the next window", async () => {
    const h = await harness();
    const windowEnd = Date.UTC(2026, 10, 4, 12, 1, 0);
    await deliver(h, "pull_request", pullRequestPayload({ head: "1".repeat(40) }));
    await h.adjust(10_000);
    await deliver(h, "pull_request", pullRequestPayload({ head: "2".repeat(40) }), "d-2");
    const [first, held] = h.records().filter((r) => r.run === "lint");
    const id = held!.execution_id as string;
    expect(h.executions().map((e) => e.id)).not.toContain(id);
    expect((await h.run(IntakeStore.use((s) => s.get(id))))?.status).toBe(HELD_STATUS);

    expect(await h.run(releaseHeld())).toMatchObject({ admitted: 0 });
    await h.adjust(50_000);
    // The first `lint` has finished, so the class's per-repository queue bound has room.
    h.db.sqlite
      .prepare("update executions set status = 'success' where id = ?")
      .run(first!.execution_id as string);
    expect(await h.run(releaseHeld())).toEqual({
      admitted: 1,
      concluded: 0,
      duplicate: 0,
      unavailable: 0,
      more: false,
    });
    expect(h.executions().find((e) => e.id === id)?.status).toBe("pending");
    expect(h.rows("select count(*) as n from intake_held")[0]!.n).toBe(0);
    expect(
      h.rows("select armed_at from intake_cooldowns where execution_id = ?", id)[0]!.armed_at,
    ).toBe(windowEnd);
    // The record carries the eligible kinds admission wrote on the placement row at release, and admission counts the
    // deadline it writes on the execution and placement rows from the release, as it counted the first execution's from
    // its admission.
    const placed = h.rows(
      "select p.eligible_kinds, p.deadline_at as p_deadline, e.deadline_at as e_deadline, e.enqueued_at from placements p join executions e on e.id = p.execution_id where p.execution_id = ?",
      id,
    )[0]!;
    const firstRow = h.rows(
      "select deadline_at, enqueued_at from executions where id = ?",
      first!.execution_id as string,
    )[0]!;
    expect(held!.eligible_kinds).toBeNull();
    expect(
      h.rows("select eligible_kinds from intake_records where execution_id = ?", id)[0]!
        .eligible_kinds,
    ).toBe(placed.eligible_kinds);
    expect(placed.e_deadline).toBe(placed.p_deadline);
    expect(placed.enqueued_at as number).toBeGreaterThanOrEqual(windowEnd);
    expect((placed.e_deadline as number) - (placed.enqueued_at as number)).toBe(
      (firstRow.deadline_at as number) - (firstRow.enqueued_at as number),
    );
  });

  it("[FD-INT-057] a held request's check run is queued for the window under the id the execution is admitted with", async () => {
    const h = await harness();
    await deliver(h, "pull_request", pullRequestPayload({ head: "1".repeat(40) }));
    await h.adjust(10_000);
    await deliver(h, "pull_request", pullRequestPayload({ head: "2".repeat(40) }), "d-2");
    const [, held] = h.records().filter((r) => r.run === "lint");
    const id = held!.execution_id as string;
    // Holding stages a row and sends no GitHub write; the drainer opens it under its permit.
    expect(h.github.calls).toEqual([]);
    expect(h.rows("select kind, state, sends from outbox where execution_id = ?", id)).toEqual([
      { kind: "check.open", state: "pending", sends: 0 },
    ]);
    await drainHeldChecks(h);
    const heldRuns = () => h.github.runs.filter((r) => r.external_id === id);
    expect(heldRuns()).toEqual([
      expect.objectContaining({ name: "flare-dispatch/lint", external_id: id, status: "queued" }),
    ]);

    await h.adjust(20_000);
    expect(await h.run(releaseHeld())).toMatchObject({ admitted: 0 });
    expect(heldRuns()).toEqual([expect.objectContaining({ external_id: id, status: "queued" })]);

    await h.adjust(30_000);
    expect(await h.run(releaseHeld())).toMatchObject({ admitted: 1 });
    // Admission opens the check run under the same id, so the `check.open` applier finds this one and adopts it.
    expect(h.executions().find((e) => e.id === id)?.status).toBe("pending");
    expect(
      h.rows("select kind, payload_json from outbox where execution_id = ?", id).map((r) => ({
        kind: r.kind,
        payload: JSON.parse(r.payload_json as string),
      })),
    ).toEqual([
      { kind: "check.open", payload: { name: "flare-dispatch/lint", head_sha: "2".repeat(40) } },
    ]);
    expect(heldRuns()).toHaveLength(1);
  });

  it("[FD-INT-057] a redelivered held request posts no second check run, and a run that owns no check posts none", async () => {
    const h = await harness();
    await deliver(h, "pull_request", pullRequestPayload({ head: "1".repeat(40) }));
    await h.adjust(10_000);
    const payload = pullRequestPayload({ head: "2".repeat(40) });
    await deliver(h, "pull_request", payload, "d-2");
    await deliver(h, "pull_request", payload, "d-3");
    const heldId = h.records().filter((r) => r.run === "lint")[1]!.execution_id as string;
    expect(h.rows("select kind from outbox where execution_id = ?", heldId)).toEqual([
      { kind: "check.open" },
    ]);
    await drainHeldChecks(h);
    expect(h.github.runs.filter((r) => r.external_id === heldId)).toHaveLength(1);

    const silent = await harness({
      settings: {
        catalog: (name) =>
          name === "lint"
            ? testRun("lint", { ownsCheck: false, cooldown: { seconds: 30, scope: () => "all" } })
            : undefined,
      },
      repos: {
        [REPO]: repoWithManifest(manifest([{ recipe: "lint", triggers: ["pull_request"] }])),
      },
    });
    await deliver(silent, "pull_request", pullRequestPayload({ head: "1".repeat(40) }));
    await silent.adjust(10_000);
    await deliver(silent, "pull_request", pullRequestPayload({ head: "2".repeat(40) }), "d-2");
    expect(silent.records().map((r) => r.not_before !== null)).toEqual([false, true]);
    expect(silent.github.runs).toEqual([]);
  });

  it("[FD-INT-057] [FD-GH-001] [FD-GH-010] a failed held-check insert preserves the hold and redelivery repairs the same outbox row", async () => {
    const h = await harness();
    await deliver(h, "pull_request", pullRequestPayload({ head: "1".repeat(40) }));
    await h.adjust(10_000);
    h.db.sqlite.exec(`create trigger fail_held_open before insert on outbox
      when new.kind = 'check.open' and exists (select 1 from intake_held where execution_id = new.execution_id)
      begin select raise(abort, 'injected held-open store failure'); end`);
    const payload = pullRequestPayload({ head: "2".repeat(40) });
    expect((await deliver(h, "pull_request", payload, "d-2"))!.status).toBe(503);
    const held = h.records().filter((r) => r.run === "lint")[1]!.execution_id as string;
    expect(h.rows("select execution_id from intake_held")).toEqual([{ execution_id: held }]);
    expect(h.rows("select kind from outbox where execution_id = ?", held)).toEqual([]);
    expect(h.github.calls).toEqual([]);
    h.db.sqlite.exec("drop trigger fail_held_open");
    const again = await bodyOf(await deliver(h, "pull_request", payload, "d-3"));
    expect(again.duplicate).toBe(true);
    expect(h.records().filter((r) => r.run === "lint")).toHaveLength(2);
    await drainHeldChecks(h);
    expect(h.github.runs.filter((r) => r.external_id === held)).toHaveLength(1);
    await h.adjust(50_000);
    await h.run(releaseHeld());
    await drainHeldChecks(h);
    expect(h.rows("select kind, sends from outbox where execution_id = ?", held)).toEqual([
      { kind: "check.open", sends: 1 },
    ]);
    expect(h.github.runs.filter((r) => r.external_id === held)).toHaveLength(1);
  });

  it("[FD-INT-057] a failed dropped-check insert leaves the held request available for the next release", async () => {
    const h = await harness();
    await deliver(h, "pull_request", pullRequestPayload({ head: "1".repeat(40) }));
    await h.adjust(10_000);
    const payload = pullRequestPayload({ head: "2".repeat(40) });
    await deliver(h, "pull_request", payload, "d-2");
    const held = h.records().filter((r) => r.run === "lint")[1]!.execution_id as string;
    await drainHeldChecks(h);
    await h.adjust(55_000);
    await deliver(h, "pull_request", payload, "d-3");
    h.db.sqlite.exec(`create trigger fail_held_drop before insert on outbox
      when new.kind = 'check.conclude' and exists (select 1 from intake_held where execution_id = new.execution_id)
      begin select raise(abort, 'injected held-drop store failure'); end`);
    expect(await h.run(Effect.result(releaseHeld()))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "StoreUnavailable" },
    });
    expect(h.rows("select execution_id from intake_held")).toEqual([{ execution_id: held }]);
    expect(h.records().some((r) => r.execution_id === held)).toBe(true);
    h.db.sqlite.exec("drop trigger fail_held_drop");
    expect(await h.run(releaseHeld())).toMatchObject({ duplicate: 1 });
    await drainHeldChecks(h);
    expect(h.github.runs.filter((r) => r.external_id === held)).toEqual([
      expect.objectContaining({ status: "completed", conclusion: "cancelled" }),
    ]);
    expect(h.rows("select execution_id from intake_held")).toEqual([]);
  });

  it("[FD-INT-057] a held request that release answers with another execution concludes its queued check run cancelled", async () => {
    const h = await harness();
    await deliver(h, "pull_request", pullRequestPayload({ head: "1".repeat(40) }));
    await h.adjust(10_000);
    const payload = pullRequestPayload({ head: "2".repeat(40) });
    await deliver(h, "pull_request", payload, "d-2");
    const held = h.records().filter((r) => r.run === "lint")[1]!.execution_id as string;
    // The window ends before the tick, so the same request arriving again is admitted at once under a new id.
    await h.adjust(55_000);
    await deliver(h, "pull_request", payload, "d-3");
    const other = h.records().filter((r) => r.run === "lint")[2]!.execution_id as string;
    expect(h.executions().map((e) => e.id)).toContain(other);

    expect(await h.run(releaseHeld())).toMatchObject({ admitted: 0, duplicate: 1 });
    await drainHeldChecks(h);
    expect(h.github.runs.filter((r) => r.external_id === held)).toEqual([
      expect.objectContaining({ external_id: held, status: "completed", conclusion: "cancelled" }),
    ]);
  });

  it("[FD-INT-057] MAMEKO-ADM-041 a held batch request released while the run's earlier execution still queues takes its place, and the earlier one is recorded deferred", async () => {
    const h = await harness();
    await deliver(h, "pull_request", pullRequestPayload({ head: "1".repeat(40) }));
    await h.adjust(10_000);
    await deliver(h, "pull_request", pullRequestPayload({ head: "2".repeat(40) }), "d-2");
    const [earlier, id] = h
      .records()
      .filter((r) => r.run === "lint")
      .map((r) => r.execution_id as string);
    await h.adjust(50_000);
    expect(await h.run(releaseHeld())).toMatchObject({ admitted: 1, concluded: 0 });
    expect(h.executions().find((e) => e.id === earlier)?.status).toBe("deferred");
    expect(h.executions().find((e) => e.id === id)?.status).toBe("pending");
    expect(h.rows("select count(*) as n from intake_held")[0]!.n).toBe(0);
  });

  it("[FD-INT-057] a redelivered request whose execution is held answers the held execution and writes nothing", async () => {
    const h = await harness();
    await deliver(h, "pull_request", pullRequestPayload({ head: "1".repeat(40) }));
    await h.adjust(10_000);
    const payload = pullRequestPayload({ head: "2".repeat(40) });
    const heldBody = await bodyOf(await deliver(h, "pull_request", payload, "d-2"));
    const again = await bodyOf(await deliver(h, "pull_request", payload, "d-3"));
    expect(again.executions).toEqual(heldBody.executions);
    expect(again.duplicate).toBe(true);
    expect(h.records().filter((r) => r.run === "lint")).toHaveLength(2);
    expect(h.rows("select count(*) as n from intake_held")[0]!.n).toBe(
      h.records().filter((r) => r.not_before !== null).length,
    );
  });

  it("[FD-INT-058] a check re-run takes no cooldown", async () => {
    const h = await harness({
      repos: {
        [REPO]: repoWithManifest(manifest([{ recipe: "review", triggers: ["pull_request"] }])),
      },
    });
    const opened = await bodyOf(await deliver(h, "pull_request", pullRequestPayload()));
    settle(h, "failure");
    await deliver(h, "check_run", checkRunRerequested((opened.executions as string[])[0]!), "d-2");
    expect(h.records().map((r) => r.not_before)).toEqual([null, null]);
  });
});

describe("other webhook events", () => {
  it("[FD-INT-016] a push to another branch reads the manifest at the default branch head", async () => {
    const h = await harness();
    await deliver(h, "push", pushPayload("refs/heads/feature"));
    expect(h.reads.calls.filter((c) => c.startsWith("file"))).toHaveLength(1);
    expect(h.executions().map((e) => e.run)).toEqual(["check"]);
    expect(APP_ID).toBeGreaterThan(0);
  });
});

describe("pull request close times", () => {
  const closedAt = (h: Harness, number = 12) => pullRequestClosedAt(h.db)(REPO, number);

  it("[FD-CACHE-064] a closed pull request records when it closed, which the cache sweep reads for its namespace", async () => {
    const h = await harness();
    expect(await closedAt(h)).toBeNull();
    const at = "2026-11-04T09:30:00Z";
    const r = await deliver(
      h,
      "pull_request",
      pullRequestPayload({ action: "closed", closedAt: at }),
    );
    expect(r?.status).toBe(202);
    expect(await closedAt(h)).toBe(Date.parse(at));
    // The sweep names the repository lower-cased, as the cache namespace does.
    expect(await pullRequestClosedAt(h.db)(REPO.toUpperCase(), 12)).toBe(Date.parse(at));
    // A close without `closed_at` counts from the delivery's arrival.
    await deliver(
      h,
      "pull_request",
      pullRequestPayload({ action: "closed", number: 13, closedAt: null }),
      "d-2",
    );
    expect(await closedAt(h, 13)).toBe(NOW);
    // An open pull request has no close time.
    await deliver(h, "pull_request", pullRequestPayload({ number: 14 }), "d-3");
    expect(await closedAt(h, 14)).toBeNull();
  });

  it("[FD-CACHE-064] a reopened pull request forgets its close, and a later close counts from the new time", async () => {
    const h = await harness();
    await deliver(
      h,
      "pull_request",
      pullRequestPayload({ action: "closed", closedAt: "2026-11-01T00:00:00Z" }),
    );
    await deliver(
      h,
      "pull_request",
      pullRequestPayload({ action: "reopened", updatedAt: "2026-11-04T10:00:00Z" }),
      "d-2",
    );
    expect(await closedAt(h)).toBeNull();
    await deliver(
      h,
      "pull_request",
      pullRequestPayload({ action: "closed", closedAt: "2026-11-04T11:00:00Z" }),
      "d-3",
    );
    expect(await closedAt(h)).toBe(Date.parse("2026-11-04T11:00:00Z"));
  });

  it("[FD-CACHE-064] a replayed or older close cannot restore a close time after a reopen", async () => {
    const h = await harness();
    const closed = pullRequestPayload({
      action: "closed",
      closedAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
    });
    await deliver(h, "pull_request", closed, "close-1");
    await deliver(
      h,
      "pull_request",
      pullRequestPayload({ action: "reopened", updatedAt: "2026-11-04T10:00:00Z" }),
      "reopen-1",
    );
    await deliver(h, "pull_request", closed, "close-1");
    expect(await closedAt(h)).toBeNull();
    // An older close first seen after the reopen also cannot overwrite it.
    await deliver(h, "pull_request", closed, "late-close");
    expect(await closedAt(h)).toBeNull();
    // updated_at, rather than the original closed_at, orders a new lifecycle event.
    await deliver(
      h,
      "pull_request",
      pullRequestPayload({
        action: "closed",
        closedAt: "2026-11-04T11:00:00Z",
        updatedAt: "2026-11-04T11:30:00Z",
      }),
      "close-2",
    );
    expect(await closedAt(h)).toBe(Date.parse("2026-11-04T11:00:00Z"));
    // Replaying an old reopen, even under a different delivery id, cannot resurrect the closed namespace.
    await deliver(
      h,
      "pull_request",
      pullRequestPayload({ action: "reopened", updatedAt: "2026-11-04T11:20:00Z" }),
      "late-reopen",
    );
    expect(await closedAt(h)).toBe(Date.parse("2026-11-04T11:00:00Z"));
  });

  it("[FD-CACHE-064] distinct lifecycle deliveries in one second apply, while replays cannot undo them", async () => {
    const h = await harness();
    const at = "2026-11-04T10:00:00Z";
    const closed = pullRequestPayload({ action: "closed", closedAt: at, updatedAt: at });
    const reopened = pullRequestPayload({ action: "reopened", updatedAt: at });
    await deliver(h, "pull_request", closed, "close-1");
    await deliver(h, "pull_request", reopened, "reopen-1");
    expect(await closedAt(h)).toBeNull();
    await deliver(h, "pull_request", closed, "close-1");
    expect(await closedAt(h)).toBeNull();
    // A genuine subsequent close in the same second still takes effect.
    await deliver(h, "pull_request", closed, "close-2");
    expect(await closedAt(h)).toBe(Date.parse(at));
    await deliver(h, "pull_request", reopened, "reopen-1");
    expect(await closedAt(h)).toBe(Date.parse(at));
  });

  it("[FD-CACHE-064] timestamp-free replays keep their original state despite a later delivery time", async () => {
    const h = await harness();
    const closed = pullRequestPayload({ action: "closed", closedAt: null });
    await deliver(h, "pull_request", closed, "close-1");
    expect(await closedAt(h)).toBe(NOW);
    await h.adjust(1_000);
    const reopened = pullRequestPayload({ action: "reopened" });
    await deliver(h, "pull_request", reopened, "reopen-1");
    await h.adjust(1_000);
    await deliver(h, "pull_request", closed, "close-1");
    expect(await closedAt(h)).toBeNull();
    await deliver(h, "pull_request", closed, "close-2");
    expect(await closedAt(h)).toBe(NOW + 2_000);
    await h.adjust(1_000);
    await deliver(h, "pull_request", reopened, "reopen-1");
    expect(await closedAt(h)).toBe(NOW + 2_000);
  });
});

describe("the catalogue's request decoders through the webhook route", () => {
  /** A repository whose manifest, at the default branch head and at the pushed commit, lists `runs`. */
  const catalogHarness = (runs: unknown[], extra: Record<string, unknown> = {}) => {
    const text = JSON.stringify({ version: 1, runs, ...extra });
    return harness({
      settings: { catalog: catalogRuns("development") },
      repos: {
        [REPO]: fakeRepo({
          branches: { main: BASE },
          files: {
            [`${BASE}:.github/flare-dispatch.json`]: text,
            [`${HEAD}:.github/flare-dispatch.json`]: text,
          },
        }),
      },
    });
  };
  const inputsOf = (h: Harness) =>
    h.records().map((r) => [r.run, JSON.parse(r.inputs_json as string)] as const);

  const draftPullRequest = (author: string, draft: boolean, head = HEAD) => {
    const payload = pullRequestPayload({ head });
    return {
      ...payload,
      pull_request: { ...payload.pull_request, draft, user: { login: author } },
    };
  };

  it("[FD-GATE-017] a draft pull request or an excluded author reaches check with the facts its recipe skips on", async () => {
    const h = await catalogHarness(
      [
        {
          recipe: "check",
          label: "unit",
          triggers: ["pull_request"],
          params: { steps: [{ label: "unit", command: "pnpm test" }] },
        },
      ],
      { skipAuthors: ["renovate[bot]"] },
    );
    await deliver(h, "pull_request", draftPullRequest("octocat", true));
    await deliver(
      h,
      "pull_request",
      { ...draftPullRequest("renovate[bot]", false, "e".repeat(40)), action: "reopened" },
      "d-2",
    );
    expect(inputsOf(h)).toEqual([
      [
        "check",
        expect.objectContaining({
          pullRequest: { draft: true, author: "octocat" },
          skipAuthors: ["renovate[bot]"],
          label: "unit",
        }),
      ],
      [
        "check",
        expect.objectContaining({
          pullRequest: { draft: false, author: "renovate[bot]" },
          skipAuthors: ["renovate[bot]"],
        }),
      ],
    ]);
  });

  it("[FD-GATE-062] a push to the deploy branch and an Actions dispatch with an Idempotency-Key deploy one commit once", async () => {
    const h = await catalogHarness([
      {
        recipe: "worker-deploy",
        triggers: ["push", "dispatch"],
        params: { command: "pnpm deploy" },
      },
    ]);
    const pushed = await bodyOf(await deliver(h, "push", pushPayload("refs/heads/main")));
    expect(pushed.executions).toHaveLength(1);
    expect(inputsOf(h)).toEqual([
      [
        "worker-deploy",
        expect.objectContaining({ sha: HEAD, branch: "main", entry: { command: "pnpm deploy" } }),
      ],
    ]);
    const inputs = {
      repo: `https://github.com/${REPO}.git`,
      sha: HEAD,
      ref: "refs/heads/main",
      scope: REPO,
      branch: "main",
      entry: { command: "pnpm deploy" },
    };
    const dispatched = await admit(
      h,
      authenticated({
        run: "worker-deploy",
        sha: HEAD,
        label: null,
        inputs,
        idempotency: { key: "deploy-1", body: { sha: HEAD, inputs } },
      }),
    );
    expect(dispatched).toMatchObject({
      executionId: (pushed.executions as string[])[0],
      duplicate: true,
    });
    expect(h.rows("select canonical from dedup_keys")).toEqual([
      { canonical: `worker-deploy:${REPO}:${HEAD}` },
    ]);
  });

  it("[FD-GATE-062] a push to another branch than workerDeploy.branch deploys nothing", async () => {
    const h = await catalogHarness([
      {
        recipe: "worker-deploy",
        triggers: ["push"],
        params: { command: "pnpm deploy", branch: "release" },
      },
    ]);
    await deliver(h, "push", pushPayload("refs/heads/main"));
    await deliver(h, "push", pushPayload("refs/heads/feature"), "d-2");
    expect(h.executions()).toEqual([]);
    await deliver(h, "push", pushPayload("refs/heads/release"), "d-3");
    expect(h.executions().map((e) => e.run)).toEqual(["worker-deploy"]);
  });

  it("[FD-GATE-070] a successful production deployment_status with an environment_url requests deploy-smoke; a failed one requests nothing", async () => {
    const h = await catalogHarness([
      {
        recipe: "deploy-smoke",
        triggers: ["deployment_status"],
        params: { hosts: ["app.example.com"] },
      },
    ]);
    const status = (state: string) => ({
      action: "created",
      repository: { full_name: REPO },
      installation: { id: 7 },
      deployment: { sha: HEAD, ref: "main", environment: "production" },
      deployment_status: {
        state,
        environment: "production",
        environment_url: "https://app.example.com",
      },
    });
    await deliver(h, "deployment_status", status("failure"));
    expect(h.executions()).toEqual([]);
    const r = await bodyOf(await deliver(h, "deployment_status", status("success"), "d-2"));
    expect(r.executions).toHaveLength(1);
    expect(inputsOf(h)).toEqual([
      [
        "deploy-smoke",
        {
          scope: REPO,
          sha: HEAD,
          hosts: ["app.example.com"],
          targetUrl: "https://app.example.com",
        },
      ],
    ]);
  });
});
