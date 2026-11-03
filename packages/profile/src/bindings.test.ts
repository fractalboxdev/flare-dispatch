import { dedupKey, resolveRequestClass } from "@fractalboxdev/mameko-coordinator";
import { describe, expect, it } from "vitest";
import {
  commitRecipe,
  dedupRecipes,
  followOnRecipe,
  idempotencyKeyRecipe,
  profile,
  PROTECTION_TTL_MS,
  ProtectionSnapshotCache,
  resolveClass,
  resolveClassDetailed,
  supersessionKey,
  type ClassRequest,
  type PolicyRule,
} from "./index.ts";

const pr: ClassRequest = {
  run: "check",
  repository: "acme/app",
  sha: "abc123",
  trigger: { kind: "pull_request" },
  checkName: "flare-dispatch/check:ci",
  qosClass: "batch",
  pullRequest: 7,
};
const required = { "protection-snapshot": { requiredChecks: ["flare-dispatch/check:ci"] } };
const notRequired = { "protection-snapshot": { requiredChecks: [] } };
const unavailable = (reason: string) => ({
  "protection-snapshot": { _tag: "Unavailable", reason },
});
const rules = (...r: PolicyRule[]) => ({ "policy-rules": r });

describe("resolveClass", () => {
  it("[FD-PROF-011] is mameko's class-resolution binding: one call, a class from the catalogue", () => {
    expect(profile.class_resolution).toEqual({
      binding: "resolveClass",
      inputs: [{ name: "protection-snapshot" }, { name: "policy-rules" }],
      default_class: "batch",
    });
    const resolution = resolveRequestClass({
      binding: resolveClass,
      request: pr,
      inputs: required,
      catalogue: profile.classes,
      allowedLabels: ["untrusted-input", "local-only"],
      parentClass: null,
    });
    expect(resolution).toEqual({ _tag: "Class", class: "required", labels: [], alarm: null });
  });

  it("[FD-PROF-012] returns release only for an allowlisted run on a release trigger", () => {
    const tag: ClassRequest = {
      ...pr,
      run: "release",
      trigger: { kind: "tag-push", protectedTag: true },
    };
    expect(resolveClass(tag, {})).toMatchObject({ class: "release" });
    expect(
      resolveClass({ ...tag, trigger: { kind: "tag-push", protectedTag: false } }, {}),
    ).not.toMatchObject({
      class: "release",
    });
    expect(resolveClass({ ...tag, run: "lint" }, {})).not.toMatchObject({ class: "release" });
    // A run default, a policy rule and a class input never reach release.
    const raised = {
      ...pr,
      run: "nightly",
      trigger: { kind: "cron" as const },
      qosClass: "release" as const,
      qosCeiling: "release" as const,
    };
    expect(
      resolveClass(raised, rules({ match: {}, class: "release", liftsCeiling: true })).class,
    ).not.toBe("release");
    const deploy: ClassRequest = {
      ...pr,
      run: "worker-deploy",
      deployBranch: "main",
      trigger: { kind: "actions-dispatch", oidcRef: "refs/heads/main", protectedBranch: true },
    };
    expect(resolveClass(deploy, {}).class).toBe("release");
    expect(
      resolveClass({ ...deploy, trigger: { kind: "follow-on", parentClass: "release" } }, {}).class,
    ).toBe("release");
  });

  it("[FD-PROF-013] a gating run is required when the target branch requires its check, interactive when not", () => {
    expect(resolveClass(pr, required).class).toBe("required");
    expect(resolveClass(pr, notRequired).class).toBe("interactive");
    expect(resolveClass({ ...pr, trigger: { kind: "merge_group" } }, required).class).toBe(
      "required",
    );
    const queue: ClassRequest = {
      ...pr,
      trigger: {
        kind: "push",
        branch: "gh-readonly-queue/main/pr-7",
        protectedBranch: false,
        defaultBranch: false,
      },
    };
    expect(resolveClass(queue, required).class).toBe("required");
    // Whatever its run default.
    expect(resolveClass({ ...pr, qosClass: "interactive" }, required).class).toBe("required");
  });

  it("[FD-PROF-015] a snapshot unavailable with timeout or server-error counts as required", () => {
    expect(resolveClass(pr, unavailable("timeout")).class).toBe("required");
    expect(resolveClass(pr, unavailable("server-error")).class).toBe("required");
  });

  it("[FD-PROF-016] a forbidden snapshot takes the run default and raises ruleset-permission", () => {
    expect(resolveClass(pr, unavailable("forbidden"))).toEqual({
      class: "batch",
      labels: [],
      alarm: "ruleset-permission",
    });
  });

  it("[FD-PROF-017] a rule lowers any class and raises only to a verified required within the ceiling", () => {
    expect(
      resolveClass(pr, { ...required, ...rules({ match: { run: "check" }, class: "batch" }) })
        .class,
    ).toBe("batch");
    const lint = { ...pr, run: "lint", trigger: { kind: "cron" as const } };
    expect(resolveClass(lint, rules({ match: { run: "lint" }, class: "required" })).class).toBe(
      "batch",
    );
    const capped = { ...pr, qosCeiling: "interactive" as const, qosClass: "interactive" as const };
    expect(
      resolveClass(capped, { ...required, ...rules({ match: {}, class: "required" }) }).class,
    ).toBe("interactive");
    expect(
      resolveClass(capped, {
        ...required,
        ...rules({ match: {}, class: "required", liftsCeiling: true }),
      }).class,
    ).toBe("required");
  });

  it("[FD-PROF-018] caps the run default at its ceiling; a run that declares no class is batch and local-only", () => {
    const run = { ...pr, run: "nightly", trigger: { kind: "cron" as const } };
    expect(resolveClass({ ...run, qosClass: "required", qosCeiling: "interactive" }, {})).toEqual({
      class: "interactive",
      labels: [],
      alarm: null,
    });
    const { qosClass: _q, ...undeclared } = run;
    expect(resolveClass(undeclared, {})).toEqual({
      class: "batch",
      labels: ["local-only"],
      alarm: null,
    });
  });

  it("[FD-PROF-019] a child takes the lower of its parent's class and its own", () => {
    expect(resolveClass({ ...pr, parentClass: "interactive" }, required).class).toBe("interactive");
    expect(resolveClass({ ...pr, parentClass: "release" }, required).class).toBe("required");
  });

  it("[FD-PROF-020] a class input lowers freely and raises only as a rule allows the caller, logging the clamp", () => {
    const dispatch: ClassRequest = {
      ...pr,
      run: "nightly",
      trigger: { kind: "actions-dispatch", oidcRef: "refs/heads/main", protectedBranch: true },
      qosClass: "batch",
      caller: {
        identity: "repo:acme/app",
        repository: "acme/app",
        workflowRef: "ci.yml",
        protectedBranch: true,
      },
    };
    expect(
      resolveClass({ ...dispatch, qosClass: "interactive", classInput: "batch" }, {}).class,
    ).toBe("batch");
    expect(resolveClassDetailed({ ...dispatch, classInput: "required" }, {})).toMatchObject({
      class: "batch",
      clamped: { requested: "required", assigned: "batch" },
    });
    const allow: PolicyRule = {
      match: { run: "nightly" },
      class: "interactive",
      callers: [{ identity: "repo:acme/app", repository: "acme/app", workflowRef: "ci.yml" }],
    };
    // The rule's class lowers the run itself to interactive; a lower default stays and the input raises to it.
    expect(
      resolveClassDetailed(
        { ...dispatch, classInput: "required" },
        rules({ ...allow, class: "batch" }),
      ),
    ).toMatchObject({
      class: "batch",
    });
    expect(
      resolveClassDetailed(
        { ...dispatch, qosClass: "batch", classInput: "required" },
        rules({ ...allow, match: { run: "nightly", label: "never" } }, allow),
      ),
    ).toMatchObject({
      class: "interactive",
      clamped: { requested: "required", assigned: "interactive" },
    });
    // Off a protected branch no rule allows a raise.
    expect(
      resolveClass(
        {
          ...dispatch,
          classInput: "required",
          caller: { ...dispatch.caller!, protectedBranch: false },
        },
        rules({ ...allow, match: { run: "other" } }, allow),
      ).class,
    ).not.toBe("required");
  });

  it("[FD-PROF-021] a pull-request label never raises a class above interactive", () => {
    const labelled = { ...pr, labels: ["urgent"] };
    expect(
      resolveClass(labelled, {
        ...notRequired,
        ...rules({ match: { label: "urgent" }, class: "required" }),
      }).class,
    ).toBe("interactive");
    // A label-matched rule does not lift the ceiling of a verified required check.
    expect(
      resolveClass(
        { ...labelled, qosCeiling: "interactive" },
        {
          ...required,
          ...rules({ match: { label: "urgent" }, class: "required", liftsCeiling: true }),
        },
      ).class,
    ).toBe("interactive");
    const lint = { ...labelled, run: "lint", trigger: { kind: "pull_request" as const } };
    expect(resolveClass(lint, rules({ match: { label: "urgent" }, class: "required" })).class).toBe(
      "batch",
    );
  });

  it("[FD-PROF-022] a check re-run takes the class of its family's first attempt", () => {
    expect(
      resolveClass({ ...pr, rerun: { firstAttemptClass: "interactive" } }, required).class,
    ).toBe("interactive");
  });

  it("[FD-PROF-023] a required check that calls hosted models under a lower ceiling returns the ceiling and an alarm", () => {
    expect(
      resolveClass({ ...pr, qosCeiling: "interactive", hostedModelCalls: true }, required),
    ).toEqual({
      class: "interactive",
      labels: [],
      alarm: "required-check-clamped",
    });
    expect(resolveClass({ ...pr, qosCeiling: "interactive" }, required).alarm).toBeNull();
  });

  it("[FD-PROF-024] a fork pull request carries untrusted-input", () => {
    expect(resolveClass({ ...pr, trigger: { kind: "fork-pr" } }, required)).toEqual({
      class: "required",
      labels: ["untrusted-input"],
      alarm: null,
    });
  });
});

