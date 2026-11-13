// The catalogue's request decoders as intake selects them by manifest key: a webhook read as the catalogue's
// `WebhookDelivery`, each run's parameters bound from its manifest entry.
import { Outcome, pullRequestSkip, type GateContext } from "@fractalboxdev/flare-dispatch-catalog";
import { FollowOnSubmitter } from "@fractalboxdev/flare-dispatch-github";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { catalogRuns } from "./catalog.ts";
import type { DispatchEvent } from "./event.ts";
import { followOnSubmitterLayer } from "./follow-on.ts";
import {
  admit,
  authenticated,
  CATALOG,
  harness,
  manifest,
  refusal,
  repoWithManifest,
} from "./harness.test-support.ts";
import { submitLocal } from "./local.ts";
import { validateManifest } from "./manifest.ts";
import { checkName, type EntryView } from "./runs.ts";

const REPO = "acme/app";
const HEAD = "b".repeat(40);
const BASE = "c".repeat(40);
const context = { defaultBranch: "main" };
const catalog = catalogRuns("development");

const webhook = (event: string, payload: { action?: string }): DispatchEvent => ({
  _tag: "webhook",
  event,
  action: payload.action ?? null,
  deliveryId: "d-1",
  payload,
});

const decode = (run: string, event: DispatchEvent, view: Partial<EntryView> = {}) =>
  catalog(run)!.trigger(event, { label: null, params: {}, ...view }, context);

const repository = { full_name: REPO, clone_url: `https://github.com/${REPO}.git` };

const pullRequest = (o: { draft?: boolean; author?: string; action?: string } = {}) =>
  webhook("pull_request", {
    action: o.action ?? "synchronize",
    repository,
    pull_request: {
      number: 12,
      draft: o.draft ?? false,
      user: { login: o.author ?? "octocat" },
      head: { sha: HEAD, ref: "feature", repo: { full_name: REPO } },
      base: { sha: BASE, ref: "main", repo: { full_name: REPO } },
    },
  } as { action: string });

const push = (ref: string) =>
  webhook("push", { ref, before: BASE, after: HEAD, repository, head_commit: { id: HEAD } } as {});

const deploymentStatus = (o: { state?: string; environment?: string; url?: string | null } = {}) =>
  webhook("deployment_status", {
    action: "created",
    repository,
    deployment: { sha: HEAD, ref: "main", environment: o.environment ?? "production" },
    deployment_status: {
      state: o.state ?? "success",
      environment: o.environment ?? "production",
      ...(o.url === null ? {} : { environment_url: o.url ?? "https://app.example.com" }),
    },
  } as { action: string });

/** Each gate recipe that FD-GATE-017 names, with parameters its manifest key decodes. */
const GATES = [
  { run: "check", params: { steps: [{ label: "unit", command: "pnpm test" }] } },
  { run: "oxlint", params: {} },
  { run: "offload-test", params: { command: "pnpm test" } },
] as const;

const skipOf = (decoded: Option.Option<unknown>) =>
  pullRequestSkip(Option.getOrThrow(decoded) as GateContext);

