// The cache key and the primitives that compute one (specs/cache-artifacts.md § Cache keys). The key is the SHA-256
// of the canonical JSON of nine fields; a primitive that cannot compute every field caches nothing.
import { Effect, Schema } from "effect";
import { canonicalJson, sha256Hex } from "./crypto.ts";

/** The only kinds the cache stores (FD-CACHE-001): a checkout, a workspace or a build output is never one. */
export const CACHE_KINDS = [
  "dependency",
  "compile",
  "prebuilt-binary",
  "download",
  "model-weights",
] as const;
export type CacheKind = (typeof CACHE_KINDS)[number];
export const isCacheKind = (kind: string): kind is CacheKind =>
  (CACHE_KINDS as readonly string[]).includes(kind);

export const KEY_SCHEMA_VERSION = 1;

export const KeyFields = Schema.Struct({
  repositoryId: Schema.String,
  kind: Schema.Literals(CACHE_KINDS),
  namespace: Schema.String,
  platform: Schema.Struct({ os: Schema.String, arch: Schema.String }),
  imageDigest: Schema.String,
  /** Every toolchain version, the native libraries built into the image included. */
  toolchains: Schema.Record(Schema.String, Schema.String),
  /** The producing primitive's name, version and parameters, hashed. */
  producerDigest: Schema.String,
  /** For example the lockfile's SHA-256. */
  inputsDigest: Schema.String,
});
export type KeyFields = typeof KeyFields.Type;

/** A primitive could not compute a key field; it skips both the cache read and the cache write (FD-CACHE-032). */
export class KeyIncomplete extends Schema.TaggedError<KeyIncomplete>()("KeyIncomplete", {
  missing: Schema.Array(Schema.String),
}) {}

/** A path the cache must not hold: inside the checkout, the workspace or a build-output directory (FD-CACHE-001). */
export class NotCacheable extends Schema.TaggedError<NotCacheable>()("NotCacheable", {
  path: Schema.String,
  reason: Schema.String,
}) {}

const REQUIRED = [
  "repositoryId",
  "kind",
  "namespace",
  "platform",
  "imageDigest",
  "toolchains",
  "producerDigest",
  "inputsDigest",
] as const;

const blank = (v: unknown) =>
  v === undefined || v === null || v === "" || (typeof v === "object" && Object.keys(v).length === 0);

/**
 * The cache key (FD-CACHE-031): lowercase hex SHA-256 of the canonical JSON of the key-schema version and the eight
 * fields. A field that is absent, empty, or a platform without OS or architecture fails with `KeyIncomplete`.
 */
export const cacheKey = (fields: Partial<KeyFields>): Effect.Effect<string, KeyIncomplete> =>
  Effect.gen(function* () {
    const missing: string[] = REQUIRED.filter((f) => blank(fields[f]));
    if (fields.platform !== undefined) {
      if (blank(fields.platform.os)) missing.push("platform.os");
      if (blank(fields.platform.arch)) missing.push("platform.arch");
    }
    if (fields.kind !== undefined && !isCacheKind(fields.kind)) missing.push("kind");
    if (missing.length > 0) return yield* Effect.fail(new KeyIncomplete({ missing }));
    const f = fields as KeyFields;
    return yield* Effect.promise(() =>
      sha256Hex(
        canonicalJson({
          v: KEY_SCHEMA_VERSION,
          repository_id: f.repositoryId,
          kind: f.kind,
          namespace: f.namespace,
          platform: { os: f.platform.os, arch: f.platform.arch },
          image_digest: f.imageDigest,
          toolchains: f.toolchains,
          producer_digest: f.producerDigest,
          inputs_digest: f.inputsDigest,
        }),
      ),
    );
  });

// ---- native libraries ----------------------------------------------------------

/** The architectures the sandbox image pins every prebuilt native library for (FD-CACHE-036). */
export const NATIVE_LIBRARY_ARCHES = ["amd64", "arm64"] as const;
export type NativeLibraryArch = (typeof NATIVE_LIBRARY_ARCHES)[number];

/** A prebuilt native library the sandbox image carries: its release version and each architecture's SHA-256. */
export interface NativeLibrary {
  readonly name: string;
  readonly version: string;
  readonly sha256: Readonly<Record<NativeLibraryArch, string>>;
}

/**
 * The prebuilt native libraries of the Rust sandbox image (`infra/Dockerfile.sandbox-demo` with `WITH_RUST=true`),
 * each the release archive the image downloads for its build architecture and checks against the digest here.
 */
