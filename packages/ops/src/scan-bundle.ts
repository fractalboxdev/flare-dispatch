// The drift check's scan-bundle step (specs/operability.md § Scan bundle and advisory snapshot, FD-OPS-094 to
// FD-OPS-097). Where the overlay pins `scan.bundleDigest`, the envelope at `scan.bundleFile` must have that SHA-256, a
// signature under a `scan.bundleKeys` key whose window holds the one verification time the step sampled, and a
// payload that passes the scan bundle schema. The envelope model is the catalogue's, so the deploy and the scan read
// one schema.
import { verifyScanBundle, type ScanBundleRejection } from "@fractalboxdev/flare-dispatch-catalog";
import { Effect, Match } from "effect";
import type { Finding } from "./drift.ts";
import type { OverlayValues } from "./overlay.ts";

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

/**
 * The scan-bundle findings of an overlay, given the envelope file's bytes (`null` where no such file exists) and the
 * verification time. An overlay that pins no digest has none.
 */
export const scanBundleFindings = (
  scan: OverlayValues["scan"],
  bytes: Uint8Array | null,
  at: number,
): Effect.Effect<readonly Finding[]> =>
  Effect.gen(function* () {
    const digest = scan?.bundleDigest;
    if (digest === undefined) return [];
    if (scan?.bundleFile === undefined)
      return [fail("scan.bundleFile", "the overlay pins scan.bundleDigest and names no scan.bundleFile")];
    if (bytes === null) return [fail("scan.bundleFile", `no envelope at ${scan.bundleFile}`)];
    return yield* verifyScanBundle({ bytes, digest, keys: scan.bundleKeys ?? [], at }).pipe(
      Effect.map(() => [] as readonly Finding[]),
      Effect.catch((rejection) => Effect.succeed([rejectionFinding(rejection)])),
    );
  });
