import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto.ts";
import {
  assertCacheable,
  CACHE_KINDS,
  cacheKey,
  compileCacheCommand,
  INSTALL_OUTPUTS,
  installCachedInputs,
  isCacheKind,
  prebuiltBinaryInputsDigest,
  restoreOrCargoRun,
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
  it("FD-CACHE-001 the cache stores only the five entry kinds and refuses workspace and build-output paths", async () => {
    expect(CACHE_KINDS).toEqual(["dependency", "compile", "prebuilt-binary", "download", "model-weights"]);
    expect(isCacheKind("workspace")).toBe(false);
    expect(isCacheKind("checkout")).toBe(false);
    const sandbox = { workspace: "/work/repo", buildOutputs: ["/work/out"] };
    expect(Exit.isFailure(await Effect.runPromiseExit(assertCacheable("/work/repo/node_modules", sandbox)))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(assertCacheable("/work/out/bin", sandbox)))).toBe(true);
    expect(await run(assertCacheable("/home/runner/.cache/uv", sandbox))).toBe("/home/runner/.cache/uv");
  });

  it("FD-CACHE-031 the key is the SHA-256 of the canonical JSON of every key field", async () => {
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

  it("FD-CACHE-032 a key with any field missing fails, so the primitive skips the read and the write", async () => {
    for (const f of Object.keys(fields) as (keyof KeyFields)[]) {
      const partial: Partial<KeyFields> = { ...fields };
      delete partial[f];
      const exit = await Effect.runPromiseExit(cacheKey(partial));
      expect(Exit.isFailure(exit)).toBe(true);
    }
    const noArch = await Effect.runPromiseExit(cacheKey({ ...fields, platform: { os: "linux", arch: "" } }));
    expect(Exit.isFailure(noArch)).toBe(true);
  });

  it("FD-CACHE-033 installCached keys on the lockfile's SHA-256 and caches install outputs only", async () => {
    const lockfile = new TextEncoder().encode("lockfileVersion: '9.0'\n");
    for (const manager of ["pnpm", "npm", "cargo", "uv"] as const) {
      const inputs = await run(installCachedInputs(manager, lockfile));
      expect(inputs.inputsDigest).toBe(await sha256Hex(lockfile));
      expect(inputs.paths).toEqual(INSTALL_OUTPUTS[manager]);
      for (const p of inputs.paths) expect(p).not.toMatch(/node_modules|target|^\/|\.\./);
    }
    expect(Exit.isFailure(await Effect.runPromiseExit(installCachedInputs("pnpm", undefined)))).toBe(true);
  });

  it("FD-CACHE-034 the prebuilt-binary inputs are key-file, path-dependency and include! object ids plus rustc and cargo", async () => {
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

  it("FD-CACHE-035 a prebuilt-binary miss or restore failure falls back to cargo run without failing", async () => {
    const cargoRun = Effect.succeed("built");
    expect(await run(restoreOrCargoRun(Effect.succeed(null), cargoRun))).toEqual({ value: "built", restored: false });
    expect(await run(restoreOrCargoRun(Effect.fail("io"), cargoRun))).toEqual({ value: "built", restored: false });
    expect(await run(restoreOrCargoRun(Effect.succeed("cached"), cargoRun))).toEqual({ value: "cached", restored: true });
  });
});

/** Runs the wrapper with a `PATH` of fake `rustc` (and optionally `sccache`) scripts. */
const wrap = (opts: { sccache: "ok" | "refuses" | "absent"; env?: Record<string, string> }) => {
  const dir = mkdtempSync(join(tmpdir(), "fd-cc-"));
  const script = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  script("rustc", "printf 'rustc 1.90.0\\nrelease: 1.90.0\\nhost: x86_64-unknown-linux-gnu\\n'");
  if (opts.sccache !== "absent")
    script("sccache", opts.sccache === "ok" ? "exit 0" : '[ "$1" = "--start-server" ] && exit 1; exit 0');
  const command = 'echo "W=${RUSTC_WRAPPER:-none} I=${CARGO_INCREMENTAL:-unset} P=${SCCACHE_WEBDAV_KEY_PREFIX:-none}"';
  const out = spawnSync("/bin/sh", ["-c", compileCacheCommand(command, "Acme/widgets")!], {
    env: { PATH: `${dir}:/usr/bin:/bin`, SCCACHE_WEBDAV_ENDPOINT: "https://ci.example.com/v1/compile-cache", SCCACHE_WEBDAV_TOKEN: "t", ...opts.env },
    encoding: "utf8",
  });
  return { status: out.status, stdout: out.stdout };
};

describe("compile-cache wrapper", () => {
  it("FD-CACHE-037 sets RUSTC_WRAPPER=sccache, CARGO_INCREMENTAL=0 and the <repo>/<rustc>/<target> prefix", () => {
    const r = wrap({ sccache: "ok" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("W=sccache I=0 P=acme/widgets/1.90.0/x86_64-unknown-linux-gnu");
    const cross = wrap({ sccache: "ok", env: { CARGO_BUILD_TARGET: "aarch64-unknown-linux-gnu" } });
    expect(cross.stdout).toContain("P=acme/widgets/1.90.0/aarch64-unknown-linux-gnu");
    expect(compileCacheCommand("true", "not a repo")).toBeUndefined();
  });

  it("FD-CACHE-038 an unreachable endpoint or a missing sccache compiles without the cache and does not fail", () => {
    for (const sccache of ["refuses", "absent"] as const) {
      const r = wrap({ sccache });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("W=none");
    }
  });
});