export const SANDBOX_NATIVE_LIBRARIES: readonly NativeLibrary[] = [
  {
    name: "libduckdb",
    version: "v1.5.5",
    sha256: {
      amd64: "1fb8ce388157d84a25abe685a8a2520bf00c00321821968e4bb398fd766e7abb",
      arm64: "abe4f6f005ee0b448a058322f4263584b4bd1b6faf7ab4637b79eeaf978f8e9c",
    },
  },
];

/**
 * The image's toolchain versions for a cache key (FD-CACHE-036): `toolchains` with each native library's version under
 * the library's name, so an entry built against one library release never answers a read under another. The image's
 * pinned version replaces a caller's value of the same name.
 */
export const imageToolchains = (
  toolchains: Readonly<Record<string, string>>,
  libraries: readonly NativeLibrary[],
): Record<string, string> => ({
  ...toolchains,
  ...Object.fromEntries(libraries.map((l) => [l.name, l.version])),
});

/** The producer digest: SHA-256 of the canonical JSON of the primitive's name, version and parameters. */
export const producerDigest = (name: string, version: string, params: unknown = {}) =>
  sha256Hex(canonicalJson({ name, version, params }));

// ---- installCached -----------------------------------------------------------

export type PackageManager = "pnpm" | "npm" | "cargo" | "uv";

/** The install outputs each manager's `installCached` caches, relative to the job's home; never the checkout. */
export const INSTALL_OUTPUTS: Readonly<Record<PackageManager, readonly string[]>> = {
  pnpm: [".local/share/pnpm/store"],
  npm: [".npm/_cacache"],
  cargo: [".cargo/registry/index", ".cargo/registry/cache", ".cargo/git/db"],
  uv: [".cache/uv"],
};

const LOCKFILES: Readonly<Record<PackageManager, string>> = {
  pnpm: "pnpm-lock.yaml",
  npm: "package-lock.json",
  cargo: "Cargo.lock",
  uv: "uv.lock",
};

export const lockfileOf = (manager: PackageManager) => LOCKFILES[manager];

/**
 * `installCached`'s declared inputs (FD-CACHE-033): the SHA-256 of the lockfile's bytes, and the install outputs to
 * cache. A missing lockfile leaves the key incomplete, so the primitive installs uncached.
 */
export const installCachedInputs = (
  manager: PackageManager,
  lockfile: Uint8Array | undefined,
): Effect.Effect<{ readonly inputsDigest: string; readonly paths: readonly string[] }, KeyIncomplete> =>
  lockfile === undefined
    ? Effect.fail(new KeyIncomplete({ missing: [`inputsDigest (${LOCKFILES[manager]})`] }))
    : Effect.promise(async () => ({
        inputsDigest: await sha256Hex(lockfile),
        paths: INSTALL_OUTPUTS[manager],
      }));

/**
 * Refuses a path inside the checkout, the workspace or a build-output directory (FD-CACHE-001, FD-CACHE-002): only
 * the kinds of `CACHE_KINDS` live in the cache, and a workspace never moves from one executor to another.
 */
export const assertCacheable = (
  path: string,
  sandbox: { readonly workspace: string; readonly buildOutputs: readonly string[] },
): Effect.Effect<string, NotCacheable> => {
  const inside = (root: string) => path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);
  if (inside(sandbox.workspace))
    return Effect.fail(new NotCacheable({ path, reason: "inside the workspace or checkout" }));
  const output = sandbox.buildOutputs.find(inside);
  if (output !== undefined)
    return Effect.fail(new NotCacheable({ path, reason: `inside build output ${output}` }));
  return Effect.succeed(path);
};

// ---- prebuilt binaries ---------------------------------------------------------

export interface PrebuiltBinaryInputs {
  /** Git object ids of the key files. */
  readonly keyFiles: Readonly<Record<string, string>>;
  /** Git object ids of the path dependencies' trees. */
  readonly pathDependencies: Readonly<Record<string, string>>;
  /** Git object ids of the `include!` targets. */
  readonly includeTargets: Readonly<Record<string, string>>;
  readonly rustc: string;
  readonly cargo: string;
}

