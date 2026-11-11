// The deploy suite of `V-DEPLOY` for the sandbox image's prebuilt native libraries (specs/cache-artifacts.md § Cache
// keys): every container image a committed Worker configuration builds is read from its Dockerfile, and each native
// library it downloads must be pinned by SHA-256 for `linux/amd64` and `linux/arm64` at the version and digests of
// `SANDBOX_NATIVE_LIBRARIES`, the declaration that carries the version into the cache key's toolchains.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  imageToolchains,
  NATIVE_LIBRARY_ARCHES,
  SANDBOX_NATIVE_LIBRARIES,
  type NativeLibraryArch,
} from "@fractalboxdev/flare-dispatch-cache";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../../src/index.ts";
import { repositoryRoot } from "../../src/cli/index.ts";

const ROOT = repositoryRoot(import.meta.dirname);

/** The committed Worker configurations that declare container classes. */
const CONFIGS = ["wrangler.jsonc", "apps/control-plane/wrangler.jsonc", "apps/substrate/wrangler.jsonc"];

/** `uname -m` in a build container, as the Docker platform architecture. */
const UNAME_ARCH: Readonly<Record<string, NativeLibraryArch>> = { x86_64: "amd64", aarch64: "arm64" };

interface ContainerImage {
  readonly config: string;
  readonly className: string;
  readonly dockerfile: string;
  readonly vars: Readonly<Record<string, string>>;
}

/** A native library one RUN instruction downloads and installs. */
interface NativeDownload {
  readonly name: string;
  /** The build argument the RUN is gated on (`if [ "$X" = "true" ]`), if any. */
  readonly gate: string | undefined;
  readonly version: string | undefined;
  readonly sha256: Partial<Record<NativeLibraryArch, string>>;
  readonly verifies: boolean;
}

const containerImages = (): ContainerImage[] =>
  CONFIGS.flatMap((config) => {
    const parsed = parseJsonc(readFileSync(join(ROOT, config), "utf8"));
    const containers = (parsed["containers"] ?? []) as readonly Record<string, unknown>[];
    return containers.flatMap((c) => {
      const image = c["image"];
      if (typeof image !== "string" || !image.startsWith(".")) return [];
      return [
        {
          config,
          className: String(c["class_name"]),
          dockerfile: relative(ROOT, join(ROOT, dirname(config), image)),
          vars: (c["image_vars"] ?? {}) as Record<string, string>,
        },
      ];
    });
  });

/** The Dockerfile's instructions, continuation lines joined and comment lines dropped as Docker drops them. */
const instructions = (dockerfile: string): string[] => {
  const out: string[] = [];
  let current = "";
  for (const line of dockerfile.split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const continued = line.trimEnd().endsWith("\\");
    current += ` ${continued ? line.trimEnd().slice(0, -1) : line}`;
    if (!continued) {
      if (current.trim() !== "") out.push(current.trim());
      current = "";
    }
  }
  return out;
};

/** Each RUN instruction that downloads an archive and installs a `lib<name>.so` from it. */
const nativeDownloads = (dockerfile: string): NativeDownload[] => {
  const all = instructions(dockerfile);
  const args = new Map(
    all.flatMap((i) => {
      const m = /^ARG\s+(\w+)=(\S+)/.exec(i);
      return m === null ? [] : [[m[1]!, m[2]!] as const];
    }),
  );
  return all.flatMap((i) => {
    const lib = /\b(lib[\w-]+)\.so\b/.exec(i);
    if (!i.startsWith("RUN ") || lib === null || !/\bcurl\b/.test(i)) return [];
    const sha256: Partial<Record<NativeLibraryArch, string>> = {};
    for (const arm of i.split(";;")) {
      const m = /\b(x86_64|aarch64)\)(.*)$/s.exec(arm);
      const digest = m === null ? null : /\bsha256=([0-9a-f]{64})\b/.exec(m[2]!);
      if (m !== null && digest !== null) sha256[UNAME_ARCH[m[1]!]!] = digest[1]!;
    }
    const versionArg = /\$\{(\w+_VERSION)\}/.exec(i)?.[1];
    return [
      {
        name: lib[1]!,
        gate: /if \[ "\$(\w+)" = "true" \]/.exec(i)?.[1],
        version: versionArg === undefined ? undefined : args.get(versionArg),
        sha256,
        verifies: /\bsha256sum -c\b/.test(i),
      },
    ];
  });
};

const carried = (image: ContainerImage, d: NativeDownload) =>
  d.gate === undefined || image.vars[d.gate] === "true";

describe("sandbox image native libraries", () => {
  it("[FD-CACHE-036] every deployed image pins each native library by SHA-256 for amd64 and arm64 at the version the cache key carries", () => {
    const images = containerImages();
    expect(images.length).toBeGreaterThan(0);
    const declared = new Map(SANDBOX_NATIVE_LIBRARIES.map((l) => [l.name, l]));
    const carriedBy = new Map<string, string[]>();
    for (const image of images) {
      const path = join(ROOT, image.dockerfile);
      expect(existsSync(path), `${image.config} ${image.className}: ${image.dockerfile}`).toBe(true);
      for (const d of nativeDownloads(readFileSync(path, "utf8"))) {
        if (!carried(image, d)) continue;
        const where = `${image.config} ${image.className} (${image.dockerfile}) ${d.name}`;
        const library = declared.get(d.name);
        // An undeclared library's version never reaches a cache key.
        expect(library, `${where}: not in SANDBOX_NATIVE_LIBRARIES`).toBeDefined();
        expect(d.version, `${where}: version`).toBe(library!.version);
        expect(d.verifies, `${where}: checks the archive with sha256sum -c`).toBe(true);
        for (const arch of NATIVE_LIBRARY_ARCHES)
          expect(d.sha256[arch], `${where}: linux/${arch} digest`).toBe(library!.sha256[arch]);
        // The image's own version is the one its cache keys carry.
        expect(imageToolchains({}, SANDBOX_NATIVE_LIBRARIES)[d.name]).toBe(d.version);
        carriedBy.set(d.name, [...(carriedBy.get(d.name) ?? []), image.className]);
      }
    }
    // Every declared library is one a deployed image carries, so the declaration names no library the image lacks.
    for (const name of declared.keys())
      expect(carriedBy.get(name) ?? [], `${name}: carried by a deployed image`).not.toEqual([]);
  });

  it("[FD-CACHE-036] an amd64-only native library or a digest that differs from the declaration fails the check", () => {
    const duckdb = SANDBOX_NATIVE_LIBRARIES.find((l) => l.name === "libduckdb")!;
    const committed = readFileSync(join(ROOT, "infra/Dockerfile.sandbox-demo"), "utf8");
    const [download] = nativeDownloads(committed);
    expect(download).toMatchObject({ name: "libduckdb", gate: "WITH_RUST", version: duckdb.version, verifies: true });
    expect(download!.sha256).toEqual(duckdb.sha256);

    const amd64Only = committed.replace(/^\s*aarch64\) asset=linux-arm64;.*\n/m, "");
    expect(amd64Only).not.toBe(committed);
    expect(nativeDownloads(amd64Only)[0]!.sha256.arm64).toBeUndefined();

    const bumped = committed.replace(/^ARG DUCKDB_VERSION=.*$/m, "ARG DUCKDB_VERSION=v1.5.6");
    expect(nativeDownloads(bumped)[0]!.version).not.toBe(duckdb.version);
  });
});
