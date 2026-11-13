import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { validationContext } from "./registry.ts";
import {
  buildProfile,
  configurationSourceLayer,
  CURRENT_PHASE,
  developmentRuntimeFields,
  DEVICE_CLASSES,
  isolationOf,
  loadProfile,
  profile,
  profileDocumentFor,
  profileLoader,
  projectForReference,
  referenceProfile,
  spendConfigWith,
  spendDefaults,
  spendSettings,
  unlistedDifferences,
  type Phase,
} from "./index.ts";
import { ConfigurationSource } from "@fractalboxdev/mameko-ports";

const PHASES: readonly Phase[] = [0, 1, 2, 3, 4];

describe("profile document", () => {
  it("[FD-PROF-001] the configuration source delivers buildProfile at its policy version, production by default", () => {
    const delivered = Effect.runSync(
      Effect.gen(function* () {
        return yield* (yield* ConfigurationSource).load;
      }).pipe(Effect.provide(configurationSourceLayer("production"))),
    );
    expect(delivered.document).toEqual(buildProfile("production", CURRENT_PHASE));
    expect(delivered.policyVersion).toBe("flare-dispatch.v2.0");
    expect(profile).toEqual(buildProfile("production"));
  });

  it("[FD-PROF-002] [FD-VER-033] the production document of each phase differs from the reference only as listed", () => {
    for (const phase of PHASES)
      expect(unlistedDifferences(buildProfile("production", phase), phase)).toEqual([]);
  });

  it("[FD-PROF-002] the comparison fails on a difference the list does not hold", () => {
    const base = buildProfile("production", 4);
    const drifted = {
      ...base,
      classes: base.classes.map((c) => (c.name === "interactive" ? { ...c, retries: 2 } : c)),
    };
    expect(unlistedDifferences(drifted, 4)).toEqual([
      { path: "classes.interactive.retries", reference: 1, flareDispatch: 2 },
    ]);
    const marker = projectForReference(buildProfile("production", 4));
    expect(marker["intent_kinds"]).toBeDefined();
    expect(referenceProfile["member_partition"]).toBe(true);
  });
});

describe("class catalogue values", () => {
  it("[FD-PROF-010] only interactive and batch are sheddable, and every class reclaims with restart", () => {
    expect(profile.classes.filter((c) => c.sheddable).map((c) => c.name)).toEqual([
      "interactive",
      "batch",
    ]);
    expect(profile.reclaim_policy).toEqual({
      release: "restart",
      required: "restart",
      interactive: "restart",
      batch: "restart",
    });
  });

  it("[FD-PROF-031] member_partition is true", () => {
    expect(profile.member_partition).toBe(true);
  });

  it("[FD-PROF-030] the profile declares pr-closed and merge-group-destroyed as its cancel causes", () => {
    expect(profile.outcome_mapping.cancel_causes).toEqual(["pr-closed", "merge-group-destroyed"]);
    expect(profile.outcome_mapping.by_outcome["pr-closed"]).toBe("cancelled");
    expect(profile.outcome_mapping.by_outcome["merge-group-destroyed"]).toBe("cancelled");
  });
});

describe("outcome mapping", () => {
  it("[FD-PROF-044] surface and silent values, the listed details, and no capacity outcome concludes neutral", () => {
    const m = profile.outcome_mapping;
    expect(m.surface_values).toEqual(["success", "failure", "cancelled", "neutral"]);
    expect(m.silent_values).toEqual(["neutral"]);
    expect(m.surface_kind).toBe("check.conclude");
    expect(m.not_applicable_details).toEqual([
      "draft-pr",
      "author-excluded",
      "path-filter",
      "not-configured",
      "nothing-to-lint",
      "every-job-skipped",
      "empty-range",
    ]);
    for (const c of ["budget", "capacity", "deadline", "halt", "placement", "finding", "infra"])
      expect(m.by_outcome[c]).toBe("failure");
    const neutral = Object.entries(m.by_outcome).filter(([, v]) => v === "neutral");
    expect(neutral).toEqual([["skipped-listed", "neutral"]]);
    expect(m.by_outcome["skipped-other"]).toBe("failure");
    expect(m.by_outcome["expired"]).toBe("failure");
  });

  it("[FD-PROF-045] deferred maps to failure when a check run opened and to none otherwise", () => {
    expect(profile.outcome_mapping.by_outcome["deferred"]).toEqual({
      opened: "failure",
      unopened: "none",
    });
  });
});

