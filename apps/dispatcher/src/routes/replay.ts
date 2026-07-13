// FlareDispatch Dispatcher — `GET /replay/:sessionId` (rrweb replay player).
//
// A self-hosted replay viewer for Browser Run Session Recordings, served from
// the dispatcher's OWN origin so a `product-demo` run can hand stakeholders a
// link on the operator's domain (set `product-demo.docsBase` to this Worker's
// URL) instead of an external "coming soon" page. The route fetches the rrweb
// event stream for the session from the Browser Run recording REST API —
// authenticated with the operator's own Cloudflare credentials — and returns
// a single HTML page that plays it with `rrweb-player` from a CDN.
//
// Credentials: `CLOUDFLARE_ACCOUNT_ID` (Worker var) + a Cloudflare API token.
// The token is read from `CLOUDFLARE_API_TOKEN` (Worker secret) if present,
// else from `CONFIG_KV` under `product-demo.secret/CLOUDFLARE_API_TOKEN` — the
// same key the `product-demo` run pulls, so no extra config is needed.

import type { Env } from "../env";

/**
 * Flatten the Browser Run recording response. The live API returns
 * `events` as a MAP of `targetId → rrwebEvent[]` (one stream per page/target);
 * older/mock shapes use a flat array. Flatten all targets + order by the rrweb
 * `timestamp` so the replay plays as one continuous timeline.
 */
const flattenEvents = (body: unknown): readonly unknown[] => {
  const obj = body as Record<string, unknown> | null;
  const fromShape = (events: unknown): readonly unknown[] | null => {
    if (Array.isArray(events)) return events;
    if (events !== null && typeof events === "object") {
      return Object.values(events as Record<string, unknown>)
        .filter(Array.isArray)
        .flat()
        .sort(
          (a, b) =>
            ((a as { timestamp?: number }).timestamp ?? 0) -
            ((b as { timestamp?: number }).timestamp ?? 0),
        );
    }
    return null;
  };
  if (obj === null || typeof obj !== "object") return [];
  const direct = fromShape(obj["events"]);
  if (direct !== null) return direct;
  const result = obj["result"];
  if (result !== null && typeof result === "object") {
    return fromShape((result as Record<string, unknown>)["events"]) ?? [];
  }
  return [];
};

const page = (sessionId: string, eventsJson: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session replay ${sessionId}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/rrweb-player@1.0.0-alpha.4/dist/style.css">
<style>
  html,body{margin:0;background:#0d1117;color:#c9d1d9;font:14px -apple-system,system-ui,sans-serif}
  header{padding:10px 16px;border-bottom:1px solid #21262d}
  header b{color:#58a6ff} header span{color:#8b949e}
  #player{display:flex;justify-content:center;padding:16px}
  #empty{padding:40px;text-align:center;color:#8b949e}
</style></head>
<body>
<header><b>FlareDispatch</b> session replay <span>${sessionId}</span></header>
<div id="player"></div>
<div id="empty" hidden>No rrweb events were captured for this session.</div>
<script src="https://cdn.jsdelivr.net/npm/rrweb-player@1.0.0-alpha.4/dist/index.js"></script>
<script>
  var events = ${eventsJson};
  if (!events || events.length < 2) {
    document.getElementById('empty').hidden = false;
  } else {
    new rrwebPlayer({
      target: document.getElementById('player'),
      props: { events: events, autoplay: true, width: Math.min(window.innerWidth - 32, 1280) },
    });
  }
</script>
</body></html>`;

export const handleReplay = async (
  env: Env,
  sessionId: string,
): Promise<Response> => {
  // Defend the path segment — it goes into a Cloudflare API URL.
  if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) {
    return new Response("bad session id", { status: 400 });
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token =
    env.CLOUDFLARE_API_TOKEN ??
    (env.CONFIG_KV
      ? await env.CONFIG_KV.get("product-demo.secret/CLOUDFLARE_API_TOKEN")
      : null);
  if (
    accountId === undefined ||
    accountId === "" ||
    token === null ||
    token === undefined ||
    token === ""
  ) {
    return new Response("replay not configured (account id / api token)", {
      status: 503,
    });
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/recording/${sessionId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    // 404 = no recording for this session (not recorded, or expired).
    const status = res.status === 404 ? 404 : 502;
    return new Response(
      res.status === 404
        ? "No recording found for this session (it may not have been recorded, or has expired)."
        : `recording fetch failed (${res.status})`,
      { status },
    );
  }
  const events = flattenEvents(await res.json());
  return new Response(page(sessionId, JSON.stringify(events)), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The recording is immutable once finalized; cache briefly.
      "cache-control": "public, max-age=300",
    },
  });
};