describe("gate recipes on a pull request (FD-GATE-017)", () => {
  it.each(GATES)(
    "[FD-GATE-017] $run decodes a draft pull request into an input its recipe skips as draft-pr",
    ({ run, params }) => {
      expect(skipOf(decode(run, pullRequest({ draft: true }), { params }))).toEqual(
        Outcome.skipped("draft-pr"),
      );
      expect(skipOf(decode(run, pullRequest(), { params }))).toBeUndefined();
    },
  );

  it.each(GATES)(
    "[FD-GATE-017] $run skips dependabot[bot] by default and the manifest's skipAuthors when it names them",
    ({ run, params }) => {
      const dependabot = pullRequest({ author: "dependabot[bot]" });
      const renovate = pullRequest({ author: "renovate[bot]" });
      expect(skipOf(decode(run, dependabot, { params }))).toEqual(
        Outcome.skipped("author-excluded"),
      );
      expect(skipOf(decode(run, renovate, { params }))).toBeUndefined();
      const skipAuthors = ["renovate[bot]"];
      expect(skipOf(decode(run, renovate, { params, skipAuthors }))).toEqual(
        Outcome.skipped("author-excluded"),
      );
      expect(skipOf(decode(run, dependabot, { params, skipAuthors }))).toBeUndefined();
    },
  );

  it("[FD-GATE-017] check runs the entry's steps under its label at the pull request's head", () => {
    const steps = [{ label: "unit", command: "pnpm test", timeoutSec: 900 }];
    expect(
      Option.getOrThrow(decode("check", pullRequest(), { label: "ci", params: { steps } })),
    ).toEqual({
      repo: `https://github.com/${REPO}.git`,
      sha: HEAD,
      ref: "refs/pull/12/head",
      scope: REPO,
      pullRequest: { draft: false, author: "octocat" },
      label: "ci",
      steps,
    });
    expect(decode("check", pullRequest({ action: "closed" }), { params: { steps } })).toStrictEqual(
      Option.none(),
    );
  });
});

describe("worker-deploy on a push (FD-GATE-062)", () => {
  const params = { command: "pnpm deploy" };

  it("[FD-GATE-062] a push to the default branch decodes into a worker-deploy of the pushed commit; another branch decodes nothing", () => {
    expect(Option.getOrThrow(decode("worker-deploy", push("refs/heads/main"), { params }))).toEqual(
      {
        repo: `https://github.com/${REPO}.git`,
        sha: HEAD,
        ref: "refs/heads/main",
        scope: REPO,
        branch: "main",
        entry: params,
      },
    );
    expect(decode("worker-deploy", push("refs/heads/feature"), { params })).toStrictEqual(
      Option.none(),
    );
  });

  it("[FD-GATE-062] workerDeploy.branch names the deploy branch, and the manifest entry's label is the deploy's label", () => {
    const release = { ...params, branch: "release" };
    expect(decode("worker-deploy", push("refs/heads/main"), { params: release })).toStrictEqual(
      Option.none(),
    );
    expect(
      Option.getOrThrow(
        decode("worker-deploy", push("refs/heads/release"), { label: "edge", params: release }),
      ),
    ).toMatchObject({ branch: "release", entry: { ...release, label: "edge" } });
  });

  it("[FD-GATE-062] a push that deletes the deploy branch decodes nothing", () => {
    const deleted = webhook("push", {
      ref: "refs/heads/main",
      before: HEAD,
      after: "0".repeat(40),
      deleted: true,
      head_commit: null,
      repository,
    } as {});
    expect(decode("worker-deploy", deleted, { params })).toStrictEqual(Option.none());
  });

  it("[FD-GATE-062] a pull request decodes no worker-deploy", () => {
    expect(decode("worker-deploy", pullRequest(), { params })).toStrictEqual(Option.none());
  });
});

describe("deploy-smoke on a deployment status (FD-GATE-070)", () => {
  const params = { hosts: ["app.example.com"] };

  it("[FD-GATE-070] a successful production deployment_status with an environment_url requests deploy-smoke of its commit", () => {
    expect(Option.getOrThrow(decode("deploy-smoke", deploymentStatus(), { params }))).toEqual({
      scope: REPO,
      sha: HEAD,
      hosts: ["app.example.com"],
      targetUrl: "https://app.example.com",
    });
  });

  it("[FD-GATE-070] a state other than success, an environment outside deploySmoke.environments or no environment_url requests nothing", () => {
    for (const event of [
      deploymentStatus({ state: "failure" }),
      deploymentStatus({ state: "in_progress" }),
      deploymentStatus({ environment: "staging" }),
      deploymentStatus({ url: null }),
      deploymentStatus({ url: "" }),
    ])
      expect(decode("deploy-smoke", event, { params })).toStrictEqual(Option.none());
    expect(
      Option.isSome(
        decode("deploy-smoke", deploymentStatus({ environment: "staging" }), {
          params: { ...params, environments: ["staging"] },
        }),
      ),
    ).toBe(true);
  });
});

