// FlareDispatch Dispatcher — `GET /v1/browser/cdp` (WebSocket upgrade).
//
// Bridges a CDP client (the `cdp-acceptance` container's Playwright, via
// `chromium.connectOverCDP`) to a Cloudflare Browser Rendering session:
//
//   container (connectOverCDP)
//     │  wss://<dispatcher>/v1/browser/cdp?token=<T>   (or Authorization: Bearer <T>)
//     ▼
//   this route
//     │  env.BROWSER.fetch(/v1/acquire) → sessionId
//     │  env.BROWSER.fetch(/v1/devtools/browser/<sessionId>) Upgrade: websocket
//     ▼
//   CF Browser Rendering binding
//
// WHY this exists: CF Browser Rendering only exposes CDP to a Worker that holds
// the `BROWSER` binding — it is NOT a public, token-dialable WebSocket. The
// previous `cdp-acceptance` model handed the container an external connect URL
// (`BROWSER_CDP_CONNECT_URL`) and the WS hung (it opened but never spoke CDP).
// Routing the connect through the dispatcher's own `BROWSER` binding is the
// supported path. Frames are opaque to the proxy — piped bidirectionally.
//
// Ported from the standalone numu `cf-browser-proxy` Worker (the working
// reference); folding it into the dispatcher lets that separate Worker retire.

import type { Env } from "../env";

// The BROWSER binding's `/v1/devtools/browser/{sessionId}` upgrade returns 400
// unless `cf-brapi-client` is the canonical `@cloudflare/playwright@<x.y.z>`
// value. Send the canonical string so the upgrade succeeds.
const CDP_CLIENT_ID = "@cloudflare/playwright@1.3.0";
// playwright-core's `kBrowserCloseMessageId` — graceful CDP teardown sentinel.
const BROWSER_CLOSE_MESSAGE_ID = -9999;
// CF Browser session keep_alive ceiling (10 min = CF's documented max). One
// session must outlive the whole acceptance run.
const DEFAULT_KEEP_ALIVE_MS = 600_000;

const log = (event: string, fields: Record<string, unknown>): void => {
  // Single-line structured JSON for `wrangler tail`. (No Date.now in the body
  // hot path beyond logging — fine here, this is the runtime seam.)
  console.log(JSON.stringify({ event, ...fields }));
};

/** Constant-time string compare without leaking length via early return. */
const constantTimeCompare = (a: string, b: string): boolean => {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
};

/**
 * Pull the caller's token from either an `Authorization: Bearer <T>` header
 * (the numu acceptance resolver moves the token here — a query token 401s
 * against CF Browser Rendering) or a `?token=<T>` query param (what
 * `composeCdpEndpoint` emits). Either is accepted so both connect shapes work.
 */
const callerToken = (request: Request, url: URL): string | null => {
  const header = request.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice("bearer ".length).trim();
  }
  const q = url.searchParams.get("token");
  return q && q.length > 0 ? q : null;
};

/**
 * `GET /v1/browser/cdp` — upgrade to a CDP WebSocket proxied to CF Browser
 * Rendering. Auth: the caller token must equal `BROWSER_CDP_API_TOKEN`.
 */
