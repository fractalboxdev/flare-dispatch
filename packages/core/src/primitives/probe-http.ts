// Primitive: probeHttp — hit a set of URLs and classify each healthy / failed
//
// Codifies the curl-and-classify loop a smoke test would otherwise spell out:
// probe every path under a base URL in parallel, and count a path as failed
// when the request never completed or the endpoint answered with a
// non-2xx/3xx status.
//
// Rides on the `sandbox` capability. Layer: 03-dsl § Primitives.

import { Effect } from "effect";
import { sandbox, type Container } from "../services/sandbox";

export type ProbeResult = {
  path: string;
  status: number;
  ok: boolean;
};

export const probeHttp = (opts: {
  baseURL: string;
  paths: readonly string[];
  container?: Container;
  okStatus?: (code: number) => boolean; // default: 200 ≤ code < 400
}) =>
  Effect.gen(function* () {
    const okStatus = opts.okStatus ?? ((c: number) => c >= 200 && c < 400);

    const results = yield* Effect.forEach(
      opts.paths,
      (path) =>
        Effect.gen(function* () {
          // No `-f`: curl exits 0 for any HTTP response and writes the status
          // code to stdout; a non-zero exit then means the request itself
          // failed (DNS, connection refused). See specs/03-dsl.md § sandbox.
          const r = yield* sandbox.exec({
            container: opts.container,
            command: [
              "curl", "-sS", "-o", "/dev/null",
              "-w", "%{http_code}",
              `${opts.baseURL}${path}`,
            ],
          });
          const status = Number(r.stdout.trim());
          const ok = r.exitCode === 0 && okStatus(status);
          return { path, status, ok } satisfies ProbeResult;
        }),
      { concurrency: opts.paths.length },
    );

    const failed = results.filter((r) => !r.ok).length;
    return { checked: results.length, failed, results };
  });
