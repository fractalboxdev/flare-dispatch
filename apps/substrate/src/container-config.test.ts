// The container block is config, and two of this worker's invariants live
// there rather than in code — which is exactly where they drift unnoticed,
// because nothing type-checks a JSONC file against a TypeScript constant.
//
//   1. The partition is written twice. `max_instances` is the platform's
//      physical cap; `POOL_CAPS_DEFAULT` is the gate's logical one. A logical
//      cap above the physical one admits work the platform then refuses at
//      create — the exact failure ADR-0004 exists to make impossible.
//   2. The image tag is half of a pinned pair. `@cloudflare/sandbox` speaks an
//      HTTP/RPC protocol to a server baked into the image, and ADR-0011 makes
//      that pair a security-reviewed surface. A package bump that leaves the
//      Dockerfile behind is a protocol mismatch with a version-skew failure
//      mode, not a build error.
//
// Read through wrangler's own config reader rather than a hand-rolled JSONC
// strip, so an invalid config fails here the same way it would at deploy.
// Runs under plain Node (this package's vitest project), so the file reads are
// fine — they would not be in a workers pool.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { POOL_CAPS_DEFAULT, POOLS } from "./admission/pools";

const repoFile = (relative: string): string =>
  fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

/**
 * Only the fields asserted below, declared structurally. `unstable_readConfig`
 * returns wrangler's own config type, which types these as `any` under this
 * package's compiler settings — narrowing here is what makes the assertions
 * type-checked rather than merely runtime-checked.
 */
type ContainerClass = {
  readonly class_name: string;
  readonly image: string;
  readonly instance_type?: string;
  readonly max_instances?: number;
};
type DurableObjectBinding = { readonly name: string; readonly class_name: string };

const config = unstable_readConfig({ config: repoFile("apps/substrate/wrangler.jsonc") });
const containers = (config.containers ?? []) as readonly ContainerClass[];
const bindings = (config.durable_objects?.bindings ?? []) as readonly DurableObjectBinding[];

const taskDockerfile = readFileSync(repoFile("infra/Dockerfile.task"), "utf8");
/**
 * Instructions only. Every content assertion below runs against this rather
 * than the raw file: the comments explain what is deliberately *absent*, so a
 * naive text search finds the explanation and calls it the thing.
 */
const taskInstructions = taskDockerfile
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");
const substratePackage = JSON.parse(
  readFileSync(repoFile("apps/substrate/package.json"), "utf8"),
) as { dependencies: Record<string, string> };

/**
 * The class serving a pool, resolved the way the runtime resolves it: the
 * facade picks a binding by pool name (`namespaceFor`), and env.ts names those
 * bindings `SANDBOX_<POOL>`. Derived rather than tabulated here so renaming a
 * binding without renaming its pool fails instead of quietly orphaning a cap.
 */
const containerForPool = (pool: string) => {
  const binding = bindings.find((b) => b.name === `SANDBOX_${pool.toUpperCase()}`);
  return containers.find((c) => c.class_name === binding?.class_name);
};

describe("containers block ↔ pool partition (ADR-0004)", () => {
  it("serves every pool with a declared container class", () => {
    for (const pool of POOLS) expect(containerForPool(pool), pool).toBeDefined();
    // And nothing extra: an undeclared class is capacity no pool accounts for.
    expect(containers).toHaveLength(POOLS.length);
  });

  it("gives each pool the same cap in wrangler as in pools.ts", () => {
    for (const pool of POOLS)
      expect(containerForPool(pool)?.max_instances, pool).toBe(POOL_CAPS_DEFAULT[pool]);
  });

  it("keeps the shipped partition inside the shipped ceiling", () => {
    const ceiling = Number(config.vars?.["CONTAINERS_CEILING"]);
    expect(Number.isInteger(ceiling)).toBe(true);
    const declared = containers.reduce((sum, c) => sum + (c.max_instances ?? 0), 0);
    expect(declared).toBeLessThanOrEqual(ceiling);
  });
});

