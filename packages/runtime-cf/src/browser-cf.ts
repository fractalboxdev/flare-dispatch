// @fractalboxdev/flare-dispatch-runtime-cf — BrowserRenderingLive: the live `browser` capability.
//
// Backs `BrowserService` for the `cdp-acceptance` run. The acceptance suite
// runs Playwright *inside the sandbox container*, so what the run needs from
// this capability is a CDP WebSocket endpoint the container's Playwright
// process can dial — `playwright.chromium.connectOverCDP(process.env.CDP_WS_URL)`.
//
// --- The connect model (chosen in PR9) --------------------------------------
//
// The container reaches Cloudflare Browser Rendering directly over its
// `/connect` WebSocket, authenticated with a Cloudflare API token — it does
// NOT go through the Worker's `BROWSER` binding (that path only exposes CDP to
// Worker code, not to an arbitrary container process). `newCDPSession` therefore
// just composes the endpoint URL the container dials; the token rides as a
// query parameter (a CDP WS client cannot set request headers).
//
// The connect URL + token are operator-provided deploy config (`config.connectUrl`
// / `config.apiToken`, from the `BROWSER_CDP_*` Worker secrets) rather than a
// hardcoded constant — the exact Browser Rendering connect surface is pinned at
// deploy time, not baked into this Layer. A deploy with no `BROWSER_CDP_CONNECT_URL`
// gets the dying `BrowserDeferred` stub (see runtime.ts).
//
// --- Verification scope ------------------------------------------------------
//
// `vitest-pool-workers` / Miniflare has neither a container runtime nor Browser
// Rendering, so the live connect cannot be exercised here — this Layer is
// verified by typecheck + `wrangler deploy --dry-run`; the end-to-end attach is
// a `wrangler dev` smoke. The endpoint-composition logic is pure and unit-tested.
//
// Spec: specs/03-dsl.md § browser, specs/pm/plan.md § V1 / V2 plan — PR9.

import { Effect, Layer } from "effect";
import {
  Browser,
  BrowserUnavailable,
  type BrowserService,
} from "@fractalboxdev/flare-dispatch-core";

/** Deploy config for the live `browser` capability. */
export type BrowserRenderingConfig = {
  /**
   * The Browser Rendering CDP `/connect` WebSocket URL the container dials.
   * Operator-pinned (`BROWSER_CDP_CONNECT_URL`) — the exact connect surface is
   * not baked into this Layer.
   */
  readonly connectUrl: string;
  /**
   * Cloudflare API token authorizing the connect. Appended as a `token` query
   * parameter. Optional — omit when `connectUrl` already carries auth.
   */
  readonly apiToken?: string;
};

/** Compose the CDP endpoint the container dials, appending the token if any. */
export const composeCdpEndpoint = (
  config: BrowserRenderingConfig,
  extraParams?: Record<string, string>,
): string => {
  const params = new URLSearchParams();
  if (config.apiToken !== undefined) params.set("token", config.apiToken);
  for (const [k, v] of Object.entries(extraParams ?? {})) params.set(k, v);
  const qs = params.toString();
  if (qs === "") return config.connectUrl;
  const sep = config.connectUrl.includes("?") ? "&" : "?";
  return `${config.connectUrl}${sep}${qs}`;
};

/**
 * Pre-acquire a RECORDING session against the dispatcher's cdp route
 * (`GET <connectUrl-as-https>?acquire=1&recording=true`) so the caller learns
 * the REAL Browser Rendering session id — the key the Session Recording REST
 * API is fetched by. The returned id is then dialed via the route's
 * `?browser_session=<id>` re-attach, recording already armed.
 */
const acquireRecordingSession = (
  config: BrowserRenderingConfig,
): Effect.Effect<string, BrowserUnavailable> =>
  Effect.tryPromise({
    try: async () => {
      const httpUrl = new URL(config.connectUrl.replace(/^ws/, "http"));
      httpUrl.searchParams.set("acquire", "1");
      httpUrl.searchParams.set("recording", "true");
      const res = await fetch(httpUrl, {
        headers:
          config.apiToken !== undefined ? { authorization: `Bearer ${config.apiToken}` } : {},
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`acquire ${res.status}: ${body.slice(0, 200)}`);
      }
      const { sessionId } = (await res.json()) as { sessionId: string };
      if (typeof sessionId !== "string" || sessionId === "") {
        throw new Error("acquire returned no sessionId");
      }
      return sessionId;
    },
    catch: (e) => {
      // Surface the cause in logs; the typed error carries only the reason.
      console.log(
        JSON.stringify({
          event: "browser.recording_acquire_failed",
          message: e instanceof Error ? e.message : String(e),
        }),
      );
      return new BrowserUnavailable({ reason: "transient" });
    },
  });

/**
 * Build the live `Browser` Layer from the Browser Rendering deploy config.
 *
 * @param config  the `/connect` URL + API token (`BROWSER_CDP_*` secrets).
 */
export const makeBrowserRenderingLive = (config: BrowserRenderingConfig): Layer.Layer<Browser> => {
  const service: BrowserService = {
    newCDPSession: ({ targetUrl: _targetUrl, recording }) =>
      // `targetUrl` is the app the *suite* navigates to once connected; it is
      // not needed to attach to the browser itself.
      recording === true
        ? // RECORDING path: pre-acquire so the real session id is known (the
          // recording REST API is keyed on it), then hand back a re-attach
          // endpoint with recording armed.
          acquireRecordingSession(config).pipe(
            Effect.map((sessionId) => ({
              wsEndpoint: composeCdpEndpoint(config, {
                browser_session: sessionId,
                recording: "true",
              }),
              sessionId,
              close: Effect.void,
            })),
          )
        : // Plain path: pure URL composition — the container, not the Worker,
          // opens the WS; the session is minted lazily in the route.
          Effect.succeed({
            wsEndpoint: composeCdpEndpoint(config),
            close: Effect.void,
          }),
  };

  return Layer.succeed(Browser, service);
};
