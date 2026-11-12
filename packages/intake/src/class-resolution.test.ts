// Class resolution through the profile's `resolveClass` binding, fed by the cached protection snapshot, and the
// protected-trigger answer a push records: signed webhooks through the route group, the fake GitHub reads and mameko's
// real admission transaction on SQLite.
import {
  GithubHttpError,
  GithubNetworkError,
  GithubUncredentialed,
} from "@fractalboxdev/flare-dispatch-github";
import { describe, expect, it } from "vitest";
import {
  BASE,
  CATALOG,
  HEAD,
  harness,
  manifest,
  pullRequestPayload,
  pushPayload,
  REPO,
  repoWithManifest,
  signedWebhook,
  testRun,
  type Harness,
  type HarnessOptions,
} from "./harness.test-support.ts";
import { PROTECTION_TTL_MS, resolveClass } from "@fractalboxdev/flare-dispatch-profile";
import { catalogRuns } from "./catalog.ts";
import type { ClassRequest } from "./config.ts";
import { profileRequestOf } from "./layer.ts";
import { unavailableOf } from "./protection.ts";
import { handleIntake } from "./routes.ts";
import { targetBranchOf } from "./triggers.ts";

const deliver = async (h: Harness, event: string, payload: unknown, delivery = "d-1") =>
  h.run(handleIntake(await signedWebhook(event, payload, { delivery }), "webhooks/github"));

const classes = (h: Harness) =>
  Object.fromEntries(h.executions().map((e) => [e.run as string, e.class as string]));

/** The class of `check` on each head, in the order the heads are given. */
const checkClasses = (h: Harness, ...heads: string[]) =>
  heads.map(
    (sha) =>
      h.rows("select class from intake_records where run = 'check' and sha = ?", sha)[0]?.class,
  );

const requiredReads = (h: Harness) =>
  h.reads.calls.filter((c) => c === `requiredChecks ${REPO}`).length;

const resolving = (options: HarnessOptions = {}) => harness({ ...options, profileResolver: true });

const withRequired = (required: string[]) =>
  resolving({ repos: { [REPO]: repoWithManifest(undefined, { required: { main: required } }) } });

const RELEASE_CATALOG = {
  ...CATALOG,
  "worker-deploy": testRun("worker-deploy", { defaultClass: "release", qosCeiling: "release" }, [
    "push",
  ]),
};
const RELEASE_MANIFEST = manifest([{ recipe: "worker-deploy", triggers: ["push"] }]);
const releaseHarness = (protectedRefs: string[]) =>
  resolving({
    settings: { catalog: (name) => RELEASE_CATALOG[name as keyof typeof RELEASE_CATALOG] },
    repos: { [REPO]: repoWithManifest(RELEASE_MANIFEST, { protectedRefs }) },
  });

