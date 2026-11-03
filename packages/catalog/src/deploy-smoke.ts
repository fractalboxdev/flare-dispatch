// The `deploy-smoke` run: probes each path on each allowed host over HTTPS from the control pool, with no container
// (FD-GATE-069 to FD-GATE-075). This module imports no process or file API.
import { Context, Effect, Layer, Match, Option } from "effect";
import type { DispatchEvent } from "./dispatch-event.ts";
import { normalizeHost } from "./egress.ts";
import type { DeploySmokeInput } from "./inputs.ts";
import type { DeploySmokeEntry } from "./manifest.ts";
import { Outcome } from "./reasons.ts";

export const DEFAULT_SMOKE_PATHS = ["/", "/health"] as const;
export const DEFAULT_SMOKE_ENVIRONMENTS = ["production"] as const;
export const SMOKE_ATTEMPTS = 3;
export const SMOKE_INTERVAL_MS = 10_000;
export const SMOKE_REQUEST_TIMEOUT_MS = 10_000;

/** The HTTP client a probe uses. */
export class SmokeHttp extends Context.Service<
  SmokeHttp,
  { readonly fetch: (url: string, init: RequestInit) => Promise<Response> }
>()("@fractalboxdev/flare-dispatch-catalog/SmokeHttp") {}

/** `SmokeHttp` over the Worker's `fetch`. */
export const fetchSmokeHttp: Layer.Layer<SmokeHttp> = Layer.succeed(SmokeHttp, {
  fetch: (url, init) => globalThis.fetch(url, init),
});

/**
 * A request decoder (MAMEKO-RUN-010) bound to the manifest entry: a successful `deployment_status` for a listed
 * environment that carries an `environment_url` requests `deploy-smoke` (FD-GATE-070).
 */
export const deploymentStatusDecoder =
  (entry: DeploySmokeEntry) =>
  (event: DispatchEvent): Option.Option<DeploySmokeInput> =>
    Match.value(event).pipe(
      Match.tag("webhook", ({ delivery }) =>
        delivery.event === "deployment_status" &&
        delivery.state === "success" &&
        delivery.environmentUrl !== undefined &&
        (entry.environments ?? DEFAULT_SMOKE_ENVIRONMENTS).includes(delivery.environment)
          ? Option.some({
              scope: delivery.repository.fullName,
              sha: delivery.sha,
              hosts: entry.hosts,
              ...(entry.paths === undefined ? {} : { paths: entry.paths }),
              targetUrl: delivery.environmentUrl,
            })
          : Option.none(),
      ),
      Match.orElse(() => Option.none()),
    );

type Probe = { readonly healthy: true } | { readonly healthy: false; readonly detail: string };

/**
 * One request, healthy only on a 2xx or 3xx status within the request timeout (FD-GATE-071). The client follows no
 * redirect, so a `Location` outside `hosts` receives no request (FD-GATE-074).
 */
const probeOnce = (http: SmokeHttp["Service"], url: string, timeoutMs: number) =>
  Effect.tryPromise({
    try: () => http.fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }),
    catch: (cause) =>
      cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")
        ? "timeout"
        : "error",
  }).pipe(
    Effect.map((r): Probe =>
      r.status >= 200 && r.status < 400
        ? { healthy: true }
        : { healthy: false, detail: String(r.status) },
    ),
    Effect.catch((detail) => Effect.succeed<Probe>({ healthy: false, detail })),
  );

export interface SmokeTiming {
  readonly attempts?: number;
  readonly intervalMs?: number;
  readonly requestTimeoutMs?: number;
}

export const runDeploySmoke = (input: DeploySmokeInput, timing: SmokeTiming = {}) =>
  Effect.gen(function* () {
    const http = yield* SmokeHttp;
    const allowed = new Set(input.hosts.map(normalizeHost));
    let targets: readonly string[] = [...allowed];
    if (input.targetUrl !== undefined) {
      let host: string;
      try {
        host = normalizeHost(new URL(input.targetUrl).hostname);
      } catch {
        return Outcome.failure("config: host not allowed");
      }
      if (!allowed.has(host)) return Outcome.failure("config: host not allowed");
      targets = [host];
    }
    if (targets.length === 0) return Outcome.failure("config: hosts");
    const paths = input.paths ?? DEFAULT_SMOKE_PATHS;
    const attempts = timing.attempts ?? SMOKE_ATTEMPTS;
    const unhealthy: string[] = [];
    for (const host of targets)
      for (const path of paths) {
        let last: Probe = { healthy: false, detail: "not probed" };
        for (let i = 0; i < attempts; i++) {
          if (i > 0) yield* Effect.sleep(timing.intervalMs ?? SMOKE_INTERVAL_MS);
          last = yield* probeOnce(
            http,
            `https://${host}${path}`,
            timing.requestTimeoutMs ?? SMOKE_REQUEST_TIMEOUT_MS,
          );
          if (last.healthy) break;
        }
        if (!last.healthy) unhealthy.push(`${host}${path} ${last.detail}`);
      }
    return unhealthy.length === 0
      ? Outcome.success()
      : Outcome.failure(`smoke: ${unhealthy.join("; ")}`);
  });
