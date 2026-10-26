import { reclaimPolicyFor } from "@fractalboxdev/mameko-kernel";
import { ConfigurationSource } from "@fractalboxdev/mameko-ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  classNamed,
  cloudEligibleAt,
  ConfigurationSourceLive,
  deliveryOrder,
  deviceSlotDefaults,
  drawsReserve,
  eligibleKinds,
  lifecycleKey,
  loadProfile,
  profile as committed,
  profileDocument,
  acceptanceReasonKinds,
  spendDefaults,
  staleAt,
  validateProfile,
  type PlacementRequest,
  type Profile,
} from "./index.ts";

const profile = Effect.runSync(loadProfile(profileDocument));
const cls = (name: string) => {
  const c = classNamed(profile, name);
  if (c === undefined) throw new Error(`no class ${name}`);
  return c;
};
const kinds = (r: PlacementRequest) => eligibleKinds(profile, r).kinds;
const CLASSES = ["release", "required", "interactive", "batch"] as const;
const rejections = (document: unknown, policyVersion = committed.policy_version) =>
  Effect.runSync(Effect.flip(loadProfile({ document, policyVersion }))).rejections;
const mutate = (f: (doc: Profile) => Profile) => f(structuredClone(committed));

describe("load", () => {
  it("MAMEKO-PROF-002 the configuration source delivers one document at one policy version", () => {
    const delivered = Effect.runSync(
      Effect.provide(
        Effect.gen(function* () {
          const source = yield* ConfigurationSource;
          return yield* source.load;
        }),
        ConfigurationSourceLive,
      ),
    );
    expect(delivered.policyVersion).toBe("flare-dispatch.v2.0");
    expect(Effect.runSync(loadProfile(delivered))).toEqual(committed);
  });

  it("MAMEKO-PROF-001 rejects a property the schema does not declare, at the top or nested", () => {
    expect(rejections({ ...committed, extra_item: [] }).map((r) => r.item)).toEqual(["document"]);
    const nested = mutate((d) => ({
      ...d,
      classes: d.classes.map((c, i) => (i === 0 ? { ...c, colour: "red" } : c)),
    }));
    expect(rejections(nested).map((r) => r.item)).toEqual(["document"]);
  });

  it("MAMEKO-PROF-001 decodes the line and predicate encodings, rejecting malformed predicates", () => {
    const withPinned = (cloud_pinned: unknown) =>
      rejections({ ...committed, placement: { ...committed.placement, cloud_pinned } });
    for (const bad of [{}, { class: "release", label: "x" }, { colour: "red" }, { not: {} }])
      expect(withPinned(bad).map((r) => r.item)).toEqual(["document"]);
    // `{ any: [] }` holds for nothing, and decodes.
    const none = mutate((d) => ({
      ...d,
      placement: { ...d.placement, cloud_pinned: { any: [] } },
    }));
    expect(
      Effect.runSync(loadProfile({ document: none, policyVersion: none.policy_version })).placement
        .cloud_pinned,
    ).toEqual({ any: [] });
    const badLine: unknown = {
      ...committed,
      classes: committed.classes.map((c, i): unknown =>
        i === 0 ? { ...c, line: "everything" } : c,
      ),
    };
    expect(rejections(badLine).map((r) => r.item)).toEqual(["document"]);
  });

  it("FD-PROF-032 FD-PROF-034 pool and browser-session caps per class", () => {
    expect(
      profile.pools.map((p) => [p.name, p.classes.map((c) => [c.class, c.max, c.min])]),
    ).toEqual([
      [
        "lean",
        [
          ["batch", 4, 0],
          ["interactive", 8, 0],
        ],
      ],
      [
        "agent",
        [
          ["batch", 6, 0],
          ["interactive", 6, 0],
          ["required", 8, 2],
        ],
      ],
      [
        "browser",
        [
          ["batch", 4, 0],
          ["interactive", 10, 0],
          ["required", 16, 2],
        ],
      ],
      ["release", []],
      ["control", []],
    ]);
    expect(profile.pools.find((p) => p.name === "release")?.reserved_for).toBe("release");
    expect(profile.browser_sessions.classes.map((c) => [c.class, c.max, c.min])).toEqual([
      ["batch", 1, 0],
      ["interactive", 2, 0],
      ["required", 10, 1],
    ]);
  });

  it("MAMEKO-LEASE-090 the profile declares provenance, the acceptance check's reason kind, in category policy", () => {
    expect(profile.reason_kinds).toEqual({ provenance: "policy" });
    expect(acceptanceReasonKinds).toEqual(["provenance"]);
  });

  it("MAMEKO-PROF-032 every terminal reason and acceptance-check reason kind is built in or declared", () => {
    expect(validateProfile(profile).filter((r) => r.item === "reason_kinds")).toEqual([]);
    const undeclared = mutate(({ reason_kinds: _, ...d }) => d);
    expect(rejections(undeclared)).toEqual([
      {
        item: "reason_kinds",
        path: "reason_kinds.provenance",
        reason: "undeclared reason kind provenance",
      },
    ]);
    const redefined = mutate((d) => ({
      ...d,
      reason_kinds: { ...d.reason_kinds, budget: "policy" },
    }));
    expect(rejections(redefined).map((r) => r.reason)).toEqual([
      "redefines the built-in reason kind budget",
    ]);
  });

  it("rejects a document whose policy version differs from the delivered one", () => {
    expect(rejections(committed, "flare-dispatch.v2.1").map((r) => r.path)).toEqual([
      "policy_version",
    ]);
  });

  it("reports every rejection, not only the first", () => {
    const doc = mutate((d) => ({
      ...d,
      classes: d.classes.map((c) =>
        c.name === "batch" ? { ...c, rank: 7, reserve: "measured" } : c,
      ),
    }));
    const paths = rejections(doc).map((r) => r.path);
    expect(paths).toContain("classes[].rank");
    expect(paths).toContain("classes[].reserve");
  });

  it("rejects a lifecycle kind without a payload binding", () => {
    const doc = mutate((d) => {
      const { payload: _, ...open } = d.intent_kinds["check.open"]!;
      return { ...d, intent_kinds: { ...d.intent_kinds, "check.open": open } };
    });
    expect(rejections(doc).map((r) => r.path)).toEqual(["intent_kinds.check.open.payload"]);
  });

  it("rejects a Cloudflare runtime feature under host-node", () => {
    const doc = mutate((d) => ({ ...d, host: { ...d.host, adapter: "host-node" as const } }));
    expect(rejections(doc).every((r) => r.item === "host")).toBe(true);
  });
});

