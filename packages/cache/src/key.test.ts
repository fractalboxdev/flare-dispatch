import { spawnSync } from "node:child_process";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto.ts";
import {
  assertCacheable,
  CACHE_KINDS,
  cacheKey,
  compileCacheCommand,
  imageToolchains,
  INSTALL_OUTPUTS,
  installCachedInputs,
  isCacheKind,
  NATIVE_LIBRARY_ARCHES,
  prebuiltBinaryInputsDigest,
  restoreOrCargoRun,
  SANDBOX_NATIVE_LIBRARIES,
  type KeyFields,
} from "./key.ts";

const fields: KeyFields = {
  repositoryId: "123",
  kind: "dependency",
  namespace: "pr/acme/widgets/7",
  platform: { os: "linux", arch: "amd64" },
  imageDigest: `sha256:${"a".repeat(64)}`,
  toolchains: { node: "22.13.0", pnpm: "11.1.3" },
  producerDigest: "b".repeat(64),
  inputsDigest: "c".repeat(64),
};
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);

describe("cache keys", () => {
  it("[FD-CACHE-001] the cache stores only the five entry kinds and refuses workspace and build-output paths", async () => {
    expect(CACHE_KINDS).toEqual(["dependency", "compile", "prebuilt-binary", "download", "model-weights"]);
    expect(isCacheKind("workspace")).toBe(false);
    expect(isCacheKind("checkout")).toBe(false);
    const sandbox = { workspace: "/work/repo", buildOutputs: ["/work/out"] };
    expect(Exit.isFailure(await Effect.runPromiseExit(assertCacheable("/work/repo/node_modules", sandbox)))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(assertCacheable("/work/out/bin", sandbox)))).toBe(true);
    expect(await run(assertCacheable("/home/runner/.cache/uv", sandbox))).toBe("/home/runner/.cache/uv");
  });

  it("[FD-CACHE-031] the key is the SHA-256 of the canonical JSON of every key field", async () => {
    const key = await run(cacheKey(fields));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const reordered = { ...fields, toolchains: { pnpm: "11.1.3", node: "22.13.0" } };
    expect(await run(cacheKey(reordered))).toBe(key);
    expect(key).toBe(
      await sha256Hex(
        '{"image_digest":"sha256:' + "a".repeat(64) + '","inputs_digest":"' + "c".repeat(64) +
          '","kind":"dependency","namespace":"pr/acme/widgets/7","platform":{"arch":"amd64","os":"linux"},"producer_digest":"' +
          "b".repeat(64) + '","repository_id":"123","toolchains":{"node":"22.13.0","pnpm":"11.1.3"},"v":1}',
      ),
    );
    // An arm64 entry never answers an amd64 read.
    expect(await run(cacheKey({ ...fields, platform: { os: "linux", arch: "arm64" } }))).not.toBe(key);
    for (const f of ["namespace", "imageDigest", "producerDigest", "inputsDigest", "repositoryId"] as const)
      expect(await run(cacheKey({ ...fields, [f]: "x" }))).not.toBe(key);
  });

  it("[FD-CACHE-032] a key with any field missing fails, so the primitive skips the read and the write", async () => {
    for (const f of Object.keys(fields) as (keyof KeyFields)[]) {
      const partial: Partial<KeyFields> = { ...fields };
      delete partial[f];
      const exit = await Effect.runPromiseExit(cacheKey(partial));
      expect(Exit.isFailure(exit)).toBe(true);
    }
    const noArch = await Effect.runPromiseExit(cacheKey({ ...fields, platform: { os: "linux", arch: "" } }));
    expect(Exit.isFailure(noArch)).toBe(true);
  });

  it("[FD-CACHE-033] installCached keys on the lockfile's SHA-256 and caches install outputs only", async () => {
    const lockfile = new TextEncoder().encode("lockfileVersion: '9.0'\n");
    for (const manager of ["pnpm", "npm", "cargo", "uv"] as const) {
      const inputs = await run(installCachedInputs(manager, lockfile));
      expect(inputs.inputsDigest).toBe(await sha256Hex(lockfile));
      expect(inputs.paths).toEqual(INSTALL_OUTPUTS[manager]);
      for (const p of inputs.paths) expect(p).not.toMatch(/node_modules|target|^\/|\.\./);
    }
    expect(Exit.isFailure(await Effect.runPromiseExit(installCachedInputs("pnpm", undefined)))).toBe(true);
  });

  it("[FD-CACHE-034] the prebuilt-binary inputs are key-file, path-dependency and include! object ids plus rustc and cargo", async () => {
    const inputs = {
      keyFiles: { "Cargo.lock": "1".repeat(40) },
      pathDependencies: { "crates/core": "2".repeat(40) },
      includeTargets: { "schema.json": "3".repeat(40) },
      rustc: "1.90.0",
      cargo: "1.90.0",
    };
    const digest = await prebuiltBinaryInputsDigest(inputs);
    for (const change of [
      { keyFiles: { "Cargo.lock": "9".repeat(40) } },
      { pathDependencies: { "crates/core": "9".repeat(40) } },
      { includeTargets: { "schema.json": "9".repeat(40) } },
      { rustc: "1.91.0" },
      { cargo: "1.91.0" },
    ])
      expect(await prebuiltBinaryInputsDigest({ ...inputs, ...change })).not.toBe(digest);
  });

  it("[FD-CACHE-035] a prebuilt-binary miss or restore failure falls back to cargo run without failing", async () => {
    const cargoRun = Effect.succeed("built");
    expect(await run(restoreOrCargoRun(Effect.succeed(null), cargoRun))).toEqual({ value: "built", restored: false });
    expect(await run(restoreOrCargoRun(Effect.fail("io"), cargoRun))).toEqual({ value: "built", restored: false });
    expect(await run(restoreOrCargoRun(Effect.succeed("cached"), cargoRun))).toEqual({ value: "cached", restored: true });
  });

  it("[FD-CACHE-036] each native library is pinned by SHA-256 for amd64 and arm64 and its version is a key toolchain", async () => {
    expect(NATIVE_LIBRARY_ARCHES).toEqual(["amd64", "arm64"]);
    expect(SANDBOX_NATIVE_LIBRARIES.map((l) => l.name)).toContain("libduckdb");
    for (const library of SANDBOX_NATIVE_LIBRARIES) {
      expect(Object.keys(library.sha256).sort()).toEqual(["amd64", "arm64"]);
      for (const arch of NATIVE_LIBRARY_ARCHES) expect(library.sha256[arch]).toMatch(/^[0-9a-f]{64}$/);
      expect(library.sha256.amd64).not.toBe(library.sha256.arm64);
    }

    const toolchains = imageToolchains(fields.toolchains, SANDBOX_NATIVE_LIBRARIES);
    expect(toolchains).toEqual({ node: "22.13.0", pnpm: "11.1.3", libduckdb: "v1.5.5" });
    // The image's pinned version replaces a caller's value of the same name.
    expect(imageToolchains({ libduckdb: "v1.4.0" }, SANDBOX_NATIVE_LIBRARIES)["libduckdb"]).toBe("v1.5.5");

    // An entry built against one library release never answers a read under another.
    const key = await run(cacheKey({ ...fields, toolchains }));
    expect(key).not.toBe(await run(cacheKey(fields)));
    const bumped = SANDBOX_NATIVE_LIBRARIES.map((l) => (l.name === "libduckdb" ? { ...l, version: "v1.5.6" } : l));
    expect(await run(cacheKey({ ...fields, toolchains: imageToolchains(fields.toolchains, bumped) }))).not.toBe(key);
    // An image without native libraries keys on its other toolchains only.
    expect(imageToolchains(fields.toolchains, [])).toEqual(fields.toolchains);
  });
});

