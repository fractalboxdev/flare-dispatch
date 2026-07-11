// @fractalbox/flare-dispatch-core — the `browser` capability (Browser Rendering access).
//
// REST mode (`newPage`) for short, stateless page interactions; CDP mode
// (`newCDPSession`) for a direct WebSocket attach to a managed Chromium.
//
// Spec: specs/03-dsl.md § browser.

import { Context, Effect } from "effect";
import type { BrowserUnavailable } from "../errors";

/** A managed page — Puppeteer's page object wrapped in Effect signatures. */
export type Page = {
  readonly goto: (url: string) => Effect.Effect<void, BrowserUnavailable>;
  readonly close: Effect.Effect<void>;
};

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
  readonly newPage: (opts?: {
    viewport?: { w: number; h: number };
  }) => Effect.Effect<Page, BrowserUnavailable>;
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

export class Browser extends Context.Tag("@fractalbox/flare-dispatch-core/Browser")<
  Browser,
  BrowserService
>() {}

export const browser = {
  newPage: (opts?: { viewport?: { w: number; h: number } }) =>
    Effect.flatMap(Browser, (b) => b.newPage(opts)),
  newCDPSession: (opts: { targetUrl: string; recording?: boolean }) =>
    Effect.flatMap(Browser, (b) => b.newCDPSession(opts)),
} as const;
