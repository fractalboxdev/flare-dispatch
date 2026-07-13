// FlareDispatch Dispatcher — `GET /v1/artifacts/:execution/:name`.
//
// Serves a per-execution artifact (V0: the `offload-test` step log) so the
// check-run summary's "view logs" / "Full report" links resolve. The artifact
// lives in R2 at `artifacts/<execution>/<name>` — exactly the key
// `R2ArtifactLive.upload` (packages/runtime-cf) writes; this route is the read
// side of that contract.
//
// --- Design decision: STREAM the R2 body, do NOT 302 to a presigned URL -----
//
// specs/pm/plan.md § 1 sketches "302-redirect to a short-lived R2 signed URL",
// but a *true* R2 presigned URL is an S3-API signature requiring an R2 S3
// access-key-id + secret — credentials that are NOT in the V0 secret set
// (specs/05-byoc.md § Secrets lists only `HMAC_SECRET`, `GITHUB_APP_ID`,
// `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`). PR5's mandate (plan § 6,
// "Artifact endpoint scope") is only that the endpoint EXISTS so the link
// resolves.
//
// Two correct options were available:
//   (a) stream the R2 object body straight through this Worker, or
//   (b) 302 to a Worker-self-signed expiring URL that the same Worker verifies
//       on a follow-up GET.
//
// This route implements (a). Rationale: (a) is one R2 `get` + one `Response`;
// (b) adds a second round-trip, an HMAC sign/verify of a query param, an
// expiry clock, and a second code path — all to reach the same bytes through
// the same Worker, since without S3 credentials the "signed URL" can only
// point back at this Worker anyway. Streaming is the strictly simpler correct
// option and the link resolves in one hop. When real R2 S3 credentials enter
// the secret set (V1+), this route can switch to issuing a genuine presigned
// URL + 302 with no change to its callers — the `/v1/artifacts/...` path is
// stable.
//
// The R2 `get` returns the body as a `ReadableStream`, so large artifacts are
// streamed, never buffered. `content-type` is taken from the stored object's
// `httpMetadata` (set at upload time), defaulting to `application/octet-stream`.
//
// Spec: specs/pm/plan.md § PR5 + § 6, specs/03-dsl.md § artifact,
//       specs/05-byoc.md § R2 layout.

import type { Env } from "../env";
import { artifactKey, jsonError, streamObject } from "../r2-object";

/** Artifacts are immutable per execution+name — safe to cache hard. */
const ARTIFACT_CACHE = "private, max-age=31536000, immutable";

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Render a minimal HTML listing of the expanded files under an artifact —
 * the fallback browse surface when the bundle has no `index.html` of its own
 * (e.g. a screenshots tree), mirroring an object-store directory index.
 */
const directoryIndex = async (
  env: Env,
  execution: string,
  name: string,
): Promise<Response | null> => {
  const prefix = `${artifactKey(execution, name)}/`;
  const listed = await env.RUNS_STORAGE.list({ prefix, limit: 1000 });
  if (listed.objects.length === 0) return null;

  const rows = listed.objects
    .map((o) => {
      const rel = o.key.slice(prefix.length);
      const href = rel.split("/").map(encodeURIComponent).join("/");
      const kb = (o.size / 1024).toFixed(1);
      return `<li><a href="${href}">${escapeHtml(rel)}</a> <small>${kb} KB</small></li>`;
    })
    .join("\n");
  const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(
    name,
  )} — ${escapeHtml(execution)}</title><h1>${escapeHtml(name)}</h1><p><a href="../${encodeURIComponent(
    name,
  )}">download .tar.gz</a></p><ul>\n${rows}\n</ul>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

/**
 * Handle `GET /v1/artifacts/:execution/:name[/...path]`.
 *
 * - Bare `:name` — stream the artifact object itself (a step log, or a
 *   container-tar bundle's `.tar.gz`): the stable download URL.
 * - `:name/<path>` — stream one file the upload-time browse expansion stored
 *   under the bundle (`tar-extract.ts` in runtime-cf), so an HTML report is
 *   served as a working static site.
 * - `:name/` (trailing slash) — the browse entrypoint: the bundle's own
 *   `index.html` when it has one, else a generated directory listing.
 *
 * @param env        binding env (`RUNS_STORAGE`).
 * @param execution  the execution ULID path segment.
 * @param name       the artifact name path segment.
 * @param subPath    path inside the expanded bundle; `""` with
 *                   `wantsIndex: true` for the trailing-slash entrypoint.
 * @returns `200` streaming the body, or `404` if no such object.
 */
export const handleArtifact = async (
  env: Env,
  execution: string,
  name: string,
  subPath = "",
  wantsIndex = false,
): Promise<Response> => {
  if (wantsIndex && subPath === "") {
    const index = await streamObject(
      env.RUNS_STORAGE,
      `${artifactKey(execution, name)}/index.html`,
      { cacheControl: ARTIFACT_CACHE },
    );
    if (index !== null) return index;
    const listing = await directoryIndex(env, execution, name);
    if (listing !== null) return listing;
    return jsonError(
      "artifact_not_browsable",
      `artifact "${name}" has no expanded contents to browse — fetch the bundle at its bare URL instead`,
      404,
    );
  }

  const key =
    subPath === ""
      ? artifactKey(execution, name)
      : `${artifactKey(execution, name)}/${subPath}`;
  const response = await streamObject(env.RUNS_STORAGE, key, {
    cacheControl: ARTIFACT_CACHE,
  });
  return (
    response ?? jsonError("artifact_not_found", `no artifact at "${key}"`, 404)
  );
};
