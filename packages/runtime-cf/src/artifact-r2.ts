// @fractalboxdev/flare-dispatch-runtime-cf — R2ArtifactLive: the live `artifact` capability.
//
// Backs `ArtifactService` with the R2 bucket binding. Two upload modes:
//
//   1. **R2-source-key mode** — `artifact.upload({ name, path })` with no
//      `container`. `path` is an existing R2 object key (e.g. the
//      `logs/<execId>/<step>.ndjson` key `SandboxCloudflareLive.exec`
//      streamed). The object is copied to the stable `artifacts/<execId>/<name>`
//      key. This is the path `offload-test` rides on.
//
//   2. **Container mode** — `artifact.upload({ name, path, container })`.
//      `path` is a filesystem path inside the sandbox container. A DIRECTORY
//      (a Playwright `outputDir`, a built site, a coverage tree) is tarred +
//      gzipped inside the container and the archive streamed to R2 under the
//      stable key, plus a best-effort browse expansion. A single regular
//      FILE streams to R2 as-is with the caller's `contentType` — tarring it
//      stamped that content type onto a gzip archive, so a `.png` artifact
//      rendered as a broken image in every browser (the bytes weren't a
//      PNG). `playwright-demo` (directory bundle) and `product-demo` (story
//      screenshots) ride on this mode.
//
// Either way, the returned URL is `/v1/artifacts/<execId>/<name>` — a stable
// path served by the Dispatcher's `GET /v1/artifacts/:execution/:name` route.
//
// --- Scope, documented (specs/pm/plan.md § 6 "Artifact endpoint scope") ------
//
// `signedUrlTTL` is accepted on the `upload` opts (the `ArtifactService`
// interface declares it) but is **not yet enforced** by this layer — every
// caller receives the same `/v1/artifacts/...` URL the dispatcher serves
// without per-request TTL semantics. Wiring a signed-token query param +
// TTL check on the artifact route is the natural next step; the current
// behaviour matches the V0 commitment ("a stable `/v1/artifacts/...`-shaped
// path is fine — the signing endpoint itself is PR5").
//
// --- Verification scope -------------------------------------------------------
//
// The container branch (`box.exec` for stat/tar + `readFileStream` for
// upload) cannot run in `vitest-pool-workers` — Miniflare has no container
// runtime, same constraint as `sandbox-cf.ts` and `cache-r2.ts`. Pure helpers
// (`splitTarPath`, `containerTarballPath`, `isRegularFileStat`) live in
// `artifact-tar-path.ts` with their own unit tests; the orchestration here is
// verified by typecheck + `wrangler deploy --dry-run` + a `wrangler dev`
// acceptance.
//
// Spec: specs/03-dsl.md § artifact, specs/05-byoc.md § R2 layout, plan § PR4.

// `getSandbox` is dynamically imported inside the container-tar branch so the
// top-level module stays loadable under plain Node Vitest — the existing
// R2-source-key tests in `artifact-r2.test.ts` would otherwise fail to import
// the SDK's transitive `@cloudflare/containers` runtime. Same trick the rest
// of `runtime-cf` avoids by colocating sandbox-bound code in `cache-r2.ts` /
// `sandbox-cf.ts`; here both branches live in one file because they share the
// `R2ArtifactLive` Service shape.
import type { Sandbox } from "@cloudflare/sandbox";
import { Effect, Layer } from "effect";
import {
  Artifact,
  ArtifactUploadFailed,
  type ArtifactService,
} from "@fractalboxdev/flare-dispatch-core";
import {
  containerTarballPath,
  isRegularFileStat,
  splitTarPath,
} from "./artifact-tar-path";
import { readContainerFile } from "./container-file-stream";
import { putStream } from "./r2-put-stream";
import { expandTarGzToR2 } from "./tar-extract";

/** R2 key prefix for per-execution artifacts. */
const artifactKey = (executionId: string, name: string): string =>
  `artifacts/${executionId}/${name}`;

/**
 * The stable, PR5-signable artifact path embedded in the check-run summary.
 *
 * `publicOrigin`, when known, makes the URL absolute. A relative path here is
 * a trap: the check-run summary is GitHub-rendered markdown, and GitHub
 * resolves a relative `/v1/artifacts/...` link against `github.com` — so every
 * artifact link in a check-run 404'd as `https://github.com/v1/artifacts/...`.
 * Without an origin (a deploy with no `PUBLIC_ORIGIN` var and a cron dispatch
 * that has no request to infer it from) the path stays relative — correct for
 * same-origin API consumers, still broken on GitHub until the var is set.
 */
const artifactUrl = (
  executionId: string,
  name: string,
  publicOrigin?: string,
): string =>
  `${publicOrigin === undefined ? "" : publicOrigin.replace(/\/+$/, "")}/v1/artifacts/${encodeURIComponent(executionId)}/${encodeURIComponent(name)}`;

