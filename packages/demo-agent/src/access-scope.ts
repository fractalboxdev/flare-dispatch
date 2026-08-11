// @fractalboxdev/flare-dispatch-demo-agent — CF Access auth for the agent's browser.
//
// The agent's browser must reach an Access-gated target. Two prior approaches
// both broke the app under test (numu-staging diagnosis, 2026-06-05):
//
//   1. `page.setExtraHTTPHeaders` rode the service-token pair on EVERY
//      request — cross-origin loads (Clerk's `clerk.browser.js`, Google
//      Fonts) failed with `net::ERR_INVALID_REDIRECT` + CORS blocks, the SPA
//      body never rendered, and every story wandered to its action budget.
//      Also a credential leak: the secret went to every third-party origin.
//   2. Request interception (`page.setRequestInterception`) scoped the
//      headers correctly — but the demo-agent is a family of SHORT-LIVED CLI
//      processes (record start → play → record stop) sharing one persistent
//      Browser Rendering page. Interception belongs to the enabling CDP
//      client; a fetch that pauses around a process hand-off is serviced by
//      nobody, so the page froze exactly as blank as before (script tag
//      added once, never loaded, no error to trigger a retry).
//
// The durable answer is the canonical Access pattern: exchange the
// service-token pair for the `CF_Authorization` cookie (one authenticated
// fetch from the AGENT process — not the browser), then set that cookie on
// the browser context. Cookies are domain-scoped by the browser itself, ride
// on every same-host request (XHR included), survive process hand-offs, and
// the secret never leaves the gated origin. Verified: a service-token GET
// returns `Set-Cookie: CF_Authorization=…; Path=/; Secure; SameSite=none`
// (24h expiry — outlives any demo run).
//
// Pure helpers here (host list + Set-Cookie parsing) are unit-tested; the
// fetch + `page.setCookie` wiring lives in `cdp.ts`.

/**
 * True when `host` is a bare, valid DNS hostname — the only shape the
 * exchange + cookie code can target safely. Anything else (scheme, port,
 * path, userinfo, wildcard, whitespace) is REJECTED: an entry like
 * `evil.com/path` would otherwise steer the service-token pair (the
 * `CF-Access-Client-*` secret) at an origin the operator never meant,
 * because `fetch("https://" + host)` is built by string concatenation.
 * The service token is the deployment's credential, so this is fail-closed
 * input validation at the trust boundary, not a lint.
 */
export const isValidAccessHost = (host: string): boolean => {
  if (host.length === 0 || host.length > 253) return false;
  const withoutTrailingDot = host.endsWith(".") ? host.slice(0, -1) : host;
  if (withoutTrailingDot.length === 0) return false;
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(
      withoutTrailingDot,
    )
  ) {
    return false;
  }
  try {
    // Round-trip through URL parsing: guarantees the concatenated exchange
    // URL `https://<host>/` actually targets exactly this host.
    return new URL(`https://${host}/`).hostname === host.toLowerCase();
  } catch {
    return false;
  }
};

/**
 * The hosts to authenticate against: the app-under-test's own host (derived
 * from the `--url` the caller already passes) plus any extra hosts named in
 * `CF_ACCESS_HOSTS` (comma-separated, e.g. a separately-gated API origin).
 * Empty when no host information exists — the caller then authenticates
 * nowhere rather than leaking the service token (see cdp.ts).
 *
 * Throws on the FIRST invalid `CF_ACCESS_HOSTS` entry: the credential must
 * never be sent to a host that failed validation, and a misconfigured list
 * is a loud attach failure, not a silently half-authenticated demo.
 */
export const accessHosts = (
  appUrl: string | undefined,
  extraHostsCsv: string | undefined,
): readonly string[] => {
  const hosts = new Set<string>();
  if (appUrl !== undefined) {
    try {
      hosts.add(new URL(appUrl).host);
    } catch {
      // unparseable --url — contributes nothing; extra hosts may still apply.
    }
  }
  for (const raw of (extraHostsCsv ?? "").split(",")) {
    const host = raw.trim();
    if (host === "") continue;
    if (!isValidAccessHost(host)) {
      throw new Error(
        `invalid CF_ACCESS_HOSTS entry "${host}": expected a bare hostname (no scheme, port, path, or wildcard)`,
      );
    }
    hosts.add(host);
  }
  return [...hosts];
};

/**
 * The URL to run the service-token exchange against for a given host. Cloudflare
 * Access only issues the `CF_Authorization` cookie on a request that hits a path
 * the Access app actually covers — and an app can be PATH-SCOPED (e.g. the
 * FlareDispatch viewer app fronts `/logs`, `/demos`, `/replay`, `/v1/executions`
 * but NOT `/`, which must stay un-gated so CI/webhooks reach the Worker). So
 * exchanging against the bare host root would yield NO cookie for such an app.
 *
 * When the host is the app-under-test's own host AND the app URL is HTTPS,
 * exchange against the full `appUrl` (the `--url` the run drives) — that path
 * is gated by construction, so the cookie is always issued. For any OTHER host
 * (a `CF_ACCESS_HOSTS` extra), the gated path is unknown, so fall back to the
 * root and rely on apps that cover `/*`.
 *
 * The service-token pair is the deployment's credential: it is NEVER sent
 * over plaintext. An `http://` appUrl (a misconfiguration for an Access-gated
 * target) is therefore not used for the exchange — the https root is, where
 * the browser will hit the same login wall an http target would.
 */
export const exchangeUrlForHost = (
  host: string,
  appUrl: string | undefined,
): string => {
  if (appUrl !== undefined) {
    try {
      const parsed = new URL(appUrl);
      if (parsed.host === host && parsed.protocol === "https:") return appUrl;
    } catch {
      // unparseable appUrl — fall back to the host root below.
    }
  }
  return `https://${host}/`;
};

/**
 * Extract the `CF_Authorization` value from `Set-Cookie` header lines.
 * Returns `null` when absent (e.g. the target is not Access-gated — fine,
 * nothing to set).
 */
export const cfAuthorizationFromSetCookie = (
  setCookieLines: readonly string[],
): string | null => {
  for (const line of setCookieLines) {
    const match = /^\s*CF_Authorization=([^;]+)/.exec(line);
    if (match?.[1] !== undefined && match[1] !== "") return match[1];
  }
  return null;
};