describe("resolveClass at intake", () => {
  it("[FD-PROF-013] a gating run on a pull request resolves to required when the base branch requires its check, and to interactive when it does not", async () => {
    const required = await withRequired(["flare-dispatch/check:ci"]);
    await deliver(required, "pull_request", pullRequestPayload());
    expect(classes(required)).toEqual({ check: "required", lint: "batch" });
    expect(required.reads.calls).toContain(`requiredChecks ${REPO}`);

    const optional = await withRequired(["flare-dispatch/other"]);
    await deliver(optional, "pull_request", pullRequestPayload());
    expect(classes(optional)).toEqual({ check: "interactive", lint: "batch" });
  });

  it("[FD-PROF-013] a merge group and a gh-readonly-queue push read the required set of the base branch they name", () => {
    expect(
      targetBranchOf("merge_group", { merge_group: { base_ref: "refs/heads/release/2" } }),
    ).toBe("release/2");
    expect(
      targetBranchOf("push", {
        ref: `refs/heads/gh-readonly-queue/release/2/pr-12-${HEAD}`,
      }),
    ).toBe("release/2");
    expect(targetBranchOf("push", { ref: "refs/heads/feature" })).toBeNull();
    expect(
      targetBranchOf("pull_request", {
        pull_request: { number: 1, head: {}, base: { ref: "main" } },
      }),
    ).toBe("main");
  });

  it("[FD-PROF-014] the required set is read once per branch for 10 min, and again after a repository_ruleset or branch_protection_rule webhook", async () => {
    const h = await withRequired(["flare-dispatch/check:ci"]);
    await deliver(h, "pull_request", pullRequestPayload({ head: "1".repeat(40) }), "d-1");
    await deliver(h, "pull_request", pullRequestPayload({ head: "2".repeat(40) }), "d-2");
    expect(requiredReads(h)).toBe(1);

    h.reads.repos[REPO]!.required = { main: [] };
    await deliver(
      h,
      "repository_ruleset",
      { action: "edited", repository: { full_name: REPO } },
      "d-3",
    );
    await deliver(h, "pull_request", pullRequestPayload({ head: "3".repeat(40) }), "d-4");
    expect(requiredReads(h)).toBe(2);
    expect(checkClasses(h, "1".repeat(40), "2".repeat(40), "3".repeat(40))).toEqual([
      "required",
      "required",
      "interactive",
    ]);

    await deliver(
      h,
      "branch_protection_rule",
      { action: "created", repository: { full_name: REPO } },
      "d-5",
    );
    await deliver(h, "pull_request", pullRequestPayload({ head: "4".repeat(40) }), "d-6");
    expect(requiredReads(h)).toBe(3);

    await h.adjust(PROTECTION_TTL_MS);
    await deliver(h, "pull_request", pullRequestPayload({ head: "5".repeat(40) }), "d-7");
    expect(requiredReads(h)).toBe(4);
  });

  it("[FD-PROF-014] an organization ruleset event that names no repository drops every repository's cached set", async () => {
    const h = await withRequired(["flare-dispatch/check:ci"]);
    await deliver(h, "pull_request", pullRequestPayload({ head: "1".repeat(40) }), "d-1");
    await deliver(h, "repository_ruleset", { action: "deleted" }, "d-2");
    await deliver(h, "pull_request", pullRequestPayload({ head: "2".repeat(40) }), "d-3");
    expect(requiredReads(h)).toBe(2);
  });

  it("[FD-PROF-015] a required set that times out or answers a server error resolves the gating run to required, and is not cached", async () => {
    const h = await withRequired([]);
    h.reads.failures.set(
      `requiredChecks ${REPO}`,
      new GithubHttpError({ status: 502, message: "Bad Gateway", rateLimited: false }),
    );
    await deliver(h, "pull_request", pullRequestPayload({ head: "1".repeat(40) }), "d-1");
    h.reads.failures.set(
      `requiredChecks ${REPO}`,
      new GithubNetworkError({ sent: true, message: "no answer" }),
    );
    await deliver(h, "pull_request", pullRequestPayload({ head: "2".repeat(40) }), "d-2");
    expect(checkClasses(h, "1".repeat(40), "2".repeat(40))).toEqual(["required", "required"]);
    expect(h.recorded.alarms).toEqual([]);

    h.reads.failures.delete(`requiredChecks ${REPO}`);
    await deliver(h, "pull_request", pullRequestPayload({ head: "3".repeat(40) }), "d-3");
    expect(checkClasses(h, "3".repeat(40))).toEqual(["interactive"]);
  });

  it("[FD-PROF-016] a required set the App may not read takes the run default and raises ruleset-permission", async () => {
    const h = await withRequired(["flare-dispatch/check:ci"]);
    h.reads.failures.set(
      `requiredChecks ${REPO}`,
      new GithubHttpError({
        status: 403,
        message: "Resource not accessible by integration",
        rateLimited: false,
      }),
    );
    await deliver(h, "pull_request", pullRequestPayload());
    expect(classes(h)).toEqual({ check: "interactive", lint: "batch" });
    expect(h.recorded.alarms).toEqual([
      expect.objectContaining({
        name: "ruleset-permission",
        state: "raised",
        detail: expect.objectContaining({ run: "check", scopeId: REPO }),
      }),
    ]);
  });

  it("[FD-PROF-015] [FD-PROF-016] a read failure maps to the Unavailable reason the binding acts on", () => {
    const http = (status: number, rateLimited = false) =>
      unavailableOf(new GithubHttpError({ status, message: "", rateLimited })).reason;
    expect([http(401), http(403), http(403, true), http(429, true), http(500), http(404)]).toEqual([
      "forbidden",
      "forbidden",
      "server-error",
      "server-error",
      "server-error",
      "server-error",
    ]);
    expect(unavailableOf(new GithubUncredentialed({ repo: REPO })).reason).toBe("forbidden");
    expect(unavailableOf(new GithubNetworkError({ sent: true, message: "" })).reason).toBe(
      "timeout",
    );
  });

  it("[FD-PROF-012] a release-allowlisted run on a push of a ruleset-protected tag resolves to release, and on an unprotected tag does not", async () => {
    const tag = "refs/tags/v1.2.0";
    const guarded = await releaseHarness([tag]);
    await deliver(guarded, "push", pushPayload(tag));
    expect(classes(guarded)).toEqual({ "worker-deploy": "release" });

    const open = await releaseHarness([]);
    await deliver(open, "push", pushPayload(tag));
    expect(classes(open)).toEqual({ "worker-deploy": "required" });

    const branch = await releaseHarness(["refs/heads/main"]);
    await deliver(branch, "push", pushPayload("refs/heads/main", BASE));
    expect(classes(branch)).toEqual({ "worker-deploy": "required" });
  });

  it("[FD-PROF-013] [FD-PROF-018] the catalogue's check resolves to required on a pull request its base requires, and to its batch default when dispatched", () => {
    const check = catalogRuns("development")("check")!;
    const request: ClassRequest = {
      run: check,
      trigger: "webhook",
      event: "pull_request",
      repo: REPO,
      ref: "refs/heads/feature",
      sha: HEAD,
      defaultBranch: "main",
      targetBranch: "main",
      refProtection: null,
      checkName: "flare-dispatch/check:unit",
      classInput: null,
      classCeiling: null,
      caller: null,
    };
    const snapshot = { "protection-snapshot": { requiredChecks: ["flare-dispatch/check:unit"] } };
    expect(resolveClass(profileRequestOf(request, false), snapshot).class).toBe("required");
    expect(
      resolveClass(profileRequestOf({ ...request, trigger: "dispatch", event: null }, false), {})
        .class,
    ).toBe("batch");
  });

  it("[FD-PROF-024] a fork pull request resolves with the label untrusted-input", async () => {
    const h = await resolving();
    await deliver(h, "pull_request", pullRequestPayload({ headRepo: "mallory/app" }));
    expect(h.records().map((r) => [r.run, r.labels_json])).toEqual([
      ["check", '["untrusted-input"]'],
      ["lint", '["untrusted-input"]'],
    ]);
  });
});