describe("protection snapshot cache", () => {
  it("[FD-PROF-014] holds a branch's required set at most 10 min and drops it on a protection webhook", () => {
    const cache = new ProtectionSnapshotCache();
    cache.put("acme/app", "main", { requiredChecks: ["ci"] }, 0);
    expect(cache.get("acme/app", "main", PROTECTION_TTL_MS - 1)).toEqual({
      requiredChecks: ["ci"],
    });
    expect(cache.get("acme/app", "main", PROTECTION_TTL_MS)).toBeUndefined();
    cache.put("acme/app", "main", { requiredChecks: ["ci"] }, 0);
    cache.put("acme/other", "main", { requiredChecks: ["ci"] }, 0);
    expect(cache.onWebhook("push", "acme/app")).toBe(false);
    expect(cache.onWebhook("repository_ruleset", "acme/app")).toBe(true);
    expect(cache.get("acme/app", "main", 1)).toBeUndefined();
    expect(cache.get("acme/other", "main", 1)).toBeDefined();
    cache.put("acme/app", "dev", { requiredChecks: [] }, 0);
    cache.onWebhook("branch_protection_rule", "acme/app");
    expect(cache.get("acme/app", "dev", 1)).toBeUndefined();
  });
});

describe("dedup recipes and supersession", () => {
  it("[FD-PROF-026] idempotency-key, follow-on, then the total commit recipe; a reused key with another body conflicts", async () => {
    expect(profile.dedup_recipes).toEqual([
      {
        name: "idempotency-key",
        binding: "idempotencyKeyRecipe",
        digest: "dispatchBodyDigest",
        on_mismatch: "conflict",
      },
      { name: "follow-on", binding: "followOnRecipe" },
      { name: "commit", binding: "commitRecipe", total: true },
    ]);
    expect(idempotencyKeyRecipe({ ...pr, idempotencyKey: "deploy:42" })).toBe(
      "idem:acme/app:deploy:42",
    );
    expect(idempotencyKeyRecipe({ ...pr, idempotencyKey: "has space" })).toBeNull();
    expect(idempotencyKeyRecipe({ ...pr, idempotencyKey: "x".repeat(129) })).toBeNull();
    expect(idempotencyKeyRecipe(pr)).toBeNull();
    expect(followOnRecipe({ ...pr, followOn: { executionId: "e1", intentKey: "k" } })).toBe("e1/k");
    expect(commitRecipe({ ...pr, label: "linux" })).toBe("check:linux:acme/app:abc123");
    expect(await dedupKey(dedupRecipes, pr)).toMatchObject({
      recipe: "commit",
      canonical: "check:acme/app:abc123",
    });
    // One run on one commit is one key across trigger kinds.
    expect(commitRecipe({ ...pr, trigger: { kind: "mcp" } })).toBe(commitRecipe(pr));
  });

  it("[FD-PROF-027] supersessionKey keys a superseding pull-request request by repository, number, run and label", () => {
    expect(supersessionKey(pr)).toBe("acme/app:7:check");
    expect(supersessionKey({ ...pr, label: "linux" })).toBe("acme/app:7:check:linux");
    expect(supersessionKey({ ...pr, run: "nightly" })).toBeNull();
    expect(supersessionKey({ ...pr, trigger: { kind: "cron" } })).toBeNull();
  });

  it("[FD-PROF-028] check, oxlint, offload-test and pr-review supersede", () => {
    for (const run of ["check", "oxlint", "offload-test", "pr-review"])
      expect(supersessionKey({ ...pr, run })).not.toBeNull();
  });

  it("[FD-PROF-029] a check re-run cancels no member of its group", () => {
    expect(supersessionKey({ ...pr, rerun: { firstAttemptClass: "required" } })).toBeNull();
  });
});