export const handleBrowserCdp = async (
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> => {
  const url = new URL(request.url);
  const isUpgrade =
    request.headers.get("upgrade")?.toLowerCase() === "websocket";
  // ACQUIRE-ONLY MODE — `GET …?acquire=1` with no upgrade: mint a session and
  // return its id as JSON (see below). Everything else that isn't a WS upgrade
  // keeps the existing 426 contract.
  const isAcquire = !isUpgrade && url.searchParams.get("acquire") === "1";
  if (!isUpgrade && !isAcquire) {
    return new Response("expected websocket upgrade", { status: 426 });
  }
  if (env.BROWSER === undefined) {
    log("cdp.no_binding", { request_id: requestId });
    return new Response("browser binding not configured", { status: 503 });
  }
  const expected = env.BROWSER_CDP_API_TOKEN;
  if (expected === undefined || expected.length === 0) {
    log("cdp.no_token_configured", { request_id: requestId });
    return new Response("browser cdp auth not configured", { status: 503 });
  }
  const token = callerToken(request, url);
  if (token === null || !constantTimeCompare(token, expected)) {
    log("cdp.unauthorized", { request_id: requestId });
    return new Response("unauthorized", { status: 401 });
  }

  const keepAliveMs = Number(env.KEEP_ALIVE_MS ?? DEFAULT_KEEP_ALIVE_MS);
  // Session recording (Browser Run rrweb capture, Beta) — opt-in per session
  // via `?recording=true` on the caller's URL. Propagated to BOTH the acquire
  // and the upstream devtools connect (the docs put it on the devtools WS URL;
  // adding it to acquire too is harmless and covers either enforcement point).
  const recording = url.searchParams.get("recording") === "true";

  /** Mint a Browser Rendering session via the binding; returns its id. */
  const acquireSession = async (): Promise<
    { ok: true; sessionId: string } | { ok: false; res: Response }
  > => {
    const acquireUrl = new URL("http://fake.host/v1/acquire");
    acquireUrl.searchParams.set("keep_alive", String(keepAliveMs));
    if (recording) acquireUrl.searchParams.set("recording", "true");
    const acquireRes = await env.BROWSER!.fetch(acquireUrl, {
      headers: { "cf-brapi-client": CDP_CLIENT_ID },
    });
    if (acquireRes.status !== 200) {
      const body = await acquireRes.text().catch(() => "");
      log("cdp.acquire_failed", {
        request_id: requestId,
        upstream_status: acquireRes.status,
        upstream_body: body.slice(0, 512),
      });
      return {
        ok: false,
        res: new Response(`acquire failed: ${acquireRes.status} ${body}`, {
          status: 502,
        }),
      };
    }
    const sessionId = ((await acquireRes.json()) as { sessionId: string })
      .sessionId;
    log("cdp.acquired", {
      request_id: requestId,
      session_id: sessionId,
      recording,
    });
    return { ok: true, sessionId };
  };

  // ACQUIRE-ONLY MODE — `GET …/v1/browser/cdp?acquire=1` (no WebSocket
  // upgrade): mint a session and return its id as JSON. This is how a run
  // learns the REAL Browser Rendering session id up front (the id the
  // recording REST API is keyed on), then has its CDP client re-attach with
  // `?browser_session=<id>`. Without this, the id is minted lazily inside the
  // WS handshake below and the connecting client can never see it.
  if (isAcquire) {
    const acquired = await acquireSession();
    if (!acquired.ok) return acquired.res;
    return new Response(JSON.stringify({ sessionId: acquired.sessionId }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // 1) Resolve the session — re-attach to `?browser_session=<id>` or mint one.
  const requestedSession = url.searchParams.get("browser_session");
  let sessionId: string;
  if (requestedSession) {
    sessionId = requestedSession;
  } else {
    const acquired = await acquireSession();
    if (!acquired.ok) return acquired.res;
    sessionId = acquired.sessionId;
  }

  // 2) Open the upstream CDP WebSocket for that session. `persistent` is left
  // unset — the BROWSER binding 400s it for both fresh + re-attach.
  const upstreamUrl = new URL(
    `http://fake.host/v1/devtools/browser/${sessionId}`,
  );
  // NOTE: recording=true must NOT ride on the devtools connect — the binding
  // 400s it there ("upstream did not return webSocket; status=400", verified
  // live). Recording is armed at ACQUIRE time only (see acquireSession above);
  // re-attaches to a recording session need no param.
  const upstreamRes = await env.BROWSER.fetch(upstreamUrl, {
    headers: { Upgrade: "websocket", "cf-brapi-client": CDP_CLIENT_ID },
  });
  const upstream = upstreamRes.webSocket;
  if (!upstream) {
    log("cdp.upstream_no_websocket", {
      request_id: requestId,
      session_id: sessionId,
      upstream_status: upstreamRes.status,
    });
    return new Response(
      `upstream did not return webSocket; status=${upstreamRes.status}`,
      { status: 502 },
    );
  }
  upstream.accept();

  // 3) Downstream WebSocketPair for the container's Playwright.
  const pair = new WebSocketPair();
  const client = pair[0]!;
  const server = pair[1]!;
  server.accept();

  let closed = false;
  const safeClose = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    // For fresh-acquire connections the proxy owns the session — release it so
    // it doesn't pin the per-account concurrency cap. For re-attach the caller
    // owns it (auto-released on keep_alive expiry); sending Browser.close would
    // 410 subsequent re-attaches.
    if (!requestedSession) {
      try {
        upstream.send(
          JSON.stringify({
            id: BROWSER_CLOSE_MESSAGE_ID,
            method: "Browser.close",
            params: {},
          }),
        );
      } catch {
        /* upstream may already be gone */
      }
    }
    const normalized = code >= 1000 && code <= 4999 ? code : 1011;
    try {
      upstream.close(normalized, reason);
    } catch {
      /* noop */
    }
    try {
      server.close(normalized, reason);
    } catch {
      /* noop */
    }
    log("cdp.closed", {
      request_id: requestId,
      session_id: sessionId,
      code: normalized,
      reason,
    });
  };

  // 4) Pipe frames bidirectionally (opaque JSON/binary).
  server.addEventListener("message", (e: MessageEvent) => {
    try {
      upstream.send(
        typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer),
      );
    } catch (err) {
      safeClose(1011, `upstream send failed: ${(err as Error).message}`);
    }
  });
  upstream.addEventListener("message", (e: MessageEvent) => {
    try {
      server.send(
        typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer),
      );
    } catch (err) {
      safeClose(1011, `client send failed: ${(err as Error).message}`);
    }
  });
  server.addEventListener("close", (e: CloseEvent) =>
    safeClose(e.code, e.reason || "client closed"),
  );
  upstream.addEventListener("close", (e: CloseEvent) =>
    safeClose(e.code, e.reason || "upstream closed"),
  );
  server.addEventListener("error", () => safeClose(1011, "client error"));
  upstream.addEventListener("error", () => safeClose(1011, "upstream error"));

  log("cdp.opened", { request_id: requestId, session_id: sessionId });
  return new Response(null, { status: 101, webSocket: client });
};
