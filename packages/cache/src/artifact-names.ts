// The artifact name grammar (specs/cache-artifacts.md § Artifacts). It names no Workers type, so a writer outside a
// Worker imports it as `@fractalboxdev/flare-dispatch-cache/artifact-names`.

/**
 * An artifact name is one key segment of `artifact/<execution_id>/<epoch>/<name>`: 1 to 128 letters, digits, `.`, `_`
 * and `-`, not starting with `.` (FD-CACHE-070, MAMEKO-PROTO-061).
 */
export const ARTIFACT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** FD-CACHE-070: a name the artifact store accepts. */
export const validArtifactName = (name: string): boolean => ARTIFACT_NAME.test(name);

const BROWSE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/**
 * A file path inside a directory artifact's browse expansion (FD-CACHE-073): `/`-separated segments with no `.`, `..`
 * or empty segment.
 */
export const validBrowsePath = (path: string): boolean =>
  BROWSE_PATH.test(path) && !path.split("/").some((s) => s === ".." || s === "." || s === "");
