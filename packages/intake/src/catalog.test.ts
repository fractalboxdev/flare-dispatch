// The catalogue's request decoders as intake selects them by manifest key: a webhook read as the catalogue's
// `WebhookDelivery`, each run's parameters bound from its manifest entry.
import { Outcome, pullRequestSkip, type GateContext } from "@fractalboxdev/flare-dispatch-catalog";
import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { catalogRuns } from "./catalog.ts";
import type { DispatchEvent } from "./event.ts";
import type { EntryView } from "./runs.ts";

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
