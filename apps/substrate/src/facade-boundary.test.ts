// ADR-0002 promises "a lint rule forbids imports from substrate internals" and
// ADR-0003 makes the facade contract the only way in. `.oxlintrc.json` carries
// that rule, and this file is what keeps it carrying it.
//
// What this asserts is the rule's *shape*, not oxlint's matching behavior: that
// the rule exists, is an error, is not scoped to a hand-written list of today's
// consumer directories, restricts both shapes that can reach the substrate, and
// is turned off for exactly one tree. Whether a given specifier matches a given
// glob is oxlint's business, verified by running it — `pnpm lint` is the gate
// that does that, on every file in the repo, in CI.
//
// The shape is worth pinning separately because every failure mode here is
// silent. A rule that drifts to "warn", or gains a `files` allowlist that a new
// consumer tree is missing from, or keeps guarding a package name the substrate
// no longer uses, still passes `pnpm lint` with zero output — the boundary just
// stops being enforced, exactly the way ADR-0002's promise sat unenforced until
// the rule was written.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoFile = (relative: string): string =>
  fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

/** Only the fields asserted below. */
type RestrictedImports = readonly [
  severity: string,
  options: {
    readonly patterns: readonly { readonly group: readonly string[]; readonly message: string }[];
  },
];
type OxlintConfig = {
  readonly rules: Record<string, unknown>;
  readonly overrides: readonly {
    readonly files: readonly string[];
    readonly rules: Record<string, unknown>;
  }[];
};

const oxlintConfig = JSON.parse(readFileSync(repoFile(".oxlintrc.json"), "utf8")) as OxlintConfig;
const substratePackageName = (
  JSON.parse(readFileSync(repoFile("apps/substrate/package.json"), "utf8")) as { name: string }
).name;

const restricted = oxlintConfig.rules["no-restricted-imports"] as RestrictedImports | undefined;

describe("the facade boundary is a lint rule, not a promise (ADR-0002, ADR-0003)", () => {
  it("declares no-restricted-imports as an error", () => {
    expect(restricted, ".oxlintrc.json declares no `no-restricted-imports` rule").toBeDefined();
    // "warn" would leave `pnpm lint` green on a breach, which is the same as
    // having no rule at all — the state ADR-0002 recorded for its first year.
    expect(restricted?.[0]).toBe("error");
  });

  it("applies to the whole repo rather than a list of today's consumer trees", () => {
    // The rule lives in top-level `rules`, so a consumer tree added later is
    // covered the day it appears. An `overrides` entry enumerating directories
    // would leave every future tree unguarded until someone remembered it.
    expect(Object.keys(oxlintConfig.rules)).toContain("no-restricted-imports");
    // An override may only switch the rule off for a tree. One that redefines
    // it with its own patterns has moved the boundary somewhere this test does
    // not read, which is how the enumerated-directory version drifted.
    for (const override of oxlintConfig.overrides) {
      const value = override.rules["no-restricted-imports"];
      expect(
        value === undefined || value === "off",
        `override for ${override.files.join(", ")} may only turn the rule OFF, never redefine it`,
      ).toBe(true);
    }
  });

  it("exempts the substrate itself, and nothing else", () => {
    // The substrate reaches its own internals by definition; every other tree
    // goes through the contract.
    const exempted = oxlintConfig.overrides.filter(
      (override) => override.rules["no-restricted-imports"] === "off",
    );
    expect(exempted.flatMap((override) => override.files)).toEqual(["apps/substrate/**"]);
  });

  it("restricts the workspace package name the substrate actually publishes", () => {
    // The bypass this catches: a consumer adds `"<name>": "workspace:*"` and
    // deep-imports `<name>/src/...`. No path glob sees that specifier — the
    // segment is `flare-dispatch-substrate`, never `substrate` — and the
    // package declares no `exports`, so every internal file is reachable.
    // Read from package.json so renaming the package without updating the rule
    // fails here instead of silently reopening the boundary.
    const group = restricted?.[1].patterns.flatMap((pattern) => pattern.group) ?? [];
    expect(group).toContain(substratePackageName);
    expect(group).toContain(`${substratePackageName}/**`);
  });

  it("restricts the path shapes that reach the substrate directory", () => {
    const group = restricted?.[1].patterns.flatMap((pattern) => pattern.group) ?? [];
    // `**/apps/substrate/**` alone misses a sibling-relative import from
    // another app — `../../substrate/src/x` carries no `apps/` segment.
    expect(group).toContain("**/substrate/src/**");
    expect(group).toContain("**/apps/substrate/**");
  });

  it("names the contract package in the message, so the error says what to do instead", () => {
    const messages = restricted?.[1].patterns.map((pattern) => pattern.message) ?? [];
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages)
      expect(message).toContain("@fractalboxdev/flare-dispatch-substrate-contract");
  });
});
