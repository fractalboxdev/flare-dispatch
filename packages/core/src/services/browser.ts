// @fractalboxdev/flare-dispatch-core — the `browser` capability (Browser Rendering access).
//
// One mode: `newCDPSession`, a direct WebSocket attach to a managed Chromium.
//
// A REST mode (`newPage`, Worker-side Puppeteer) was declared here and never
// built — the live Layer answered it with `Effect.die`, which type-checks and
// reviews clean and takes a run down the moment anything calls it. Nothing
// ever did. Deleted rather than implemented: `cdp-acceptance` and
// `product-demo` both attach over CDP, and a method that only exists to be
// declared reads to the next author as a capability this deploy has.
// See AGENTS.md § Conventions for the live-vs-deferred rule.
//
// Spec: specs/03-dsl.md § browser.

import { Context, Effect } from "effect";
import type { BrowserUnavailable } from "../errors";

/** A direct CDP attach: typed Network / Page / Runtime event streams. */
export type CDPSession = {
  readonly wsEndpoint: string;
  /**
   * The Browser Rendering session id — the key the Session Recording REST API
   * (`GET /accounts/<id>/browser-rendering/recording/<sessionId>`) is fetched
   * by. Present only when the session was pre-acquired with `recording: true`;
   * the plain connect path mints its session lazily inside the WS handshake,
   * where no caller can observe the id.
   */
  readonly sessionId?: string;
  readonly close: Effect.Effect<void>;
};

export interface BrowserService {
  readonly newCDPSession: (opts: {
    targetUrl: string;
    /**
     * Opt this session into Browser Run Session Recording (rrweb, Beta). The
     * live Layer pre-acquires the session (`?acquire=1&recording=true` against
     * the dispatcher's cdp route) so the REAL session id is known up front,
     * and returns a `?browser_session=<id>` re-attach endpoint.
     */
    recording?: boolean;
  }) => Effect.Effect<CDPSession, BrowserUnavailable>;
}

export class Browser extends Context.Tag("@fractalboxdev/flare-dispatch-core/Browser")<
  Browser,
  BrowserService
>() {}

export const browser = {
  newCDPSession: (opts: { targetUrl: string; recording?: boolean }) =>
    Effect.flatMap(Browser, (b) => b.newCDPSession(opts)),
} as const;
