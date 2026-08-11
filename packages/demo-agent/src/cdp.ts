// @fractalboxdev/flare-dispatch-demo-agent — CDP attach + low-level browser ops.
//
// The agent attaches via puppeteer-core's `Browser.connect({ browserWSEndpoint })`
// against the WebSocket URL the run hands it. The run gets that URL from the
// dispatcher's `browser.newCDPSession` primitive, which already appends
// `?recording=true` so the Browser Rendering session emits rrweb events the
// whole time we're attached.
//
// This module is the only place that imports `puppeteer-core` so the LLM loop
// and the recorder stay easy to unit-test (they take a `CdpSession`
// interface, not a Puppeteer instance).
//
// Spec: specs/03-dsl.md § browser, packages/runtime-cf/src/browser-cf.ts.

import { Effect } from "effect";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import {
  accessHosts,
  cfAuthorizationFromSetCookie,
  exchangeUrlForHost,
} from "./access-scope.js";
import { CdpAttachFailed, CdpCommandFailed } from "./errors.js";
import { VIEWPORTS, type ViewportPreset } from "./schemas.js";

/**
 * Minimal surface the play loop + recorder need from a live CDP session.
 * Exposed as an interface so tests can inject a fake without spinning up a
 * real WebSocket; the live impl is `attachCdp` below.
 */
export interface CdpSession {
  /** Navigate the active page; resolves when the navigation commits. */
  readonly goto: (url: string) => Effect.Effect<void, CdpCommandFailed>;
  /** The page's current URL (puppeteer `page.url()`). */
  readonly currentUrl: () => Effect.Effect<string, never>;
  /** Click an element by accessibility node id or CSS selector. */
  readonly click: (target: string) => Effect.Effect<void, CdpCommandFailed>;
  /** Focus an element and type a string into it. */
  readonly type: (
    target: string,
    text: string,
  ) => Effect.Effect<void, CdpCommandFailed>;
  /** Dispatch a single keyboard event by CDP key name. */
  readonly key: (key: string) => Effect.Effect<void, CdpCommandFailed>;
  /** Wait `ms` milliseconds (clamped to 5_000 by the caller). */
  readonly wait: (ms: number) => Effect.Effect<void, never>;
  /** Capture a PNG screenshot to the absolute path. */
  readonly screenshot: (
    path: string,
  ) => Effect.Effect<void, CdpCommandFailed>;
  /**
   * Snapshot the accessibility tree of the current page — the input the model
   * picks its next action from. Returns a compact JSON-stringified tree.
   */
  readonly accessibilitySnapshot: () => Effect.Effect<
    string,
    CdpCommandFailed
  >;
  /** Close the page + disconnect the browser. */
  readonly close: () => Effect.Effect<void, never>;
}

const classifyAttachError = (e: unknown): CdpAttachFailed["reason"] => {
  const msg = e instanceof Error ? e.message.toLowerCase() : String(e);
  if (msg.includes("invalid url") || msg.includes("invalid-url")) return "invalid-url";
  if (msg.includes("econnrefused")) return "connect-refused";
  if (msg.includes("401") || msg.includes("403") || msg.includes("unauthor"))
    return "auth-failed";
  if (msg.includes("timeout") || msg.includes("etimedout")) return "timeout";
  return "unknown";
};

/**
 * Strip credentials from a CDP WebSocket endpoint before it reaches an error
 * object or a log line. Browser Rendering endpoints routinely carry bearer
 * credentials in the query string (the `?browser_session=` re-attach URLs)
 * and can carry userinfo; the FULL endpoint must never be persisted or
 * printed. Drops userinfo, query, and fragment, keeping scheme/host/port/path
 * so the redacted form still identifies the target.
 */
