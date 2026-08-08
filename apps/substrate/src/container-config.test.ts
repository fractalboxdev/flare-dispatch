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

/**
 * Instructions only. Every content assertion below runs against this rather
 * than the raw file: the comments explain what is deliberately *absent*, so a
 * naive text search finds the explanation and calls it the thing.
 */
const instructionsOf = (relative: string): string =>
  readFileSync(repoFile(relative), "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const taskInstructions = instructionsOf("infra/Dockerfile.task");
const substrateInstructions = instructionsOf("infra/Dockerfile.substrate");
const entrypointScript = readFileSync(repoFile("infra/container-entrypoint.sh"), "utf8");
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

  it("leaves the LFS smudge filter unwired", () => {
    // `recipe.lfs` is off by default and the grant only admits the object host
    // when it is set. A system filter would make every clone of an LFS repo
    // reach for objects it has no grant for and fail the checkout.
    expect(taskInstructions).not.toMatch(/git lfs install/);
  });
});

/**
 * The image half of HTTPS interception (#72). `interceptHttps = true` on the DO
 * class is inert unless the container trusts the interception CA, and the CA is
 * a runtime artifact — it does not exist during the build — so the trust step
 * is an entrypoint the image has to run. Half of this pair shipping without the
 * other is the failure these assertions exist to catch: the flag alone breaks
 * TLS for everything in the container, the entrypoint alone does nothing.
 */
describe("HTTPS interception — the CA trust half (#72)", () => {
  const images = [
    ["Dockerfile.substrate", substrateInstructions],
    ["Dockerfile.task", taskInstructions],
  ] as const;

  it.each(images)("%s runs the CA-installing entrypoint", (_name, instructions) => {
    expect(instructions).toMatch(
      /^COPY container-entrypoint\.sh \/usr\/local\/bin\/substrate-entrypoint\.sh$/m,
    );
    expect(instructions).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/substrate-entrypoint\.sh"\]$/m);
  });

  it.each(images)("%s asserts the base server binary at build time", (_name, instructions) => {
    // The wrapper `exec`s `/container-server/sandbox` by absolute path — the
    // server the Durable Object half speaks its HTTP/RPC protocol to. A base
    // image that moved it must fail the build, not produce an image whose
    // entrypoint starts nothing.
    expect(instructions).toMatch(/^RUN test -x \/container-server\/sandbox$/m);
  });

  it.each(images)(
    "%s points every toolchain's TLS at the system trust store",
    (_n, instructions) => {
      // The outbound handler re-issues each request (ADR-0005), so the cert a
      // tool sees is not the origin's. Node, requests, curl, pip and git each
      // default to their own root set and would fail TLS without these — and the
      // entrypoint's `update-ca-certificates` is what puts the interception CA
      // into the bundle they all point at.
      for (const variable of [
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "PIP_CERT",
        "GIT_SSL_CAINFO",
      ])
        expect(instructions, variable).toMatch(
          new RegExp(`^(?:ENV\\s+)?\\s*${variable}=/etc/ssl/certs/ca-certificates\\.crt`, "m"),
        );
    },
  );

  it("installs the runtime CA into the store those variables read", () => {
    // The source path is the platform's, fixed by `@cloudflare/containers`; the
    // destination and the refresh command are the Debian/Ubuntu pair both bases
    // are. `update-ca-certificates` regenerates
    // /etc/ssl/certs/ca-certificates.crt, which is what closes the loop with
    // the ENV block above.
    expect(entrypointScript).toContain("/etc/cloudflare/certs/cloudflare-containers-ca.crt");
    expect(entrypointScript).toContain("/usr/local/share/ca-certificates/");
    expect(entrypointScript).toMatch(/^\s*update-ca-certificates/m);
  });

  it("execs the sandbox server rather than leaving a wrapper as PID 1", () => {
    // Without `exec` the wrapper stays in the process tree and swallows the
    // SIGTERM the platform sends at idle-stop, turning every sleep into a kill.
    expect(entrypointScript).toMatch(/^exec \/container-server\/sandbox "\$@"$/m);
  });

  it("does not fail the boot when the CA is absent", () => {
    // The gate is the ADR-0011 canary and /health's `unverified` 503, not the
    // entrypoint: a boot that dies here reports a container that never started
    // and takes down a fleet that could still serve HTTP. The warning names the
    // cause in the container log instead.
    expect(entrypointScript).toMatch(/WARNING/);
    expect(entrypointScript).not.toMatch(/^\s*exit 1$/m);
  });
});

const lockfileLines = readFileSync(repoFile("pnpm-lock.yaml"), "utf8").split("\n");

/**
 * The lines nested under `header` at `indent`, up to the next line indented no
 * deeper — enough of a YAML reader to walk `pnpm-lock.yaml`'s three top-level
 * sections without adding a parser dependency to this package.
 *
 * It throws rather than returning empty. Every caller below asserts on what it
 * finds, so a missing block that returned `[]` would turn each of those into a
 * vacuous pass on the next lockfile format change — the exact failure mode this
 * whole describe exists to remove.
 */
const lockBlock = (
  header: string,
  indent: number,
  within: readonly string[],
): readonly string[] => {
  const start = within.indexOf(`${" ".repeat(indent)}${header}`);
  if (start === -1) throw new Error(`pnpm-lock.yaml: no \`${header}\` at indent ${indent}`);
  const body = within.slice(start + 1);
  const end = body.findIndex(
    (line) => line.trim() !== "" && !line.startsWith(" ".repeat(indent + 1)),
  );
  return end === -1 ? body : body.slice(0, end);
};