describe("intent kinds, delivery and gate policy", () => {
  it("[FD-PROF-046] the kinds of § Intent kinds with their origin, trigger, priority, flags and applier", () => {
    const k = profile.intent_kinds;
    expect(Object.keys(k).sort()).toEqual(
      [
        "check.open",
        "check.start",
        "check.progress",
        "check.conclude",
        "check.summary",
        "check.annotations",
        "comment",
        "review",
        "issue",
        "pr.propose",
        "release.draft",
        "release.publish",
        "canary.push",
        "delivery.redeliver",
        "label",
        "pr.close",
        "dispatch.followOn",
        "notify.email",
        "notify.slack",
        "notice.publish",
      ].sort(),
    );
    expect(k["check.conclude"]).toMatchObject({
      on: "terminal",
      delivery_tier: "outcome",
      in_order: true,
    });
    expect(k["check.progress"]).toMatchObject({
      on: "progress",
      priority: 0,
      coalesce_key: "executionProgressKey",
    });
    expect(k["check.open"]).toMatchObject({
      priority: 0,
      opens_surface: true,
      draws_reserve: true,
    });
    expect(k["check.start"]).toMatchObject({ priority: 1, on: "lease-granted" });
    for (const name of ["comment", "review", "issue"])
      expect(k[name]?.marker).toBe("<!-- flare-dispatch:intent <execution_id>/<intent_key> -->");
    for (const name of ["canary.push", "delivery.redeliver"]) expect(k[name]?.ops).toBe(true);
    expect(Object.values(k).filter((x) => x.effect_class === "reconcile-only")).toEqual([]);
  });

  it("[FD-PROF-047] delivery keys the rate limit by installation, ops take required, undelivered-verdict", () => {
    expect(profile.delivery).toEqual({
      limit_key: "installationOf",
      ops_class: "required",
      undelivered_alarm: "undelivered-verdict",
    });
  });

  it("[FD-PROF-048] gate_policy lists no key, caps expiry at 86400 s, and no kind is gated", () => {
    expect(profile.gate_policy).toEqual({ keys: [], max_expiry_seconds: 86_400 });
    expect(Object.values(profile.intent_kinds).some((x) => x.gated === true)).toBe(false);
  });

  it("[FD-PROF-062] cacheNamespaces and capacityGrant are the cache and capacity bindings", () => {
    expect(profile.cache_namespaces).toBe("cacheNamespaces");
    expect(profile.capacity).toEqual({ grant: "capacityGrant" });
  });
});

describe("development runtime", () => {
  it("[FD-PROF-065] production omits development_runtime and every class's isolation", () => {
    for (const phase of PHASES) {
      expect(buildProfile("production", phase).development_runtime).toBeUndefined();
      expect(
        buildProfile("production", phase).classes.every((c) => c.isolation === undefined),
      ).toBe(true);
    }
    expect(developmentRuntimeFields("production")).toEqual({ classIsolation: {} });
  });

  it("[FD-PROF-065] development sets development_runtime and isolation none on required, interactive and batch", () => {
    expect(developmentRuntimeFields("development")).toEqual({
      development_runtime: true,
      classIsolation: { required: "none", interactive: "none", batch: "none" },
    });
    const dev = buildProfile("development", 0);
    expect(dev.development_runtime).toBe(true);
    expect(dev.classes.filter((c) => c.isolation === "none").map((c) => c.name)).toEqual([
      ...DEVICE_CLASSES,
    ]);
    expect(dev.classes.find((c) => c.name === "release")?.isolation).toBeUndefined();
  });

  it("[FD-PROF-065] the development document validates under the vendored mameko", () => {
    const devContext = { ...validationContext, deployment: "development" as const };
    const loaded = Effect.runSync(
      loadProfile(profileLoader(devContext), profileDocumentFor("development")),
    );
    expect(loaded.policy_version).toBe("flare-dispatch.v2.0-dev");
    expect(loaded.development_runtime).toBe(true);
  });
});

describe("placement isolation", () => {
  const trusted = {
    untrustedInput: false,
    confidentiality: "non-confidential",
    declaresGrant: false,
  } as const;

  it("[FD-PROF-065] a development device class admits isolation none only for trusted, non-confidential, grant-free work", () => {
    const dev = buildProfile("development");
    expect(isolationOf(dev, { class: "batch", ...trusted })).toBe("none");
    expect(isolationOf(dev, { class: "batch", ...trusted, untrustedInput: true })).toBe("container");
    expect(isolationOf(dev, { class: "batch", ...trusted, confidentiality: "unclassified" })).toBe(
      "container",
    );
    expect(isolationOf(dev, { class: "batch", ...trusted, declaresGrant: true })).toBe("container");
    expect(isolationOf(dev, { class: "release", ...trusted })).toBe("vm");
  });

  it("[FD-PROF-065] production places every class at vm", () => {
    for (const c of profile.classes)
      expect(isolationOf(profile, { class: c.name, ...trusted })).toBe("vm");
  });
});

describe("spend configuration", () => {
  it("[FD-PROF-054] [FD-PROF-055] each overlay value replaces its default, and the overhead factor defaults to 1.1", () => {
    expect(spendConfigWith()).toEqual(spendDefaults);
    expect(spendDefaults.overhead_factor).toBe(1.1);
    const s = spendConfigWith({ budget: 80_000_000, reserves: { "release-reserve": 12_000_000 } });
    expect(s.budget).toBe(80_000_000);
    expect(s.reserves["release-reserve"]).toBe(12_000_000);
    expect(s.fixed).toBe(spendDefaults.fixed);
    expect(spendConfigWith({ overhead_factor: 1.25 }).overhead_factor).toBe(1.25);
  });

  it("[FD-PROF-056] [FD-PROF-057] a model id with no price is 75 USD per million tokens; unresolved spend alarms above 5 USD", () => {
    expect(spendSettings.default_model_price_per_mtok).toBe(75_000_000);
    expect(spendSettings.unresolved_threshold).toBe(5_000_000);
  });

  it("[FD-PROF-058] burn lanes of 0.41, 0.81, 2.01 and 2.82 USD per hour", () => {
    expect(spendSettings.burn_lanes_per_hour).toEqual({
      batch: 410_000,
      interactive: 810_000,
      required: 2_010_000,
      release: 2_820_000,
    });
  });

  it("[FD-PROF-059] a firm hold of required looks ahead over 5 queued entries", () => {
    expect(spendSettings.firm_hold_look_ahead).toBe(5);
    expect(Number.isInteger(spendSettings.firm_hold_look_ahead)).toBe(true);
  });

  it("[FD-PROF-060] spend warns at 0.8 of B", () => {
    expect(spendSettings.warn_ratio).toBe(0.8);
  });
});
