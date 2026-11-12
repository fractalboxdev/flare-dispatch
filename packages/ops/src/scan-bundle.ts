// The drift check's scan-bundle step (specs/operability.md § Scan bundle and advisory snapshot, FD-OPS-094 to
// FD-OPS-098). Where the overlay pins `scan.bundleDigest`, the envelope at `scan.bundleFile` must have that SHA-256, a
// signature under a `scan.bundleKeys` key whose window holds the one verification time the step sampled, and a
// payload that passes the scan bundle schema; then every container image the rendered Workers name must declare a
// version of each scanner inside the payload's `scanners.<name>.versions`. The envelope model is the catalogue's, so
// the deploy and the scan read one schema.
import {
  SCANNERS,
  satisfies,
  verifyScanBundle,
  type ScanBundlePayload,
  type ScanBundleRejection,
  type Scanner,
} from "@fractalboxdev/flare-dispatch-catalog";
import { Effect, Match, Result } from "effect";
import type { Finding } from "./drift.ts";
import type { OverlayValues } from "./overlay.ts";
import type { WorkerConfig } from "./render.ts";

const fail = (path: string, detail: string): Finding => ({
  check: "scan-bundle",
  path,
  detail,
  severity: "failure",
});

/** The finding of one rejected envelope, naming the overlay value or payload path it fails at. */
export const rejectionFinding = (rejection: ScanBundleRejection): Finding =>
  Match.value(rejection).pipe(
    Match.tagsExhaustive({
      ScanBundleDigestMismatch: (e) =>
        fail(
          "scan.bundleDigest",
          `the envelope's SHA-256 is ${e.actual}, not scan.bundleDigest ${e.expected}`,
        ),
      ScanBundleMalformed: (e) => fail("scan.bundleFile", `the envelope is unusable: ${e.detail}`),
      ScanBundleUnsigned: (e) => fail("scan.bundleKeys", e.detail),
      ScanBundleSchemaInvalid: (e) =>
        fail(
          "scan.bundleFile",
          `the payload fails the scan bundle schema at ${e.path === "" ? "its root" : e.path}: ${e.message}`,
        ),
    }),
  );

// ---- Scanner versions of the rendered images (FD-OPS-098) ----------------------------

/** The Dockerfile build argument that declares a scanner's version: `GITLEAKS_VERSION`, `OSV_SCANNER_VERSION`. */
export const versionArg = (scanner: Scanner): string =>
  `${scanner.toUpperCase().replaceAll("-", "_")}_VERSION`;

const ARG_LINE = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/;

/**
 * Each scanner's version a Dockerfile declares: the default of its last `ARG <SCANNER>_VERSION=<version>` line. A
 * scanner with no such line, or with an empty default, has no declared version.
 */
export const declaredScannerVersions = (dockerfile: string): Partial<Record<Scanner, string>> => {
  const args = new Map<string, string>();
  for (const line of dockerfile.split(/\r?\n/)) {
    const m = ARG_LINE.exec(line);
    if (m !== null) args.set(m[1]!, m[2] ?? m[3] ?? m[4] ?? "");
  }
  const declared: Partial<Record<Scanner, string>> = {};
  for (const scanner of SCANNERS) {
    const version = args.get(versionArg(scanner));
    if (version !== undefined && version !== "") declared[scanner] = version;
  }
  return declared;
};

/** One container image the rendered Workers name: its path from the repository root and each container naming it. */
export interface RenderedImage {
  readonly image: string;
  readonly containers: readonly string[];
}

/** `rel` joined onto the directory `dir` and normalized, as a `/`-separated path; an absolute `rel` stands alone. */
const joinPath = (dir: string, rel: string): string => {
  const absolute = rel.startsWith("/");
  const parts: string[] = [];
  for (const part of (absolute ? rel : `${dir}/${rel}`).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !absolute) parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
};

const dirOf = (path: string | undefined): string =>
  path === undefined || !path.includes("/") ? "" : path.slice(0, path.lastIndexOf("/"));