/** The prebuilt-binary primitive's declared-inputs digest (FD-CACHE-034). */
export const prebuiltBinaryInputsDigest = (inputs: PrebuiltBinaryInputs) =>
  sha256Hex(
    canonicalJson({
      key_files: inputs.keyFiles,
      path_dependencies: inputs.pathDependencies,
      include_targets: inputs.includeTargets,
      rustc: inputs.rustc,
      cargo: inputs.cargo,
    }),
  );

/**
 * The prebuilt-binary primitive's restore (FD-CACHE-035): a miss, a restore failure or an incomplete key falls back to
 * `cargo run`, and none of them fails the run.
 */
export const restoreOrCargoRun = <A, E, R, E2, R2>(
  restore: Effect.Effect<A | null, E, R>,
  cargoRun: Effect.Effect<A, E2, R2>,
): Effect.Effect<{ readonly value: A; readonly restored: boolean }, E2, R | R2> =>
  Effect.gen(function* () {
    const hit: A | null = yield* restore.pipe(Effect.orElseSucceed(() => null));
    if (hit !== null) return { value: hit, restored: true };
    return { value: yield* cargoRun, restored: false };
  });

// ---- compile cache -------------------------------------------------------------

/** What the wrapped command needs: the compile-cache route and the execution's token from its upload grant. */
export interface CompileCacheAccess {
  readonly endpoint: string;
  readonly token: string;
}

/** The env the wrapper exports for sccache's WebDAV backend. */
export const compileCacheEnv = (access: CompileCacheAccess): Record<string, string> => ({
  SCCACHE_WEBDAV_ENDPOINT: access.endpoint,
  SCCACHE_WEBDAV_TOKEN: access.token,
});

const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/**
 * Wraps `command` so its Rust compiles go through sccache (FD-CACHE-037): `RUSTC_WRAPPER=sccache`,
 * `CARGO_INCREMENTAL=0` (sccache refuses incremental compiles) and the key prefix
 * `<repo>/<rustc release>/<target triple>`, read from `rustc -vV` in the checkout so a toolchain pin selects its own
 * prefix; the target triple is `CARGO_BUILD_TARGET` when set and the host triple otherwise. The wrapper starts the sccache server before it exports `RUSTC_WRAPPER`; the server checks its storage at
 * start, so an unreachable endpoint, a refused token or a missing binary leaves `RUSTC_WRAPPER` unset and rustc
 * compiles locally (FD-CACHE-038). `SCCACHE_IGNORE_SERVER_IO_ERROR=1` compiles locally when the client loses the
 * server mid-compile. The command runs in a subshell and the wrapper exits with its status.
 */
export const compileCacheCommand = (command: string, repo: string): string | undefined => {
  if (!REPO_SLUG.test(repo)) return undefined;
  return [
    "fd_cc_on=0",
    'if command -v sccache >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1 && [ -n "${SCCACHE_WEBDAV_ENDPOINT:-}" ] && [ -n "${SCCACHE_WEBDAV_TOKEN:-}" ]; then',
    '  fd_cc_vv="$(rustc -vV 2>/dev/null)"',
    "  fd_cc_release=\"$(printf '%s\\n' \"$fd_cc_vv\" | sed -n 's/^release: //p')\"",
    "  fd_cc_host=\"${CARGO_BUILD_TARGET:-$(printf '%s\\n' \"$fd_cc_vv\" | sed -n 's/^host: //p')}\"",
    '  if [ -n "$fd_cc_release" ] && [ -n "$fd_cc_host" ]; then',
    `    export SCCACHE_WEBDAV_KEY_PREFIX="${repo.toLowerCase()}/$fd_cc_release/$fd_cc_host"`,
    "    export CARGO_INCREMENTAL=0 SCCACHE_IDLE_TIMEOUT=0 SCCACHE_IGNORE_SERVER_IO_ERROR=1",
    "    if sccache --start-server >/dev/null 2>&1; then",
    "      export RUSTC_WRAPPER=sccache",
    "      fd_cc_on=1",
    "    else",
    "      echo 'compile cache: sccache server did not start; compiling locally' >&2",
    "    fi",
    "  fi",
    "else",
    "  echo 'compile cache: sccache, rustc or cache access unavailable; compiling locally' >&2",
    "fi",
    "(",
    command,
    ")",
    "fd_cc_status=$?",
    'if [ "$fd_cc_on" = 1 ]; then',
    "  echo '--- sccache --show-stats ---'",
    "  sccache --show-stats || true",
    "  sccache --stop-server >/dev/null 2>&1 || true",
    "fi",
    "exit $fd_cc_status",
  ].join("\n");
};