const lockField = (name: string, within: readonly string[]): string => {
  const prefix = `${name}:`;
  const line = within.find((candidate) => candidate.trim().startsWith(prefix));
  if (line === undefined) throw new Error(`pnpm-lock.yaml: no \`${name}\` in block`);
  return line.trim().slice(prefix.length).trim();
};

/**
 * ADR-0011 pins a *pair* — `@cloudflare/sandbox` and `@cloudflare/containers` —
 * and calls every bump of either "a security-reviewed change to the substrate,
 * never a routine dependency update", with an invariant checklist to re-run.
 *
 * The image-tag test above cannot enforce that. It asserts the Dockerfile tag
 * AGREES with package.json, so it catches skew between the two and says nothing
 * about a bump: move both together and it stays green — which is exactly the
 * change the ADR exists to make deliberate.
 *
 * So these assert the literal versions. The cost is one line per legitimate
 * bump, and that line IS the control: neither package can move without editing
 * a test that says the checklist has to be re-run first. A reviewer sees the
 * version change as its own diff hunk rather than as a lockfile detail.
 *
 * `@cloudflare/containers` is asserted by *walking* the lockfile, not by
 * scanning it. A scan for the version string anywhere in the file is answered
 * by any workspace member — `apps/dispatcher` and `packages/runtime-cf` both
 * pull the same version through `@cloudflare/sandbox` 0.10.1 — so deleting the
 * substrate's dependency outright would leave it green. The path below is the
 * substrate's own: importer → the sandbox version that importer resolved →
 * that snapshot's `@cloudflare/containers` edge.
 */
describe("the pinned SDK pair (ADR-0011)", () => {
  const PINNED_SANDBOX = "0.12.4";
  const PINNED_CONTAINERS = "0.3.7";

  // Every assertion here carries this. A bare "expected '0.13.0' to be
  // '0.12.4'" reads as a stale constant somebody forgot, which is the one
  // conclusion the ADR says a reader must not reach.
  const CHECKLIST =
    "ADR-0011: a bump of either package is a security-reviewed change to the substrate, not a routine dependency update. Re-run the invariant checklist in apps/substrate/specs/adr/0011-sdk-pin-as-security-surface.md, then update the pinned constant here.";

  const substrateImporter = (): readonly string[] =>
    lockBlock("apps/substrate:", 2, lockBlock("importers:", 0, lockfileLines));
  const lockPackages = (): readonly string[] => lockBlock("packages:", 0, lockfileLines);

  it("declares the reviewed @cloudflare/sandbox, not merely a self-consistent one", () => {
    expect(substratePackage.dependencies["@cloudflare/sandbox"], CHECKLIST).toBe(PINNED_SANDBOX);
  });

  it("installs the @cloudflare/sandbox it declares", () => {
    // The manifest states an intent; the lockfile states what `pnpm install`
    // actually puts on disk. Asserting only the first would pass on a lockfile
    // that never caught up with a manifest edit.
    const edge = lockBlock(
      "'@cloudflare/sandbox':",
      6,
      lockBlock("dependencies:", 4, substrateImporter()),
    );
    expect(lockField("specifier", edge), CHECKLIST).toBe(PINNED_SANDBOX);
    expect(lockField("version", edge), CHECKLIST).toBe(PINNED_SANDBOX);
  });

  it("reaches @cloudflare/containers through that pinned sandbox", () => {
    // The substrate declares only `@cloudflare/sandbox`, so the other half of
    // the ADR's pair is invisible to every package.json in the repo. This edge
    // is where it becomes reviewable: the dependency the pinned sandbox itself
    // resolved, which is what the container actually loads.
    const snapshotDependencies = lockBlock(
      "dependencies:",
      4,
      lockBlock(
        `'@cloudflare/sandbox@${PINNED_SANDBOX}':`,
        2,
        lockBlock("snapshots:", 0, lockfileLines),
      ),
    );
    expect(lockField("'@cloudflare/containers'", snapshotDependencies), CHECKLIST).toBe(
      PINNED_CONTAINERS,
    );
  });

  it("resolves exactly one @cloudflare/containers across the whole workspace", () => {
    // The edge above pins the substrate's path. This closes the other side: a
    // second resolved copy anywhere means some consumer runs an unreviewed
    // containers against the same substrate contract.
    //
    // Deliberately repo-wide, so it can fail for a reason outside this package.
    // `apps/dispatcher` and `packages/runtime-cf` both declare
    // `@cloudflare/sandbox` 0.10.1, which happens to resolve the same
    // containers; bumping either to a sandbox that resolves a different one
    // reddens this test. That is the intended signal — ADR-0011 calls the pair
    // a security surface, and a second copy in the deploy is the thing to look
    // at — but the fix lives in the consumer that moved, not here.
    const resolved = lockPackages()
      .map((line) => /^ {2}'@cloudflare\/containers@([^']+)':$/.exec(line)?.[1])
      .filter((version): version is string => version !== undefined);
    expect(resolved, CHECKLIST).toEqual([PINNED_CONTAINERS]);
  });

  it("pins that @cloudflare/containers to a resolution with an integrity hash", () => {
    // Without this the three assertions above are satisfied by a version
    // *number* agreeing with itself; the hash is what ties the number to bytes.
    const containersPackage = lockBlock(
      `'@cloudflare/containers@${PINNED_CONTAINERS}':`,
      2,
      lockPackages(),
    );
    expect(lockField("resolution", containersPackage)).toMatch(/integrity: sha512-/);
  });
});