/**
 * Runs the wrapper with fake `rustc` (and optionally `sccache`) as shell functions, which `command -v` finds as it
 * finds an executable on `PATH`. No executable file is written, so no first-run executable check delays the spawn.
 */
const wrap = (opts: { sccache: "ok" | "refuses" | "absent"; env?: Record<string, string> }) => {
  const fakes = [
    "rustc() { printf 'rustc 1.90.0\\nrelease: 1.90.0\\nhost: x86_64-unknown-linux-gnu\\n'; }",
    ...(opts.sccache === "absent"
      ? []
      : [
          opts.sccache === "ok"
            ? "sccache() { return 0; }"
            : 'sccache() { [ "$1" = "--start-server" ] && return 1; return 0; }',
        ]),
  ];
  const command = 'echo "W=${RUSTC_WRAPPER:-none} I=${CARGO_INCREMENTAL:-unset} P=${SCCACHE_WEBDAV_KEY_PREFIX:-none}"';
  const out = spawnSync("/bin/sh", ["-c", [...fakes, compileCacheCommand(command, "Acme/widgets")!].join("\n")], {
    env: { PATH: "/usr/bin:/bin", SCCACHE_WEBDAV_ENDPOINT: "https://ci.example.com/v1/compile-cache", SCCACHE_WEBDAV_TOKEN: "t", ...opts.env },
    encoding: "utf8",
  });
  return { status: out.status, stdout: out.stdout };
};

describe("compile-cache wrapper", () => {
  it("[FD-CACHE-037] sets RUSTC_WRAPPER=sccache, CARGO_INCREMENTAL=0 and the <repo>/<rustc>/<target> prefix", () => {
    const r = wrap({ sccache: "ok" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("W=sccache I=0 P=acme/widgets/1.90.0/x86_64-unknown-linux-gnu");
    const cross = wrap({ sccache: "ok", env: { CARGO_BUILD_TARGET: "aarch64-unknown-linux-gnu" } });
    expect(cross.stdout).toContain("P=acme/widgets/1.90.0/aarch64-unknown-linux-gnu");
    expect(compileCacheCommand("true", "not a repo")).toBeUndefined();
  });

  it("[FD-CACHE-038] an unreachable endpoint or a missing sccache compiles without the cache and does not fail", () => {
    for (const sccache of ["refuses", "absent"] as const) {
      const r = wrap({ sccache });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("W=none");
    }
  });
});