/**
 * The distinct container images of the rendered Workers, in first-named order. Wrangler resolves a container's
 * `image` beside the configuration file, so the path is relative to the Worker's template directory.
 */
export const renderedImages = (
  rendered: readonly {
    readonly worker: string;
    readonly config: WorkerConfig;
    readonly templatePath?: string;
  }[],
): readonly RenderedImage[] => {
  const byImage = new Map<string, string[]>();
  for (const r of rendered) {
    const containers = Array.isArray(r.config["containers"])
      ? (r.config["containers"] as { class_name?: unknown; image?: unknown }[])
      : [];
    for (const c of containers) {
      if (typeof c.image !== "string" || c.image === "") continue;
      const image = joinPath(dirOf(r.templatePath), c.image);
      const at = `${r.worker}.containers.${typeof c.class_name === "string" ? c.class_name : "?"}`;
      byImage.set(image, [...(byImage.get(image) ?? []), at]);
    }
  }
  return [...byImage].map(([image, containers]) => ({ image, containers }));
};

/**
 * One failure per scanner of each image whose declared version lies outside the payload's `scanners.<name>.versions`,
 * or that declares none. `dockerfile` is the image's Dockerfile text, `null` where the deploy host holds no such file:
 * such an image declares no version.
 */
export const scannerVersionFindings = (
  scanners: ScanBundlePayload["scanners"],
  images: readonly (RenderedImage & { readonly dockerfile: string | null })[],
): readonly Finding[] =>
  images.flatMap(({ image, containers, dockerfile }) => {
    const declared = dockerfile === null ? {} : declaredScannerVersions(dockerfile);
    const named = `the image ${image} (${containers.join(", ")})`;
    return SCANNERS.flatMap((scanner) => {
      const range = scanners[scanner].versions;
      const version = declared[scanner];
      if (version !== undefined && satisfies(version, range)) return [];
      return [
        fail(
          `scanners.${scanner}.versions`,
          version === undefined
            ? `${named} declares no ${scanner} version (ARG ${versionArg(scanner)})${dockerfile === null ? ", and the deploy host holds no Dockerfile there" : ""}, so none lies inside ${range}`
            : `${named} holds ${scanner} ${version}, outside scanners.${scanner}.versions ${range}`,
        ),
      ];
    });
  });

/**
 * The scan-bundle findings of an overlay, given the envelope file's bytes (`null` where no such file exists), the
 * verification time, the rendered Workers' container images and the read of a deploy-host file. An overlay that pins
 * no digest has none, and an envelope that fails verification has only its rejection: the images are read only
 * against a verified payload.
 */
export const scanBundleFindings = <E>(
  scan: OverlayValues["scan"],
  bytes: Uint8Array | null,
  at: number,
  images: readonly RenderedImage[],
  read: (path: string) => Effect.Effect<Uint8Array | null, E>,
): Effect.Effect<readonly Finding[], E> =>
  Effect.gen(function* () {
    const digest = scan?.bundleDigest;
    if (digest === undefined) return [];
    if (scan?.bundleFile === undefined)
      return [fail("scan.bundleFile", "the overlay pins scan.bundleDigest and names no scan.bundleFile")];
    if (bytes === null) return [fail("scan.bundleFile", `no envelope at ${scan.bundleFile}`)];
    const verified = yield* Effect.result(
      verifyScanBundle({ bytes, digest, keys: scan.bundleKeys ?? [], at }),
    );
    if (Result.isFailure(verified)) return [rejectionFinding(verified.failure)];
    const declaring: (RenderedImage & { readonly dockerfile: string | null })[] = [];
    for (const image of images) {
      const file = yield* read(image.image);
      declaring.push({ ...image, dockerfile: file === null ? null : new TextDecoder().decode(file) });
    }
    return scannerVersionFindings(verified.success.payload.scanners, declaring);
  });