describe("class catalogue", () => {
  it("FD-PROF-003 four classes, release P0 to batch P3, in a strict rank order", () => {
    expect(profile.classes.map((c) => [c.name, c.rank])).toEqual(CLASSES.map((n, i) => [n, i]));
    expect(profile.classes.every((c) => c.guaranteed)).toBe(true);
    expect(profile.classes.filter((c) => c.firm === true).map((c) => c.name)).toEqual(["required"]);
  });

  it("lists gha last in every class's cloud kinds", () => {
    for (const c of profile.classes) expect(c.cloud_kinds.at(-1)).toBe("gha");
    expect(cls("required").cloud_kinds).toEqual(["cloudflare", "aws", "gha"]);
    expect(cls("interactive").cloud_kinds).toEqual(["cloudflare", "gha"]);
  });

  it("FD-PROF-006 queue bounds per class", () => {
    expect(CLASSES.map((n) => cls(n).bounds)).toEqual([
      { global: 16, per_scope: 8 },
      { global: 150, per_scope: 60 },
      { global: 40, per_scope: 10 },
      { global: 30, per_run_scope: 1 },
    ]);
  });

  it("FD-PROF-007 a full release queue raises p0-breach", () => {
    expect(
      profile.classes
        .filter((c) => c.queue_full_alarm !== undefined)
        .map((c) => [c.name, c.queue_full_alarm]),
    ).toEqual([["release", "p0-breach"]]);
  });

  it("FD-PROF-005 queue age: the run's for P0 and P1, 1800 s for P2, the staleness span for P3", () => {
    expect(CLASSES.map((n) => cls(n).queue_age)).toEqual([
      "run",
      "run",
      { seconds: 1800 },
      "staleness",
    ]);
  });

  it("FD-PROF-004 stale_at is half the schedule period, or 12 h without a schedule", () => {
    expect(staleAt(cls("batch"), 1_000, 3_600_000)).toBe(1_000 + 1_800_000);
    expect(staleAt(cls("batch"), 1_000, null)).toBe(1_000 + 43_200_000);
  });

  it("FD-PROF-008 release ends failure, budget: release reserve exhausted", () => {
    expect(cls("release").terminal_outcome).toEqual({
      outcome: "failure",
      reason: "budget: release reserve exhausted",
    });
    expect(cls("required").terminal_outcome).toEqual({
      outcome: "failure",
      reason: "budget: required reserve exhausted",
    });
    expect(cls("interactive").terminal_outcome).toEqual({ outcome: "failure", reason: "budget" });
  });

  it("MAMEKO-ADM-059 batch ends deferred", () => {
    expect(cls("batch").terminal_outcome).toBe("deferred");
  });

  it("MAMEKO-ADM-073 only interactive and batch are sheddable", () => {
    expect(profile.classes.filter((c) => c.sheddable === true).map((c) => c.name)).toEqual([
      "interactive",
      "batch",
    ]);
  });

  it("FD-PROF-009 retries: the run's for P0, once for P1 and P2, never in the cloud for P3", () => {
    expect(CLASSES.map((n) => cls(n).retries)).toEqual(["run", 1, 1, "local-only"]);
  });

  it("MAMEKO-SPD-006 lines nest from the budget down to a share of the general band", () => {
    expect(CLASSES.map((n) => cls(n).line)).toEqual([
      "budget",
      "next-above-less-reserve",
      "next-above-less-reserve",
      { general_band_ratio: 0.45, floor_ratio: 0.1 },
    ]);
  });

  it("FD-PROF-054 reserves: a configured release reserve and the measured required reserve", () => {
    expect(cls("release").reserve).toBe("release-reserve");
    expect(cls("required").reserve).toBe("measured");
    expect(spendDefaults.reserves["release-reserve"]).toBe(10_000_000);
    expect(spendDefaults.budget).toBe(50_000_000);
  });

  it("every class reclaims with restart", () => {
    for (const n of CLASSES) expect(reclaimPolicyFor(profile.reclaim_policy, n)).toBe("restart");
  });
});