describe("the task image (ADR-0010)", () => {
  const task = containerForPool("task");

  it("builds from its own Dockerfile, not the shared sandbox one", () => {
    expect(task?.image).toMatch(/infra\/Dockerfile\.task$/);
  });

  it("sizes the pool for one repository's install-and-test, not a CI matrix", () => {
    // standard-3 is 2 vCPU / 8 GiB. Changing it is a cost and headroom
    // decision, so it changes here too rather than only in the config.
    expect(task?.instance_type).toBe("standard-3");
  });

  it("pins the base tag to the @cloudflare/sandbox version this worker runs", () => {
    const from = /^FROM \S+\/cloudflare\/sandbox:(\S+)$/m.exec(taskInstructions);
    expect(from).not.toBeNull();
    // The tag is `<version>` or `<version>-<variant>`; the variant is ours to
    // choose, the version is not.
    const [version] = (from?.[1] ?? "").split("-");
    expect(version).toBe(substratePackage.dependencies["@cloudflare/sandbox"]);
  });
});

describe("the task image's contents", () => {
  it("bakes the harness CLI, git-lfs, pnpm and ripgrep at pinned versions", () => {
    for (const tool of ["OPENCODE", "PNPM", "GIT_LFS", "RIPGREP"])
      expect(taskInstructions, tool).toMatch(
        new RegExp(`^ARG ${tool}_VERSION=\\d+\\.\\d+\\.\\d+$`, "m"),
      );
  });

  it("verifies every downloaded asset against a checksum", () => {
    for (const tool of ["GIT_LFS", "RIPGREP"])
      expect(taskInstructions, tool).toMatch(new RegExp(`^ARG ${tool}_SHA256=[0-9a-f]{64}$`, "m"));
    // One `sha256sum -c` per download, so adding a fetch without a checksum
    // fails here rather than shipping an unverified binary.
    const downloads = taskInstructions.match(/curl -fsSLO/g) ?? [];
    const checks = taskInstructions.match(/sha256sum -c -/g) ?? [];
    expect(downloads.length).toBeGreaterThan(0);
    expect(checks).toHaveLength(downloads.length);
  });

  it("installs nothing globally without a version", () => {
    const specs = [...taskInstructions.matchAll(/npm install -g "?([^"\s]+)"?/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec, spec).toContain("@");
  });

  it("takes apt packages from a dated archive snapshot, not from whatever is current", () => {
    // A `build-essential=<version>` pin would be theatre — the metapackage's
    // version says nothing about the gcc/g++/libc6-dev/make it pulls. The
    // snapshot pins the whole transitive set, so assert on that instead.
    expect(taskInstructions).toMatch(/^ARG APT_SNAPSHOT=\d{8}T\d{6}Z$/m);
    expect(taskInstructions).toMatch(/snapshot\.ubuntu\.com\/ubuntu\/\$\{APT_SNAPSHOT\}/);
    // The options that redirect apt at the snapshot, and every apt-get that
    // must carry them. A new `apt-get install` without them would resolve
    // against the base's live archive — the drift this pin exists to stop.
    expect(taskInstructions).toMatch(
      /apt_opts="-o Dir::Etc::SourceList=\S+ -o Dir::Etc::SourceParts=\S+/,
    );
    for (const line of taskInstructions.split("\n").filter((l) => /\bapt-get\b/.test(l)))
      expect(line, line).toContain("$apt_opts");
  });

  it("points every toolchain's TLS at the system trust store", () => {
    // The outbound handler re-issues each request (ADR-0005), so the cert a
    // tool sees is not the origin's. Node, requests, curl, pip and git each
    // default to their own root set and would fail TLS without these.
    for (const variable of [
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "REQUESTS_CA_BUNDLE",
      "CURL_CA_BUNDLE",
      "PIP_CERT",
      "GIT_SSL_CAINFO",
    ])
      expect(taskInstructions, variable).toMatch(
        new RegExp(`^(?:ENV\\s+)?\\s*${variable}=/etc/ssl/certs/ca-certificates\\.crt`, "m"),
      );
  });

  it("leaves the LFS smudge filter unwired", () => {
    // `recipe.lfs` is off by default and the grant only admits the object host
    // when it is set. A system filter would make every clone of an LFS repo
    // reach for objects it has no grant for and fail the checkout.
    expect(taskInstructions).not.toMatch(/git lfs install/);
  });
});
