// Pure helper for the `Artifact` Layer's container-tar branch. Kept out of
// `artifact-r2.ts` so unit tests can exercise it without pulling in the
// `@cloudflare/sandbox` runtime import (which only resolves under
// `vitest-pool-workers` / a live Workers env). Same split as
// `sandbox-clone-url.ts` next to `sandbox-cf.ts`.

/**
 * Split a filesystem path into `{ parent, basename }` so the container can
 * tar it with `tar -C parent basename`, producing a clean archive whose
 * entries are rooted at `basename/...` rather than at the absolute path the
 * caller happened to pass in.
 *
 * Behaviour:
 *   - A trailing slash on the input is stripped (`/a/b/` → `/a/b`).
 *   - An absolute path under root maps to `{ parent: "/", basename: "..." }`.
 *   - A relative path with no slash maps to `{ parent: ".", basename: "..." }`
 *     so `tar -C .` keeps the run's working directory as the implicit root.
 *   - An empty path normalises to `{ parent: ".", basename: "" }` — the
 *     caller should treat that as a misconfig.
 */
export const splitTarPath = (
  path: string,
): { parent: string; basename: string } => {
  const norm = path.replace(/\/+$/, "");
  if (norm === "") return { parent: ".", basename: "" };
  const slash = norm.lastIndexOf("/");
  if (slash < 0) return { parent: ".", basename: norm };
  if (slash === 0) return { parent: "/", basename: norm.slice(1) };
  return { parent: norm.slice(0, slash), basename: norm.slice(slash + 1) };
};

/**
 * Decide the container upload shape from `stat -c %F` output. A regular
 * file streams to R2 un-tarred (so `GET /v1/artifacts/<exec>/<name>` serves
 * the file itself, honouring the caller's `contentType`); anything else —
 * directory, symlink, device — takes the tar branch. GNU coreutils prints
 * `regular empty file` for zero-byte files, so both spellings count.
 */
export const isRegularFileStat = (stdout: string): boolean => {
  const fileType = stdout.trim();
  return fileType === "regular file" || fileType === "regular empty file";
};

/**
 * Compose a unique scratch path inside the container for a tar archive. The
 * artifact `name` is sanitised (path-segments / spaces collapsed to `-`) and
 * a per-invocation suffix avoids collisions between concurrent uploads of
 * different artifacts from the same execution.
 */
export const containerTarballPath = (
  name: string,
  randomSuffix: string,
): string => {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const stem = safe === "" ? "artifact" : safe;
  return `/tmp/fd-artifact-${stem}-${randomSuffix}.tar.gz`;
};