describe("delayed cloud claim", () => {
  const at = (name: string, request: Partial<PlacementRequest>, predictedMiss = false) =>
    cloudEligibleAt({
      cls: cls(name),
      eligible: kinds({ class: name, labels: [], ...request }),
      predictedMiss,
      now: 1_000,
      staleAt: 99_000,
    });

  it("MAMEKO-LEASE-019 release joins the cloud queue at admission", () => {
    expect(at("release", {})).toBe(1_000);
  });

  it("MAMEKO-LEASE-021 batch joins the cloud queue at stale_at", () => {
    expect(at("batch", {})).toBe(99_000);
  });

  it("FD-PROF-004 interactive waits 300 s for a device claim", () => {
    expect(at("interactive", {})).toBe(301_000);
  });

  it("FD-PROF-004 required waits 60 s for a device claim", () => {
    expect(at("required", {})).toBe(61_000);
  });

  it("MAMEKO-LEASE-022 a predicted miss opens the cloud entry at admission", () => {
    expect(at("required", {}, true)).toBe(1_000);
    expect(at("interactive", {}, true)).toBe(1_000);
  });

  it("MAMEKO-LEASE-023 no cloud kind left means no cloud entry", () => {
    expect(at("required", { confidentiality: "confidential-compute" })).toBeNull();
    expect(at("batch", { declaresClass: false })).toBeNull();
  });
});