/**
 * Build the live `Artifact` Layer bound to an R2 bucket and an execution id.
 *
 * @param bucket       the R2 binding (`env.RUNS_STORAGE`).
 * @param executionId  the current execution — namespaces the artifact key.
 * @param ns           the `RUNS_SANDBOX` DurableObjectNamespace<Sandbox>,
 *                     supplied when a run might invoke container-tar mode
 *                     (every production wire-up). `undefined` in unit tests
 *                     that only exercise R2-source-key mode; a call into the
 *                     container branch without `ns` fails with a clear error.
 * @param publicOrigin the dispatcher's public origin (e.g.
 *                     `https://<worker>.<account>.workers.dev`) prefixed onto
 *                     returned artifact URLs so they survive GitHub's
 *                     markdown base-URL resolution. `undefined` → relative.
 */
export const makeR2ArtifactLive = (
  bucket: R2Bucket,
  executionId: string,
  ns?: DurableObjectNamespace<Sandbox>,
  publicOrigin?: string,
): Layer.Layer<Artifact> => {
  const service: ArtifactService = {
    upload: ({ name, path, contentType, container }) =>
      Effect.tryPromise({
        try: async () => {
          const key = artifactKey(executionId, name);

          if (container !== undefined) {
            // Container mode — stream the on-disk `path` out of the sandbox
            // into R2 (never buffer it whole): single files as-is, directories
            // as a tar.gz. Mirrors the cache-r2.ts pattern for the archive leg.
            if (ns === undefined) {
              throw new Error(
                "artifact.upload({ container }) called but no Sandbox namespace was wired into R2ArtifactLive — see makeR2ArtifactLive's `ns` argument",
              );
            }
            const { getSandbox } = await import("@cloudflare/sandbox");
            const box = getSandbox(ns, container.id);

            // Single-file vs directory decides the upload shape. A regular
            // file streams un-tarred so the stable URL serves the file itself
            // under the caller's content type. A failed stat (path missing)
            // falls through to the tar branch, whose own loud error is the
            // established "path must exist" surface.
            const statType = await box.exec(`stat -c %F ${path}`);
            if (statType.exitCode === 0 && isRegularFileStat(statType.stdout)) {
              const { content, size } = await readContainerFile(box, path);
              await putStream(bucket, key, content, size, {
                contentType: contentType ?? "application/octet-stream",
              });
              return artifactUrl(executionId, name, publicOrigin);
            }

            const { parent, basename } = splitTarPath(path);
            if (basename === "") {
              throw new Error(
                `artifact.upload: path "${path}" has no basename to tar`,
              );
            }
            const tarballPath = containerTarballPath(
              name,
              crypto.randomUUID().slice(0, 8),
            );
            const tar = await box.exec(
              `tar czf ${tarballPath} -C ${parent} ${basename}`,
            );
            if (tar.exitCode !== 0) {
              throw new Error(
                `tar czf exited ${tar.exitCode}: ${tar.stderr.trim()}`,
              );
            }
            // `stat` + `readFileStream` — NOT `readFile({encoding:'none'})`:
            // that variant is rpc-transport-only and broke every container-tar
            // upload on the deployed dispatcher (#88) with the cause swallowed.
            // `readFileStream` is the proven pre-#70 path; the byte length R2
            // needs comes from one tiny stat exec.
            const { content, size } = await readContainerFile(box, tarballPath);
            await putStream(bucket, key, content, size, {
              contentType: contentType ?? "application/gzip",
            });
            // Browse expansion — also store each archived file as its own
            // object under `<key>/…` so the dispatcher can serve the
            // artifact's CONTENTS (a Playwright report is a static site)
            // instead of only the archive. Best-effort decoration: a
            // malformed/oversized archive must never fail the upload — the
            // tarball above is already the artifact of record.
            try {
              await expandTarGzToR2(bucket, key, `${key}/`, `${basename}/`);
            } catch (cause) {
              console.warn(
                `artifact "${name}": browse expansion skipped — ${String(cause)}`,
              );
            }
            return artifactUrl(executionId, name, publicOrigin);
          }

          // R2-source-key mode — `path` is an existing R2 object (a step log
          // SandboxCloudflareLive.exec already streamed). Copy it to the
          // stable artifact key.
          const source = await bucket.get(path);
          if (source === null) {
            throw new Error(`artifact source object not found at key "${path}"`);
          }
          // Stream R2→R2 with the source's own known size — no buffering.
          await putStream(bucket, key, source.body, source.size, {
            contentType:
              contentType ?? source.httpMetadata?.contentType ?? "application/octet-stream",
          });
          return artifactUrl(executionId, name, publicOrigin);
        },
        catch: (cause) => new ArtifactUploadFailed({ name, cause }),
      }),

    list: ({ executionId: forExecution }) =>
      Effect.promise(async () => {
        const listed = await bucket.list({
          prefix: `artifacts/${forExecution}/`,
        });
        return listed.objects.map((obj) => {
          const name = obj.key.slice(`artifacts/${forExecution}/`.length);
          return {
            name,
            size: obj.size,
            contentType:
              obj.httpMetadata?.contentType ?? "application/octet-stream",
            url: artifactUrl(forExecution, name, publicOrigin),
          };
        });
      }),
  };

  return Layer.succeed(Artifact, service);
};