describe("offload-test on a release tag push (FD-GATE-054)", () => {
  const TAG_OBJECT = "d".repeat(40);
  const params = { command: "pnpm test", release: true };

  it("[FD-GATE-054] a tag push runs at head_commit.id, the tagged commit, not the tag object in after", () => {
    const tag = webhook("push", {
      ref: "refs/tags/v1.0.0",
      before: "0".repeat(40),
      after: TAG_OBJECT,
      head_commit: { id: HEAD },
      repository,
    } as {});
    const input = Option.getOrThrow(decode("offload-test", tag, { params })) as {
      sha: string;
      parentDedupKey: string;
    };
    expect(input.sha).toBe(HEAD);
    expect(input.parentDedupKey).toBe(`offload-test:${REPO}:${HEAD}`);
  });
});

describe("the security gate recipes as intake reads them", () => {
  const production = catalogRuns("production");
  const SCANS = ["security-gate", "security-rescan"] as const;
  const mergeGroup = webhook("merge_group", {
    action: "checks_requested",
    repository,
    merge_group: {
      head_sha: HEAD,
      head_ref: "refs/heads/gh-readonly-queue/main/pr-12-bbbb",
      base_ref: "refs/heads/main",
      base_sha: BASE,
    },
  } as { action: string });

  it("[FD-GATE-083] serves security-gate and security-rescan, whose manifest entries take the securityGate parameters", () => {
    for (const run of SCANS) expect(production(run)?.name).toBe(run);
    const valid = validateManifest(
      manifest([
        { recipe: "security-gate", triggers: ["pull_request", "merge_group"], params: {} },
        { recipe: "security-rescan", triggers: ["dispatch"] },
      ]),
      200,
      production,
    );
    expect(valid._tag).toBe("Valid");
  });

  it("[FD-GATE-084] refuses a manifest whose securityGate entry names a command, scanner, flag or skip", () => {
    for (const run of SCANS)
      for (const params of [
        { command: "gitleaks detect" },
        { scanners: { gitleaks: false } },
        { flags: ["--no-git"] },
        { skipAuthors: ["dependabot[bot]"] },
        { skipDraft: true },
      ]) {
        const read = validateManifest(
          manifest([{ recipe: run, triggers: ["pull_request", "dispatch"], params }]),
          200,
          production,
        );
        expect(read._tag).toBe("Invalid");
      }
  });

  it("[FD-GATE-085] admits a draft pull request from dependabot[bot] and a merge group into a scan input with no skip fact", () => {
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"])
      for (const facts of [{ draft: true, author: "dependabot[bot]" }, { draft: false }]) {
        const input = Option.getOrThrow(
          production("security-gate")!.trigger(
            pullRequest({ ...facts, action }),
            { label: null, params: {} },
            context,
          ),
        );
        expect(input).toEqual({
          repo: `https://github.com/${REPO}.git`,
          sha: HEAD,
          ref: "refs/pull/12/head",
          scope: REPO,
          base: { _tag: "TargetBranch", branch: "main" },
        });
      }
    // The manifest's skipAuthors does not reach the scan input either.
    const listed = production("security-gate")!.trigger(
      pullRequest({ author: "renovate[bot]" }),
      { label: null, params: {}, skipAuthors: ["renovate[bot]"] },
      context,
    );
    expect(Option.getOrThrow(listed)).not.toHaveProperty("skipAuthors");
    expect(
      Option.getOrThrow(
        production("security-gate")!.trigger(mergeGroup, { label: null, params: {} }, context),
      ),
    ).toMatchObject({ sha: HEAD, base: { _tag: "MergeGroup", baseSha: BASE } });
  });

  it("[FD-GATE-110] gives both scan runs no grant in either egress phase", () => {
    for (const run of SCANS) expect(production(run)!.grants).toEqual({ setup: [], agent: [] });
  });

  it("[FD-GATE-111] answers no webhook for security-rescan and refuses a label on its manifest entry", () => {
    const rescan = production("security-rescan")!;
    expect(rescan.dispatchOnly).toBe(true);
    expect(production("security-gate")!.dispatchOnly).toBeUndefined();
    for (const event of [pullRequest(), mergeGroup, push("refs/heads/main")])
      expect(Option.isNone(rescan.trigger(event, { label: null, params: {} }, context))).toBe(true);
    const labelled = validateManifest(
      manifest([{ recipe: "security-rescan", label: "nightly", triggers: ["dispatch"] }]),
      200,
      production,
    );
    expect(labelled).toEqual({
      _tag: "Invalid",
      errors: ["runs[0].label: security-rescan takes no label"],
    });
    expect(checkName(rescan.name, null)).toBe("flare-dispatch/security-rescan");
  });

  it("[FD-GATE-099] refuses a label on a security-gate entry, so intake opens the check its summary names", () => {
    const gate = production("security-gate")!;
    expect(gate.labelless).toBe(true);
    expect(
      validateManifest(
        manifest([{ recipe: "security-gate", label: "x", triggers: ["pull_request"] }]),
        200,
        production,
      ),
    ).toEqual({ _tag: "Invalid", errors: ["runs[0].label: security-gate takes no label"] });
    expect(
      validateManifest(
        manifest([{ recipe: "security-gate", triggers: ["pull_request"] }]),
        200,
        production,
      )._tag,
    ).toBe("Valid");
    expect(checkName(gate.name, null)).toBe("flare-dispatch/security-gate");
  });

  it("[FD-GATE-111] starts security-rescan from a dispatch under flare-dispatch/security-rescan, and from no follow-on or local submission", async () => {
    const h = await harness({
      repos: {
        [REPO]: repoWithManifest(
          manifest([
            { recipe: "check", label: "ci", triggers: ["pull_request"], params: { steps: ["test"] } },
            { recipe: "security-rescan", triggers: ["dispatch"] },
          ]),
        ),
      },
      settings: {
        catalog: (name) => (name === "security-rescan" ? production(name) : CATALOG[name]),
      },
    });
    const inputs = { repo: `https://github.com/${REPO}.git`, sha: HEAD, ref: "refs/heads/main" };
    // A dispatch of the read-only scan run carries an Idempotency-Key (FD-IFC-092).
    const idempotency = { key: "rescan-1", body: { repository: REPO, inputs } };
    const admitted = await admit(
      h,
      authenticated({ run: "security-rescan", label: null, sha: HEAD, inputs, idempotency }),
    );
    expect(admitted.duplicate).toBe(false);
    expect(h.records()).toMatchObject([{ run: "security-rescan", trigger: "dispatch", label: null }]);
    expect(h.recorded.resolved.map((r) => r.checkName)).toEqual(["flare-dispatch/security-rescan"]);
    // A dispatch naming a label matches no manifest entry.
    expect(
      await refusal(
        h,
        authenticated({ run: "security-rescan", label: "x", sha: HEAD, inputs, idempotency }),
      ),
    ).toMatchObject({ status: 404, code: "run_not_found" });

    const followOn = await h.run(
      FollowOnSubmitter.use((s) =>
        s.submit({
          executionId: admitted.executionId,
          intentKey: "run:rescan:0",
          run: "security-rescan",
          label: null,
          inputs,
        }),
      ).pipe(Effect.provide(followOnSubmitterLayer)),
    );
    expect(followOn).toEqual({
      _tag: "refused",
      reason: "follow-on: security-rescan starts only from a dispatch",
    });
    const local = await h.run(
      submitLocal({ leaseId: "L1", epoch: 1 }, "security-rescan", {
        repository: REPO,
        baseCommit: HEAD,
        ref: "refs/heads/main",
        treeHash: "tree-1",
        inputsDigest: "inputs-1",
        inputs,
      }),
    );
    expect(local).toEqual({ _tag: "rejected" });
    expect(h.records()).toHaveLength(1);
  });
});
