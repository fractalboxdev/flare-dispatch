import { describe, expect, it } from "vitest";
import { runNames } from "./registry";
import {
  FLOOR_MIRROR,
  hostMatchesPattern,
  preAssertedApproval,
  resolveTargets,
  RUN_GRANTS,
  runGrant,
  runsOnFacade,
} from "./grant-catalog";

describe("catalog coverage", () => {
  it("carries an entry for every registered run", () => {
    // The assertion that keeps the catalog honest: a run cannot ship without
    // someone deciding what it may reach.
    const missing = runNames().filter((name) => !Object.hasOwn(RUN_GRANTS, name));
    expect(missing).toEqual([]);
  });

  it("carries no entry for a run that does not exist", () => {
    const registered = new Set(runNames());
    const orphans = Object.keys(RUN_GRANTS).filter((name) => !registered.has(name));
    expect(orphans).toEqual([]);
  });

  it("starts every run at legacy — a position is an observation, not an intention", () => {
    for (const [name, grant] of Object.entries(RUN_GRANTS))
      expect(`${name}:${grant.rollout}`).toBe(`${name}:legacy`);
  });

  it("gives an unregistered run the closed default rather than an inherited reach", () => {
    const grant = runGrant("not-a-run");
    expect(grant.profiles).toEqual([]);
    expect(grant.rollout).toBe("legacy");
    expect(grant.preAsserts).toBeUndefined();
  });

  it("names only profiles the substrate's catalog serves", () => {
    const served = new Set([
      "public-repo-read",
      "js-install",
      "rust-install",
      "browser-fetch",
      "cf-api",
      "github-api-read",
    ]);
    for (const grant of Object.values(RUN_GRANTS))
      for (const profile of grant.profiles) expect(served.has(profile)).toBe(true);
  });

  it("names only floor rules the mirror carries", () => {
    for (const grant of Object.values(RUN_GRANTS))
      for (const rule of grant.preAsserts ?? [])
        expect(Object.hasOwn(FLOOR_MIRROR, rule)).toBe(true);
  });
});

describe("facade gaps", () => {
  it("keeps the detached/expose runs off the facade", () => {
    // These need calls ADR-0003 deliberately left out of the boundary; the
    // catalog states that as a fact about the run, not as a weaker grant.
    expect(runsOnFacade("cdp-acceptance")).toBe(false);
    expect(runsOnFacade("product-demo")).toBe(false);
    expect(runsOnFacade("self-heal-pr")).toBe(false);
  });

  it("lets the clone-and-build runs through", () => {
    for (const run of ["offload-test", "check", "oxlint", "pr-review", "worker-deploy"])
      expect(runsOnFacade(run)).toBe(true);
  });
});

describe("hostMatchesPattern", () => {
  it("anchors both ends and matches exactly one label per star", () => {
    expect(hostMatchesPattern("*.workers.dev", "flare-dispatch.workers.dev")).toBe(true);
    expect(hostMatchesPattern("*.workers.dev", "a.b.workers.dev")).toBe(false);
    expect(hostMatchesPattern("*.workers.dev", "evilworkers.dev")).toBe(false);
    expect(hostMatchesPattern("acme.dev", "acme.dev")).toBe(true);
    expect(hostMatchesPattern("acme.dev", "staging.acme.dev")).toBe(false);
  });
});

describe("dynamic targets fail the dispatch, not the policy", () => {
  it("accepts a host inside the declared pattern", () => {
    const resolved = resolveTargets("playwright-e2e", {
      baseURL: "https://preview-7.pages.dev/login",
    });
    expect(resolved).toEqual({ ok: true, hosts: ["preview-7.pages.dev"] });
  });

  it("refuses a host outside it, naming the pattern", () => {
    const resolved = resolveTargets("playwright-e2e", { baseURL: "https://attacker.example/" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toMatch(/outside playwright-e2e's declared pattern/);
  });

  it("refuses http and unparseable targets rather than dropping them", () => {
    expect(resolveTargets("playwright-e2e", { baseURL: "http://preview-7.pages.dev" }).ok).toBe(
      false,
    );
    expect(resolveTargets("playwright-e2e", { baseURL: "not a url" }).ok).toBe(false);
  });

  it("resolves to no targets for a run that declares no schema", () => {
    // An input field a run never declared cannot smuggle a host into the grant.
    expect(resolveTargets("offload-test", { baseURL: "https://attacker.example/" })).toEqual({
      ok: true,
      hosts: [],
    });
  });

  it("dedupes and lowercases", () => {
    expect(resolveTargets("deploy-smoke", { baseURL: "https://Preview-7.Pages.Dev/a" })).toEqual({
      ok: true,
      hosts: ["preview-7.pages.dev"],
    });
  });
});

describe("run-definition approval attestations (ADR-0007)", () => {
  const scope = { taskId: "01JQ", ordinal: 2 };

  it("mints nothing for a command the floor does not match", async () => {
    expect(await preAssertedApproval("offload-test", "pnpm test", scope)).toBeUndefined();
  });

  it("mints for the verb the definition pre-asserts, bound to the exact command", async () => {
    const command = "pnpm build && pnpm exec wrangler deploy";
    const attestation = await preAssertedApproval("worker-deploy", command, scope);
    expect(attestation?.approvedBy).toBe("run-definition");
    expect(attestation?.taskId).toBe("01JQ");
    expect(attestation?.ordinal).toBe(2);
    // The digest is the binding — an approval for one command cannot be
    // replayed onto another.
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(command)),
    );
    expect(attestation?.commandSha256).toBe(
      Array.from(digest)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  });

  it("withholds the attestation when the command grew a verb the definition never vouched for", async () => {
    // The subset test is the point: a config-store deploy command that adds a
    // push mints nothing, and the substrate refuses it loudly.
    expect(
      await preAssertedApproval("worker-deploy", "wrangler deploy && git push --tags", scope),
    ).toBeUndefined();
  });

  it("does not let one run borrow another's pre-assertion", async () => {
    expect(await preAssertedApproval("offload-test", "wrangler deploy", scope)).toBeUndefined();
  });

  it("only pre-asserts on runs that declare it", async () => {
    const declaring = Object.entries(RUN_GRANTS)
      .filter(([, grant]) => (grant.preAsserts ?? []).length > 0)
      .map(([name]) => name);
    expect(declaring).toEqual(["worker-deploy"]);
  });
});