describe("synced policy rules at intake", () => {
  it("[FD-PROF-017] a repository's synced rule lowers its run's class, and another repository's rule does not apply", async () => {
    const withRules = (repo: string) =>
      resolving({
        repos: { [REPO]: repoWithManifest(undefined, { required: { main: [] } }) },
        settings: {
          policyRules: (r) =>
            r === repo
              ? [
                  {
                    match: {},
                    confidentiality: "confidential-compute",
                    acceptsFailingRequiredCheck: true,
                  },
                  { match: { run: "check" }, class: "batch" },
                ]
              : [],
        },
      });
    const own = await withRules(REPO);
    await deliver(own, "pull_request", pullRequestPayload());
    expect(classes(own)).toEqual({ check: "batch", lint: "batch" });

    const other = await withRules("acme/other");
    await deliver(other, "pull_request", pullRequestPayload());
    expect(classes(other)).toEqual({ check: "interactive", lint: "batch" });
  });
});

describe("protected triggers", () => {
  const pushed = async (ref: string, protectedRefs: string[]) => {
    const h = await harness({
      repos: { [REPO]: repoWithManifest(undefined, { protectedRefs }) },
    });
    await deliver(h, "push", pushPayload(ref));
    return h;
  };
  const triggers = (h: Harness) => [...new Set(h.records().map((r) => r.cache_trigger_json))];

  it("[FD-CACHE-017] a push to a branch or tag a ruleset or branch protection protects records protected: true; any other push records false", async () => {
    const release = await pushed("refs/heads/release/2", ["refs/heads/release/2"]);
    expect(triggers(release)).toEqual([
      JSON.stringify({ _tag: "Push", ref: "refs/heads/release/2", protected: true }),
    ]);
    const tag = await pushed("refs/tags/v1", ["refs/tags/v1"]);
    expect(triggers(tag)).toEqual([
      JSON.stringify({ _tag: "Push", ref: "refs/tags/v1", protected: true }),
    ]);
    const feature = await pushed("refs/heads/feature", ["refs/heads/release/2"]);
    expect(triggers(feature)).toEqual([
      JSON.stringify({ _tag: "Push", ref: "refs/heads/feature", protected: false }),
    ]);
  });

  it("[FD-CACHE-020] a gh-readonly-queue push is never a protected trigger and reads no protection", async () => {
    const ref = `refs/heads/gh-readonly-queue/main/pr-12-${HEAD}`;
    const h = await pushed(ref, [ref]);
    expect(triggers(h)).toEqual([JSON.stringify({ _tag: "Push", ref, protected: false })]);
    expect(h.reads.calls).not.toContain(`refProtected ${REPO}`);
  });

  it("[FD-CACHE-017] a push whose protection cannot be read runs as an unprotected trigger and writes no protected tier, except on the default branch", async () => {
    const h = await harness();
    h.reads.failures.set(
      `refProtected ${REPO}`,
      new GithubHttpError({ status: 503, message: "unavailable", rateLimited: false }),
    );
    await deliver(h, "push", pushPayload("refs/heads/release/2"));
    expect(h.sheds()).toEqual([]);
    expect(triggers(h)).toEqual([
      JSON.stringify({ _tag: "Push", ref: "refs/heads/release/2", protected: false }),
    ]);

    await deliver(h, "push", pushPayload("refs/heads/main", BASE), "d-2");
    expect(triggers(h)).toEqual([
      JSON.stringify({ _tag: "Push", ref: "refs/heads/release/2", protected: false }),
      JSON.stringify({ _tag: "Push", ref: "refs/heads/main", protected: true }),
    ]);
  });
});
