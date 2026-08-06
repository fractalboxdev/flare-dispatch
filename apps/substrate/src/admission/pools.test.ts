import { describe, expect, it } from "vitest";
import { SUBSTRATE_RECIPE_KEYS } from "@fractalboxdev/flare-dispatch-substrate-contract";
import type { SubstrateRecipe } from "@fractalboxdev/flare-dispatch-substrate-contract";
import {
  CONTAINERS_CEILING_DEFAULT,
  CONTAINERS_CEILING_POST_ADOPTION,
  POOL_CAPS_DEFAULT,
  POOL_CAPS_POST_ADOPTION,
  POOLS,
  poolPolicyView,
  resolvePoolCaps,
  selectPool,
  validatePoolCaps,
} from "./pools";

describe("pool selection (ADR-0010)", () => {
  it("is policy-selected from the consumer, never from an input field", () => {
    // fractalbot's tasks land on the task image; the dispatcher on lean until
    // its run catalog migrates with per-run class policy.
    expect(selectPool("fractalbot", { version: 1 })).toBe("task");
    expect(selectPool("dispatcher", { version: 1 })).toBe("lean");
    // The recipe carries no field that could steer this — the signature only
    // takes it so future policy can consider reviewed run definitions.
    expect(selectPool("fractalbot", { version: 1, repo: { owner: "a", name: "b" } })).toBe("task");
  });

  it("ignores a pool or image field a consumer invents (#74)", () => {
    // The contract declares neither, so this is what a buggy — or hostile —
    // consumer's payload looks like on the wire. Before the projection the
    // right answer came out because nothing happened to read the field; now it
    // comes out because the field never reaches policy.
    const smuggled = {
      version: 1,
      pool: "agent",
      image: "task",
      instanceType: "standard-4",
    } as unknown as SubstrateRecipe;
    expect(selectPool("dispatcher", smuggled)).toBe("lean");
    expect(selectPool("fractalbot", smuggled)).toBe("task");
  });
});

describe("poolPolicyView — the projection that makes the invariant runtime (#74)", () => {
  it("keeps every declared field and drops everything else", () => {
    const view = poolPolicyView({
      version: 3,
      repo: { owner: "acme", name: "widget", ref: "main" },
      lfs: true,
      profiles: ["public-repo-read"],
      targets: ["app.example.com"],
      enforcement: "report",
      pool: "agent",
    } as unknown as SubstrateRecipe);

    expect(Object.keys(view).sort()).toEqual([...SUBSTRATE_RECIPE_KEYS].sort());
    expect(view.repo).toEqual({ owner: "acme", name: "widget", ref: "main" });
    expect((view as Record<string, unknown>)["pool"]).toBeUndefined();
  });

  it("does not invent fields the recipe left absent", () => {
    // `key in source` rather than a copy of every declared key: a view where
    // `lfs` is present-and-undefined reads differently from one where it is
    // absent, and grant derivation distinguishes the two.
    expect(Object.keys(poolPolicyView({ version: 1 }))).toEqual(["version"]);
  });

  it("is frozen, so policy cannot normalise a recipe in place", () => {
    const view = poolPolicyView({ version: 1 });
    expect(Object.isFrozen(view)).toBe(true);
  });

  it("fails if selectPool starts reading the recipe outside the declared set", () => {
    // The teeth. A refactor that threads `recipe.pool` (or any undeclared
    // field) into selection reads it off the raw object, which this Proxy
    // records — and the assertion below is what turns that into a red test
    // rather than a silently broken invariant with a green build.
    const reads: string[] = [];
    const spy = new Proxy(
      { version: 1, pool: "agent", image: "task" },
      {
        get(target, property, receiver) {
          if (typeof property === "string") reads.push(property);
          return Reflect.get(target, property, receiver);
        },
        has(target, property) {
          if (typeof property === "string") reads.push(property);
          return Reflect.has(target, property);
        },
      },
    ) as unknown as SubstrateRecipe;

    expect(selectPool("fractalbot", spy)).toBe("task");
    const declared = new Set<string>(SUBSTRATE_RECIPE_KEYS);
    expect(reads.filter((key) => !declared.has(key))).toEqual([]);
    // And the projection did run — an empty read list would pass the check
    // above vacuously if `selectPool` stopped taking the recipe at all.
    expect(reads).toContain("version");
  });
});

describe("resolvePoolCaps", () => {
  it("returns the shipped partition when unset", () => {
    expect(resolvePoolCaps(undefined)).toEqual(POOL_CAPS_DEFAULT);
  });

  it("applies a partial override and keeps the rest", () => {
    expect(resolvePoolCaps('{"task": 8}')).toEqual({ ...POOL_CAPS_DEFAULT, task: 8 });
  });

  it("degrades a typo to the default, never to an unmetered pool", () => {
    expect(resolvePoolCaps("not json")).toEqual(POOL_CAPS_DEFAULT);
    expect(resolvePoolCaps('{"task": 0}')).toEqual(POOL_CAPS_DEFAULT);
    expect(resolvePoolCaps('{"task": -2}')).toEqual(POOL_CAPS_DEFAULT);
    expect(resolvePoolCaps('{"task": "lots"}')).toEqual(POOL_CAPS_DEFAULT);
  });
});

describe("validatePoolCaps — the cap-sum guard (ADR-0004)", () => {
  it("accepts the shipped partition under the shipped ceiling", () => {
    const sum = POOLS.reduce((a, p) => a + POOL_CAPS_DEFAULT[p], 0);
    expect(() => validatePoolCaps(POOL_CAPS_DEFAULT, sum)).not.toThrow();
  });

  it("throws when the partition exceeds the ceiling — deploy-time, not 2am", () => {
    expect(() => validatePoolCaps(POOL_CAPS_DEFAULT, 3)).toThrow(/over the Containers ceiling/);
  });

  it("throws on a non-positive pool cap", () => {
    expect(() => validatePoolCaps({ ...POOL_CAPS_DEFAULT, lean: 0 }, 100)).toThrow(/non-positive/);
  });

  it("the post-adoption partition fits the headroom the drain frees", () => {
    // The freed headroom is what the dispatcher's three classes held, not a
    // guess at the account limit — so a partition that fits it can never ask
    // the platform for more than the two fleets already had.
    const sum = POOLS.reduce((a, p) => a + POOL_CAPS_POST_ADOPTION[p], 0);
    expect(sum).toBeLessThanOrEqual(CONTAINERS_CEILING_POST_ADOPTION);
    expect(() =>
      validatePoolCaps(POOL_CAPS_POST_ADOPTION, CONTAINERS_CEILING_POST_ADOPTION),
    ).not.toThrow();
  });

  it("the post-adoption partition does NOT fit today's ceiling — the drain comes first", () => {
    expect(() => validatePoolCaps(POOL_CAPS_POST_ADOPTION, CONTAINERS_CEILING_DEFAULT)).toThrow(
      /over the Containers ceiling/,
    );
  });
});