describe("placement", () => {
  it("FD-PROF-018 a run that declares no class is local-only", () => {
    const r = eligibleKinds(profile, { class: "batch", labels: [], declaresClass: false });
    expect(r.kinds).toEqual(["device"]);
    expect(r.constraints).toContain("local-only");
  });

  it("FD-PROF-037 no device for a fork pull request, a release tag push or release", () => {
    for (const c of CLASSES) {
      expect(kinds({ class: c, labels: ["untrusted-input"] })).not.toContain("device");
      expect(kinds({ class: c, labels: [], trigger: "tag-push" })).not.toContain("device");
    }
    expect(kinds({ class: "release", labels: [] })).not.toContain("device");
  });

  it("MAMEKO-ADM-009 confidential-compute leaves only device", () => {
    for (const c of ["required", "interactive", "batch"])
      expect(kinds({ class: c, labels: [], confidentiality: "confidential-compute" })).toEqual([
        "device",
      ]);
  });

  it("FD-PROF-037 release runs only on cloudflare, a macOS release-matrix job only on gha", () => {
    expect(kinds({ class: "release", labels: [] })).toEqual(["cloudflare"]);
    expect(kinds({ class: "release", labels: ["release-matrix"] })).toEqual(["gha"]);
  });

  it("MAMEKO-ADM-012 expose-port leaves at most cloudflare", () => {
    for (const c of CLASSES)
      expect(kinds({ class: c, labels: ["expose-port"] })).toEqual(["cloudflare"]);
  });

  it("FD-PROF-040 apple-build runs on a device, or on gha for required and a release-matrix job", () => {
    expect(kinds({ class: "required", labels: ["apple-build"] })).toEqual(["gha", "device"]);
    expect(kinds({ class: "interactive", labels: ["apple-build"] })).toEqual(["device"]);
    expect(kinds({ class: "batch", labels: ["apple-build"] })).toEqual(["device"]);
    expect(kinds({ class: "interactive", labels: ["apple-build", "release-matrix"] })).toEqual([
      "gha",
    ]);
  });

  it("MAMEKO-ADM-015 confidential-compute with a fork pull request, a tag push or release is unplaceable", () => {
    const cc = { confidentiality: "confidential-compute" } as const;
    expect(kinds({ class: "required", labels: ["untrusted-input"], ...cc })).toEqual([]);
    expect(kinds({ class: "required", labels: [], trigger: "tag-push", ...cc })).toEqual([]);
    expect(kinds({ class: "release", labels: [], ...cc })).toEqual([]);
    expect(kinds({ class: "required", labels: [], ...cc })).not.toEqual([]);
  });

  it("FD-PROF-039 a macOS release-matrix job keeps exactly gha at every class", () => {
    for (const c of CLASSES)
      expect(kinds({ class: c, labels: ["release-matrix"] })).toEqual(["gha"]);
    expect(kinds({ class: "release", labels: ["release-matrix"], trigger: "tag-push" })).toEqual([
      "gha",
    ]);
  });

  it("FD-PROF-039 the validator rejects a release matrix whose macOS jobs have no eligible kind", () => {
    const doc = mutate((d) => ({
      ...d,
      classes: d.classes.map((c) =>
        c.name === "interactive" ? { ...c, cloud_kinds: ["cloudflare"] } : c,
      ),
    }));
    expect(rejections(doc)).toEqual([
      {
        item: "placement",
        path: "placement.required[0]",
        reason: "required placement unplaceable for class interactive",
      },
    ]);
  });

  it("FD-PROF-041 reproduction runs only on an attested-dedicated device", () => {
    const r = eligibleKinds(profile, { class: "required", labels: ["reproduction"] });
    expect(r.kinds).toEqual(["device"]);
    expect(r.requiresPosture).toBe("attested-dedicated");
  });

  it("registers gha as the one launcher kind and pins cloud-pinned to cloudflare", () => {
    expect(profile.placement.launcher_kinds).toEqual(["gha"]);
    expect(profile.placement.cloud_pinned_kinds).toEqual(["cloudflare"]);
    expect(profile.placement.unreachable.map((s) => s.labels)).toEqual([
      ["reproduction", "untrusted-input"],
      ["reproduction", "cloud-only"],
      ["reproduction", "expose-port"],
      ["apple-build", "expose-port"],
    ]);
  });

  it("FD-PROF-035 FD-PROF-036 device slot defaults on an 8-slot share", () => {
    expect(deviceSlotDefaults).toEqual({
      total: 8,
      headroom: 2,
      claim_caps: { interactive: 3, batch: 5, interactive_and_batch: 6 },
    });
  });
});