export const redactWsEndpoint = (wsEndpoint: string): string => {
  try {
    const u = new URL(wsEndpoint);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    // Unparseable — best-effort: keep only the part before any `?`/`#`
    // (the credential would live in the query).
    return wsEndpoint.split(/[?#]/, 1)[0] ?? "";
  }
};

/**
 * Scrub every ws/wss URL out of an error message. Underlying errors (URL
 * validation, puppeteer connect failures) can embed the endpoint verbatim,
 * so redacting the `CdpAttachFailed.wsEndpoint` field alone would still leak
 * the credential through the message text.
 */
const scrubWsUrls = (message: string): string =>
  message.replace(/wss?:\/\/[^\s"'<>]+/g, (match) => redactWsEndpoint(match));

/**
 * Strip query + fragment from a URL for log lines. The play/record `--url`
 * can carry a capability token in its query string (the run's `?t=` gate
 * material), and the exchange URL reuses it verbatim — so it must never be
 * logged whole. Origin + path keep the diagnostic readable.
 */
const redactUrlForLog = (url: string): string => {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
};

const wrapCmd = <T>(
  method: string,
  thunk: () => Promise<T>,
): Effect.Effect<T, CdpCommandFailed> =>
  Effect.tryPromise({
    try: thunk,
    catch: (e) =>
      new CdpCommandFailed({
        method,
        message: e instanceof Error ? e.message : String(e),
      }),
  }).pipe(
    // Bound every CDP op so a single hung action (a click on an unresponsive
    // element, a goto to a page that never finishes loading) can't block the
    // play loop past its `--max-sec` budget — which on the dispatcher overran
    // the exec's `timeoutSec` and surfaced as ExecTimeout. On timeout the op
    // becomes a normal CdpCommandFailed the loop records and moves past.
    Effect.timeoutFail({
      duration: "45 seconds",
      onTimeout: () =>
        new CdpCommandFailed({
          method,
          message: `${method} timed out after 45s`,
        }),
    }),
  );

/** Apply the viewport preset via Emulation.setDeviceMetricsOverride. */
export const applyViewport = (
  page: Page,
  preset: ViewportPreset,
): Effect.Effect<void, CdpCommandFailed> => {
  const dims = VIEWPORTS[preset];
  return wrapCmd("Emulation.setDeviceMetricsOverride", () =>
    page.setViewport({
      width: dims.width,
      height: dims.height,
      deviceScaleFactor: dims.deviceScaleFactor,
      isMobile: dims.mobile,
    }),
  );
};

/**
 * Attach to Browser Rendering over CDP at `wsEndpoint`. Resolves once the
 * default page is connected; the returned `CdpSession` carries an `accessor`
 * for the underlying puppeteer `Browser` so tests + the live recorder can
 * extract the session id.
 *
 * `appUrl` (the play/record `--url`) names the Access-gated host the agent
 * exchanges its service token against — see the header note in
 * `access-scope.ts`.
 */
export const attachCdp = (
  wsEndpoint: string,
  appUrl?: string,
): Effect.Effect<
  { readonly browser: Browser; readonly page: Page; readonly session: CdpSession },
  CdpAttachFailed
> =>
  Effect.gen(function* () {
    if (!/^wss?:\/\//.test(wsEndpoint)) {
      return yield* Effect.fail(
        new CdpAttachFailed({
          wsEndpoint: redactWsEndpoint(wsEndpoint),
          reason: "invalid-url",
          message: `--cdp-ws must start with ws:// or wss:// (got: ${redactWsEndpoint(wsEndpoint)})`,
        }),
      );
    }

    const browser = yield* Effect.tryPromise({
      try: () =>
        puppeteer.connect({
          browserWSEndpoint: wsEndpoint,
          defaultViewport: null,
        }),
      catch: (e) =>
        new CdpAttachFailed({
          wsEndpoint: redactWsEndpoint(wsEndpoint),
          reason: classifyAttachError(e),
          message: scrubWsUrls(e instanceof Error ? e.message : String(e)),
        }),
    }).pipe(
      // Bound the connect — `puppeteer.connect` to a Browser Run re-attach
      // endpoint can hang indefinitely if the session is wedged, which (before
      // the play loop's deadline even starts) would otherwise wedge the whole
      // play. Fail fast as a normal attach error the caller records.
      Effect.timeoutFail({
        duration: "30 seconds",
        onTimeout: () =>
          new CdpAttachFailed({
            wsEndpoint: redactWsEndpoint(wsEndpoint),
            reason: "timeout",
            message: "puppeteer.connect timed out after 30s",
          }),
      }),
    );

    const page = yield* Effect.tryPromise({
      try: async () => {
        const existing = await browser.pages();
        return existing.length > 0 && existing[0] !== undefined
          ? existing[0]
          : await browser.newPage();
      },
      catch: (e) =>
        new CdpAttachFailed({
          wsEndpoint: redactWsEndpoint(wsEndpoint),
          reason: "unknown",
          message: scrubWsUrls(e instanceof Error ? e.message : String(e)),
        }),
    });

    // When CF Access service-token creds are in the env, authenticate the
    // browser against the Access-gated target (the gated Pages site 302s
    // every request to the Access login otherwise, so the agent would only
    // ever see the login wall).
    //
    // COOKIE EXCHANGE, not header injection — see access-scope.ts for the
    // full post-mortem of the two header approaches this replaces (global
    // `setExtraHTTPHeaders` broke every cross-origin load + leaked the
    // secret; per-request interception orphans paused fetches across the
    // record/play process hand-offs and froze the page just as blank). The
    // agent process fetches the gated origin once with the service-token
    // pair, receives `Set-Cookie: CF_Authorization=…` (24h), and sets that
    // cookie on the browser — domain-scoped by the browser itself, riding on
    // every same-host request, surviving process hand-offs. Best-effort per
    // host: a host that returns no cookie (not Access-gated) just gets none.
    //
    // The host list is validated BEFORE any exchange (`accessHosts` throws
    // on a malformed `CF_ACCESS_HOSTS` entry): the service-token pair is the
    // deployment's credential and must never be sent to a host that failed
    // the bare-hostname check. No fallback when the list is empty — with no
    // host information there is nothing to authenticate against, so no
    // credential leaves the process (a gated target then shows its login
    // wall, which is the honest failure).
    const cfAccessId = process.env["CF_ACCESS_CLIENT_ID"];
    const cfAccessSecret = process.env["CF_ACCESS_CLIENT_SECRET"];
    if (cfAccessId !== undefined && cfAccessSecret !== undefined) {
      const accessHeaders = {
        "CF-Access-Client-Id": cfAccessId,
        "CF-Access-Client-Secret": cfAccessSecret,
      };
      yield* Effect.tryPromise({
        try: async () => {
          // Throws before any fetch when an entry is invalid — fail closed.
          const hosts = accessHosts(appUrl, process.env["CF_ACCESS_HOSTS"]);
          // Independent per-host exchanges — run them concurrently; each
          // host's cookie is set by its own exchange, so the attach latency
          // no longer grows linearly with the host count.
          await Promise.all(
            hosts.map(async (host) => {
              // Exchange against a GATED path — a path-scoped Access app (our
              // viewer app fronts `/logs` etc., NOT `/`) issues no cookie on the
              // bare root, so use the target `appUrl` for its own host.
              const exchangeUrl = exchangeUrlForHost(host, appUrl);
              // `redirect: "manual"` — Access sets the cookie on the FIRST
              // authenticated response; following a redirect would drop its
              // Set-Cookie header on the floor. (The cookie rides even a 403 from
              // a downstream capability-token gate, so a `?t=` in appUrl is fine.)
              const res = await fetch(exchangeUrl, {
                headers: accessHeaders,
                redirect: "manual",
              });
              const setCookies =
                typeof res.headers.getSetCookie === "function"
                  ? res.headers.getSetCookie()
                  : [res.headers.get("set-cookie") ?? ""].filter(
                      (s) => s !== "",
                    );
              const token = cfAuthorizationFromSetCookie(setCookies);
              if (token === null) {
                console.error(
                  `cf-access: no CF_Authorization cookie from ${redactUrlForLog(exchangeUrl)} (status ${res.status}) — path may not be Access-gated`,
                );
                return;
              }
              // Set the cookie by `url`, NOT bare `domain`. The persistent Browser
              // Rendering page is on `about:blank` when this short-lived attach
              // runs (`newCDPSession` does not navigate), so a `{domain}` cookie
              // for an origin the page has never visited is silently dropped by
              // Chrome's CDP `Network.setCookie` — the browser then loads the app
              // with no cookie and hits the Access login wall (every chapter
              // "gated behind Cloudflare Access", with no error). The `url` form
              // supplies the origin explicitly, so the cookie is accepted before
              // the first navigation. `sameSite: "None"` + `secure: true` matches
              // what Access itself sets (24h, cross-site).
              await page.setCookie({
                name: "CF_Authorization",
                value: token,
                url: `https://${host}/`,
                path: "/",
                secure: true,
                sameSite: "None",
              });
              console.error(
                `cf-access: set CF_Authorization for https://${host}/ (service-token exchange ok)`,
              );
            }),
          );
        },
        catch: (e) =>
          new CdpAttachFailed({
            wsEndpoint: redactWsEndpoint(wsEndpoint),
            reason: "unknown",
            message: scrubWsUrls(e instanceof Error ? e.message : String(e)),
          }),
      });
    }

    // Resolve an agent-supplied target to an element. The agent reads the
    // ACCESSIBILITY tree, so it usually supplies an accessible name ("Home",
    // "Sign in") — not a CSS selector. Try puppeteer's ARIA selector first (by
    // accessible name/role), then a raw CSS selector, then visible text. This is
    // what lets the agent operate a real app it has only ever seen as an a11y
    // tree, instead of failing every `page.click("Home")` as a bad CSS selector.
    const resolveElement = async (target: string) => {
      for (const sel of [`::-p-aria(${target})`, target, `::-p-text(${target})`]) {
        try {
          const el = await page.$(sel);
          if (el !== null) return el;
        } catch {
          // selector invalid for this strategy — fall through to the next.
        }
      }
      return null;
    };

    const session: CdpSession = {
      goto: (url) =>
        wrapCmd("Page.navigate", () =>
          page.goto(url, { waitUntil: "domcontentloaded" }).then(() => undefined),
        ),
      currentUrl: () => Effect.sync(() => page.url()),
      click: (target) =>
        wrapCmd("Input.click", async () => {
          const el = await resolveElement(target);
          if (el === null) {
            throw new Error(
              `no element matching "${target}" (tried accessible-name, CSS, and text)`,
            );
          }
          await el.click();
        }),
      type: (target, text) =>
        wrapCmd("Input.type", async () => {
          const el = await resolveElement(target);
          if (el === null) {
            throw new Error(
              `no element matching "${target}" (tried accessible-name, CSS, and text)`,
            );
          }
          await el.focus();
          await el.type(text);
        }),
      key: (key) =>
        wrapCmd("Input.keyboard", () => page.keyboard.press(key as never)),
      wait: (ms) => Effect.sleep(`${Math.min(Math.max(ms, 0), 5_000)} millis`),
      screenshot: (path) =>
        wrapCmd("Page.captureScreenshot", () =>
          page
            .screenshot({ path: path as `${string}.png`, type: "png" })
            .then(() => undefined),
        ),
      accessibilitySnapshot: () =>
        wrapCmd("Accessibility.getFullAXTree", async () => {
          const tree = await page.accessibility.snapshot({ interestingOnly: true });
          return JSON.stringify(tree ?? { role: "WebArea", children: [] });
        }),
      close: () =>
        Effect.tryPromise({
          try: async () => {
            // DISCONNECT ONLY — never `page.close()`. The demo commands
            // (record start → play → record stop) share ONE pre-acquired
            // Browser Run session via `?browser_session=<id>` re-attach;
            // closing the session's only page makes the browser exit, killing
            // the session, and the NEXT command's attach fails. The page (and
            // the app state loaded into it) must outlive each short-lived CLI
            // connect; only `record stop`'s explicit `browser.close()` ends
            // the session (which is also what finalizes the recording).
            await browser.disconnect();
          },
          catch: () => undefined,
        }).pipe(Effect.ignore),
    };

    return { browser, page, session };
  }).pipe(
    // Bound the WHOLE attach, not just `puppeteer.connect`: a wedged Browser
    // Run re-attach can hang in `browser.pages()` / the CDP handshake too,
    // which would otherwise wedge whichever command attached (record start /
    // play / record stop) to the step cap. Fail fast as a normal attach error.
    Effect.timeoutFail({
      duration: "50 seconds",
      onTimeout: () =>
        new CdpAttachFailed({
          wsEndpoint: redactWsEndpoint(wsEndpoint),
          reason: "timeout",
          message: "attachCdp timed out after 50s",
        }),
    }),
  );