describe("check-run lifecycle kinds", () => {
  const kind = (k: string) => {
    const entry = profile.intent_kinds[k];
    if (entry === undefined) throw new Error(`no kind ${k}`);
    return entry;
  };

  it("FD-GH-005 check.open is generated at admission under cp:check:open and opens the surface", () => {
    const open = kind("check.open");
    expect(open.on).toBe("admitted");
    expect(open.opens_surface).toBe(true);
    expect(lifecycleKey("check.open", "admitted", 1)).toBe("cp:check:open");
  });

  it("FD-GH-011 check.start is generated at every lease grant under cp:check:start:<epoch>", () => {
    expect(kind("check.start").on).toBe("lease-granted");
    expect(lifecycleKey("check.start", "lease-granted", 2)).toBe("cp:check:start:2");
  });

  it("FD-GH-012 check.progress is generated on progress and coalesces per execution", () => {
    expect(kind("check.progress")).toMatchObject({
      on: "progress",
      payload: "checkProgressPayload",
      coalesce_key: "executionProgressKey",
      delivery_tier: "progress",
    });
    const doc = mutate((d) => {
      const { coalesce_key: _, ...progress } = d.intent_kinds["check.progress"]!;
      return { ...d, intent_kinds: { ...d.intent_kinds, "check.progress": progress } };
    });
    expect(rejections(doc).map((r) => r.path)).toEqual([
      "intent_kinds.check.progress.coalesce_key",
    ]);
  });

  it("MAMEKO-OUT-044, MAMEKO-OUT-059, MAMEKO-OUT-060 check kinds apply in insertion order; start and progress void after the outcome", () => {
    const checks = ["check.open", "check.start", "check.progress", "check.conclude"];
    for (const k of checks) expect(kind(k).in_order).toBe(true);
    expect(checks.filter((k) => kind(k).void_after_outcome === true)).toEqual([
      "check.start",
      "check.progress",
    ]);
    expect(kind("check.summary").in_order).toBeUndefined();
    expect(kind("check.annotations").in_order).toBeUndefined();
  });

  it("FD-GH-058 only check.open and check.conclude draw the rate limit's reserve", () => {
    const drawing = Object.entries(profile.intent_kinds)
      .filter(([, e]) => drawsReserve(e))
      .map(([k]) => k);
    expect(drawing.sort()).toEqual(["check.conclude", "check.open"]);
  });

  it("MAMEKO-OUT-042 permit order: check.conclude, check.open, check.start, the other kinds, check.progress", () => {
    const ordered = Object.entries(profile.intent_kinds)
      .sort(([, a], [, b]) => {
        const [ta, pa] = deliveryOrder(a);
        const [tb, pb] = deliveryOrder(b);
        return ta - tb || pa - pb;
      })
      .map(([k]) => k);
    expect(ordered.slice(0, 3)).toEqual(["check.conclude", "check.open", "check.start"]);
    expect(ordered.at(-1)).toBe("check.progress");
  });

  it("only check.conclude carries the outcome; pr.propose follows an accepted success", () => {
    expect(
      Object.entries(profile.intent_kinds)
        .filter(([, e]) => e.delivery_tier === "outcome")
        .map(([k]) => k),
    ).toEqual(["check.conclude"]);
    expect(kind("pr.propose")).toMatchObject({
      origin: "control-plane",
      on: "accepted",
      applied_for: ["success"],
    });
  });

  it("no kind is reconcile-only or gated, and the ops kinds take the required class", () => {
    const entries = Object.values(profile.intent_kinds);
    expect(entries.some((e) => e.effect_class === "reconcile-only" || e.gated === true)).toBe(
      false,
    );
    expect(
      Object.entries(profile.intent_kinds)
        .filter(([, e]) => e.ops === true)
        .map(([k]) => k),
    ).toEqual(["canary.push", "delivery.redeliver"]);
    expect(profile.delivery.ops_class).toBe("required");
    expect(profile.delivery.undelivered_alarm).toBe("undelivered-verdict");
  });
});
