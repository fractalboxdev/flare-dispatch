// FlareDispatch Dispatcher — GitHub App manifest creation routes.
//
// The two-leg flow that lets an operator create their FlareDispatch GitHub App
// without ever leaving the Dispatcher origin (specs/05-byoc.md § GitHub App
// setup):
//
//   GET /v1/github/install/new
//     Without `?owner` — renders a chooser asking whether the App should be
//     owned by the operator's personal account or by an org (text input for
//     the org login). The chooser submits back to the same path with the
//     `owner` query set.
//
//     With `?owner=` (empty) — renders a self-submitting `<form>` POST to
//     `https://github.com/settings/apps/new?state=<csrf>` (personal owner).
//
//     With `?owner=<org>` — same shape but POSTs to
//     `https://github.com/organizations/<org>/settings/apps/new?state=<csrf>`
//     so the resulting App is owned by `<org>`, not by the signed-in user.
//     Org-owned Apps survive a single admin leaving; personal-owned ones
//     don't. Validated server-side against the GitHub login grammar
//     (alphanumeric + single dashes, ≤39 chars); invalid → 400.
//
//     In every case the form carries the `manifest` JSON pulled from
//     `infra/github-app-manifest.json` with the placeholder `runs.example.com`
//     URLs rewritten to the current Dispatcher's own origin (derived from
//     `request.url`) — so the same code works on `*.workers.dev`, a custom
//     domain, and `wrangler dev`.
//
//   GET /v1/github/installed?code=<code>&state=<state>
//     GitHub's `redirect_url` callback. Exchanges `code` for the App's
//     credentials via `POST https://api.github.com/app-manifests/<code>/
//     conversions` (no auth — the code IS the credential, valid for one minute
//     after creation) and renders a one-shot "Success" page with the
//     `wrangler secret put` commands the operator must run NOW.
//
// --- Out of scope (deferred follow-up PRs) -----------------------------------
//
//   * `/v1/webhooks/github` — App event receiver + HMAC verify + KV install
//     map. The manifest declares the hook URL but no receiver is wired yet.
//   * Installation-token caching — `@fractalboxdev/flare-dispatch-github-app` already exists
//     but isn't called from the Worker on this PR.
//   * CSRF state-token *binding*. The form carries a `state` so the GitHub
//     redirect echoes it back, but we don't persist it to KV yet — single-PR
//     scope. A follow-up PR will bind state to `IDEMPOTENCY_KV` and reject
//     callbacks whose state we never minted.
//
// --- XSS posture -------------------------------------------------------------
//
// The "Success" page interpolates GitHub-controlled strings (`slug`, `name`,
// `html_url`, `pem`, …). The credentials shown belong to *their* App so
// there's no privilege escalation, but a hostile GitHub response could still
// land an XSS payload on the operator's browser. Every interpolated string is
// run through `htmlEscape` — never raw concatenation. The PEM block is
// rendered inside a `<pre>` with the same escape applied; line breaks are
// preserved by the surrounding `<pre>`.

import { Effect, Either, Match, Schema } from "effect";

/**
 * The manifest template ships in `infra/github-app-manifest.json` with three
 * placeholder URLs hardcoded as `runs.example.com`. The template is consumed
 * AT REQUEST TIME so the same deploy artifact serves every origin — we never
 * bake a specific Dispatcher URL into the JSON file.
 *
 * The literal is duplicated here (rather than `import`ed from `infra/`) so the
 * Worker bundle stays self-contained — Workers can't read files at runtime,
 * and a build-time `import` of JSON would require a wrangler module rule. The
 * test for `install/new` asserts the substitutions on this same object, and a
 * follow-up could enforce template-vs-shipped-JSON parity with a snapshot if
 * the file ever drifts from this copy.
 */
// Exported so the manifest-parity test (`github-manifest-parity.test.ts`) and
// the registration drift-detect (`scripts/emit-app-manifest.mjs`,
// `github-app verify`) can assert this Worker-bundled literal stays in lockstep
// with the committed `infra/github-app-manifest.json` mirror. spec 04 § Webhook
// mode calls these two copies out as mirrors; the parity test makes that real.
export const MANIFEST_TEMPLATE = {
  name: "FlareDispatch",
  description: "BYOC CI offload running on Cloudflare",
  url: "https://runs.example.com",
  hook_attributes: {
    url: "https://runs.example.com/v1/webhooks/github",
  },
  redirect_url: "https://runs.example.com/v1/github/installed",
  public: false,
  default_permissions: {
    checks: "write",
    contents: "read",
    deployments: "read",
    metadata: "read",
    // `write`, not `read`: the check-run callback (workflow.ts) creates/updates
    // check-runs AND the `pr-review` run posts a PR review comment — both need
    // pull_requests:write. The committed JSON mirror + the live dogfood App
    // already carry `write`; this literal had drifted to `read`.
    pull_requests: "write",
  },
  default_events: ["check_run", "check_suite", "deployment_status", "pull_request"],
} as const;

/** The placeholder origin every URL in the template starts with. */
const TEMPLATE_PLACEHOLDER = "https://runs.example.com";

/**
 * Resolve the template against the inbound request's own origin so the
 * resulting manifest's `url`, `hook_attributes.url`, and `redirect_url` all
 * point back at THIS Dispatcher. We accept a structurally-typed JSON object so
 * tests can swap in a mock template if needed.
 */
const resolveManifest = (origin: string): Record<string, unknown> => {
  // Deep-clone via JSON round-trip — the template is small and frozen-shape,
  // so the cost is negligible and we avoid hand-rolling a recursive copy.
  const m = JSON.parse(JSON.stringify(MANIFEST_TEMPLATE)) as {
    url: string;
    hook_attributes: { url: string };
    redirect_url: string;
    [k: string]: unknown;
  };
  m.url = m.url.replace(TEMPLATE_PLACEHOLDER, origin);
  m.hook_attributes.url = m.hook_attributes.url.replace(TEMPLATE_PLACEHOLDER, origin);
  m.redirect_url = m.redirect_url.replace(TEMPLATE_PLACEHOLDER, origin);
  return m;
};

/**
 * HTML-escape every metacharacter that could break out of a text node or an
 * attribute value. The output is safe for both contexts. We do NOT use the
 * named `&apos;` entity — it isn't defined in HTML4 and not all renderers
 * handle it; numeric `&#39;` is universal.
 */
export const htmlEscape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** A `text/html; charset=utf-8` response. */
const htmlResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/** A `application/json` error response — used for trivial 4xx paths. */
const jsonError = (error: string, message: string, status: number): Response =>
  new Response(JSON.stringify({ error, message }), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---------------------------------------------------------------------------
// Brand shell — the "weaver" design system shared with the docs/landing site.
// ---------------------------------------------------------------------------
//
// These install pages are served straight from the Worker as inline HTML —
// there is no Astro build, no bundler, no shared component layer to import. To
// keep the tech stack that simple while still matching the landing page's
// look, we replicate a faithful *subset* of `apps/docs/src/styles/global.css`
// here: the same tokens (warm paper / midnight terminal, single vermillion
// accent), the same Fraunces display + General Sans body + Iosevka mono type
// stack pulled from the same CDNs, and the same `.section-marker` / `.btn`
// idioms. Light and dark are driven by `prefers-color-scheme` (no toggle) so
// there's zero JS to ship for theming. If the design system on the docs site
// evolves materially, mirror the token block below.

/** Canonical docs/landing origin — the pages link back here for the full story. */
const DOCS_ORIGIN = "https://flare-dispatch.fractalbox.dev";
/** The public repo — `#quickstart` is the deploy-from-zero entry point. */
const REPO_URL = "https://github.com/fractalbox/flare-dispatch";

/**
 * The shared stylesheet. Inlined into every install page's `<head>`. A trimmed
 * port of the docs design system — tokens + base type + the handful of
 * components these pages actually use (`.container`, `.section-marker`,
 * `.btn`, `.card`, `pre`, callouts).
 */
const BRAND_STYLE = `
@import url("https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,200..900,0..100,0..1&display=swap");
@import url("https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap");
@font-face{font-family:"Iosevka Web";font-weight:400;font-style:normal;font-display:swap;src:url("https://cdn.jsdelivr.net/npm/@fontsource-variable/iosevka@5.1.0/files/iosevka-latin-wght-normal.woff2") format("woff2")}
:root{
  --paper:#f4f1ea;--paper-soft:#ebe6d8;--surface:#fdfbf5;--ink:#13131a;--ink-soft:#2b2c36;
  --muted:#5c5c66;--muted-soft:#8a8a91;--hairline:#d8d2c5;--hairline-strong:#b4ad9d;
  --accent:#ff3d00;--accent-soft:#ffe7df;--code-bg:#fdfbf5;--code-border:#e0dac9;
  --font-display:"Fraunces","Times New Roman",serif;
  --font-body:"General Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --font-mono:"Iosevka Web","SF Mono",ui-monospace,monospace;
  --radius:2px;color-scheme:light dark;
}
@media (prefers-color-scheme:dark){:root{
  --paper:#0a0a0f;--paper-soft:#11121a;--surface:#13141b;--ink:#eae7dd;--ink-soft:#b8b6ac;
  --muted:#7a7d8c;--muted-soft:#51545f;--hairline:#23252e;--hairline-strong:#353846;
  --accent:#ff7041;--accent-soft:#2b1810;--code-bg:#11121a;--code-border:#23252e;
}}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--paper);color:var(--ink);font-family:var(--font-body);font-size:16px;line-height:1.65;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-feature-settings:"ss01","cv11"}
body{margin:0;min-height:100vh;background:var(--paper);background-image:radial-gradient(rgba(0,0,0,0.012) 1px,transparent 1px),radial-gradient(rgba(0,0,0,0.008) 1px,transparent 1px);background-size:3px 3px,7px 7px;background-position:0 0,1px 1px}
@media (prefers-color-scheme:dark){body{background-image:radial-gradient(rgba(255,255,255,0.015) 1px,transparent 1px),radial-gradient(rgba(255,255,255,0.008) 1px,transparent 1px)}}
::selection{background:var(--accent);color:var(--paper)}
h1,h2,h3{font-family:var(--font-display);font-weight:400;font-variation-settings:"opsz" 100,"SOFT" 50;letter-spacing:-0.015em;line-height:1.1;margin:0}
h1{font-size:2.25rem;margin-bottom:.25rem}
h2{font-size:1.6rem;margin:2.5rem 0 .75rem}
h3{font-size:1.15rem;margin:0 0 .25rem}
p{margin:0 0 1em}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--accent) 35%,transparent)}
a:hover{border-bottom-color:var(--accent)}
code{font-family:var(--font-mono);font-size:.875em}
.container{max-width:46rem;margin:0 auto;padding:0 1.5rem}
.masthead{border-bottom:1px solid var(--hairline);margin-bottom:2.5rem}
.masthead__inner{max-width:46rem;margin:0 auto;padding:1.1rem 1.5rem;display:flex;align-items:baseline;gap:.7rem}
.wordmark{font-family:var(--font-display);font-size:1.15rem;letter-spacing:-0.01em;color:var(--ink);border:none}
.wordmark b{font-weight:600}
.wordmark .spark{color:var(--accent)}
.tagline{font-family:var(--font-mono);font-size:.6875rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.section-marker{font-family:var(--font-mono);font-size:.6875rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);display:inline-flex;align-items:center;gap:.6em;margin-bottom:.6rem}
.section-marker::before{content:"";display:inline-block;width:1.1rem;height:1px;background:var(--hairline-strong)}
.lede{font-size:1.0625rem;color:var(--ink-soft)}
.btn{display:inline-flex;align-items:center;gap:.5rem;padding:.7rem 1.2rem;font-family:var(--font-mono);font-size:.8125rem;letter-spacing:.05em;border:1px solid var(--ink);background:var(--ink);color:var(--paper);border-radius:var(--radius);transition:all 160ms cubic-bezier(0.2,0.8,0.2,1)}
.btn:hover{background:var(--accent);border-color:var(--accent);color:var(--paper);transform:translateY(-1px)}
.btn--ghost{background:transparent;color:var(--ink);border-color:var(--hairline-strong)}
.btn--ghost:hover{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.card{border:1px solid var(--hairline);border-radius:var(--radius);background:var(--surface);padding:1.25rem 1.4rem;margin:1.1rem 0}
.card h2,.card h3{margin-top:0}
.hint{color:var(--muted);font-size:.8125rem}
label{display:block;margin-bottom:.4rem;font-size:.875rem}
input[type=text]{font:inherit;font-size:.9375rem;padding:.5rem .65rem;min-width:16rem;background:var(--surface);color:var(--ink);border:1px solid var(--hairline-strong);border-radius:var(--radius)}
input[type=text]:focus{outline:2px solid var(--accent);outline-offset:1px}
pre{background:var(--code-bg);border:1px solid var(--code-border);border-radius:var(--radius);padding:.75rem 1rem;overflow-x:auto;font-family:var(--font-mono);font-size:.8125rem;line-height:1.5;white-space:pre-wrap;word-break:break-all;margin:.5rem 0}
.callout{border-left:3px solid var(--accent);background:var(--accent-soft);padding:.75rem 1rem;border-radius:0 var(--radius) var(--radius) 0;margin:1.5rem 0}
.callout--warn{border-left-color:#d97706;background:color-mix(in srgb,#d97706 12%,var(--surface))}
.callout--err{border-left-color:#dc2626;background:color-mix(in srgb,#dc2626 12%,var(--surface))}
.cta{display:flex;flex-wrap:wrap;gap:.75rem;margin:1.5rem 0}
.colophon{border-top:1px solid var(--hairline);margin-top:3.5rem;padding:1.75rem 0 3rem;font-family:var(--font-mono);font-size:.75rem;letter-spacing:.04em;color:var(--muted)}
.colophon a{color:var(--muted)}
.colophon a:hover{color:var(--accent)}
.colophon nav{display:flex;flex-wrap:wrap;gap:1.1rem;margin-top:.4rem}
`;

/**
 * Render a complete branded HTML document. `marker` is the mono `§` eyebrow,
 * `heading` the `<h1>`, `bodyHtml` the already-escaped page content. Every
 * page shares the masthead wordmark and the docs colophon so the install flow
 * reads as one continuation of the landing site.
 */
const brandPage = (opts: {
  title: string;
  marker: string;
  heading: string;
  bodyHtml: string;
  /** Extra markup injected at end of `<body>` (e.g. the auto-submit script). */
  tail?: string;
}): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${opts.title}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex">
  <style>${BRAND_STYLE}</style>
</head>
<body>
  <header class="masthead">
    <div class="masthead__inner">
      <a class="wordmark" href="${DOCS_ORIGIN}">Flare<b>Dispatch</b><span class="spark">.</span></a>
      <span class="tagline">GitHub App setup</span>
    </div>
  </header>
  <main class="container">
    <span class="section-marker">${opts.marker}</span>
    <h1>${opts.heading}</h1>
    ${opts.bodyHtml}
  </main>
  <footer class="colophon container">
    BYOC · runs in your own Cloudflare account
    <nav>
      <a href="${DOCS_ORIGIN}/docs/prd">PRD</a>
      <a href="${DOCS_ORIGIN}/docs/05-byoc">BYOC setup</a>
      <a href="${DOCS_ORIGIN}/recipes">Recipes</a>
      <a href="${REPO_URL}#quickstart">Quickstart</a>
    </nav>
  </footer>
${opts.tail ?? ""}
</body>
</html>`;

/**
 * GitHub login grammar: a leading alphanumeric followed by ≤38 alphanumerics
 * or single dashes. Real GitHub also forbids consecutive dashes and a trailing
 * dash, but those finer rules are GitHub's to enforce — a too-strict regex
 * here would refuse logins the user could legitimately create. The intent of
 * this check is to make sure the value is safe to splat into a URL path and
 * an HTML attribute, not to perfectly mirror GitHub's reserved-name list.
 */
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/**
 * Build the form action URL for a given owner choice.
 *   - `""`        → personal-account App   → `/settings/apps/new`
 *   - `"<org>"`   → org-owned App          → `/organizations/<org>/settings/apps/new`
 *
 * `org` is `encodeURIComponent`'d defensively, even though the validator
 * already restricts the input to URL-safe characters — same belt-and-braces
 * rule as `dispatch.ts`'s `encodeURIComponent(run)`.
 */
const formActionForOwner = (owner: string, state: string): string => {
  const safeState = encodeURIComponent(state);
  if (owner === "") {
    return `https://github.com/settings/apps/new?state=${safeState}`;
  }
  return `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${safeState}`;
};

/**
 * The owner-chooser page — rendered when `/install/new` is hit without an
 * `owner` query param. Two GET-submit forms route the operator back to
 * `/install/new?owner=` (personal) or `/install/new?owner=<input>` (org).
 *
 * The org form uses a `pattern` attribute as a client-side hint; the
 * server-side validator in `handleInstallNew` is the real enforcement.
 */
const renderOwnerChooser = (): string =>
  brandPage({
    title: "FlareDispatch — Choose App owner",
    marker: "§ GitHub App / 01 — owner",
    heading: "Create your FlareDispatch GitHub App",
    bodyHtml: `  <p class="lede">FlareDispatch is BYOC — there is no shared App. This step creates an App in your own GitHub account or org and hands the private key back to this Dispatcher (one-time, stored in your Worker Secrets).</p>

  <div class="callout">
    <strong>Installing with an AI agent?</strong> Point it at the machine-readable runbook —
    <a href="/v1/github/install/llms.txt"><code>/v1/github/install/llms.txt</code></a> — it carries every command and the one browser step it must hand back to you.
  </div>

  <h2>Pick an owner</h2>
  <p class="hint">App ownership controls who can manage the App and rotate its key. Org-owned Apps survive a single admin leaving; personal-owned ones don&#39;t.</p>

  <form class="card" method="get" action="/v1/github/install/new">
    <h3>Personal account</h3>
    <p class="hint">Owned by whoever is signed in to GitHub when you continue. Fine for solo use; brittle for teams.</p>
    <input type="hidden" name="owner" value="">
    <button class="btn btn--ghost" type="submit">Continue as personal account</button>
  </form>

  <form class="card" method="get" action="/v1/github/install/new">
    <h3>Organization</h3>
    <p class="hint">Recommended for teams. You must have <em>Owner</em> role on the org. The App will be created under the org and all org admins can manage it afterward.</p>
    <label for="owner-input">Organization login (the <code>&lt;org&gt;</code> in <code>github.com/&lt;org&gt;</code>):</label>
    <input type="text" id="owner-input" name="owner" placeholder="acme-corp" pattern="[A-Za-z0-9][A-Za-z0-9-]{0,38}" maxlength="39" required>
    <p><button class="btn" type="submit">Continue as organization</button></p>
  </form>`,
  });

/**
 * The manifest-form page. Auto-submits via JS on load; a `<noscript>` button
 * gives a manual fallback for headless browsers and JS-disabled UAs.
 *
 * GitHub's docs spell the receiving endpoint as `settings/apps/new` (personal)
 * or `organizations/<org>/settings/apps/new` (org-owned) — `formActionForOwner`
 * picks the right one. The `?state=<csrf>` query is what GitHub echoes back to
 * `redirect_url` so we can (in a follow-up PR) verify the callback wasn't
 * initiated by a third party.
 */
const renderInstallForm = (
  manifest: Record<string, unknown>,
  state: string,
  owner: string,
): string => {
  const manifestJson = JSON.stringify(manifest);
  // The hidden `manifest` input value is HTML-attribute-escaped — `htmlEscape`
  // turns `"` into `&quot;` so the `value="..."` boundary holds. The state is
  // a UUID, so escaping is overkill, but apply it as defense-in-depth.
  const safeManifest = htmlEscape(manifestJson);
  const safeState = htmlEscape(state);
  // `formActionForOwner` already URL-encodes the org segment; we additionally
  // HTML-escape the resulting attribute value for the `<form action="…">`
  // boundary. Belt-and-braces — the regex validator already excludes any HTML
  // metacharacter.
  const actionUrl = htmlEscape(formActionForOwner(owner, state));
  const ownerLabel = owner === "" ? "your personal account" : `<code>${htmlEscape(owner)}</code>`;
  return brandPage({
    title: "FlareDispatch — Create GitHub App",
    marker: "§ GitHub App / 02 — redirect",
    heading: "Handing off to GitHub…",
    bodyHtml: `  <p class="lede">Redirecting you to GitHub to create the FlareDispatch App, owned by ${ownerLabel}. If you aren&#39;t redirected automatically, click the button below.</p>
  <form id="manifest-form" method="post" action="${actionUrl}">
    <input type="hidden" name="manifest" value="${safeManifest}">
    <input type="hidden" name="state" value="${safeState}">
    <noscript>
      <p><button class="btn" type="submit">Continue to GitHub</button></p>
    </noscript>
  </form>`,
    tail: `  <script>
    // Auto-submit so the page is effectively a redirect with a body.
    document.getElementById('manifest-form').submit();
  </script>`,
  });
};

/**
 * Handle `GET /v1/github/install/new` — render either the owner chooser or
 * the manifest-form page, depending on whether `owner` was supplied.
 *
 *   - no `owner` query                  → chooser (200 HTML)
 *   - `owner=` (empty)                  → personal-account form (200 HTML)
 *   - `owner=<valid-login>`             → org-owned form (200 HTML)
 *   - `owner=<invalid>`                 → 400 JSON
 *
 * The "empty `owner` means personal" sentinel is intentional — `null` (no
 * query at all) is the "user hasn't chosen yet" case, while an explicit empty
 * string means "I chose personal." This matches the chooser's two forms:
 * both POST `owner`, one with a value, one without.
 *
 * The form's `manifest` is a fresh resolution of `MANIFEST_TEMPLATE` against
 * `new URL(request.url).origin`. We use `crypto.randomUUID()` for the state
 * token; per-request entropy is fine because we don't persist it on this PR
 * (the follow-up PR adds KV binding).
 */
export const handleInstallNew = (request: Request): Response => {
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");

  if (owner === null) {
    return htmlResponse(renderOwnerChooser());
  }

  if (owner !== "" && !LOGIN_RE.test(owner)) {
    return jsonError(
      "invalid_owner",
      "`owner` must be a valid GitHub login (alphanumeric + dashes, 1–39 chars, not starting with a dash) or empty for a personal-account App",
      400,
    );
  }

  const manifest = resolveManifest(url.origin);
  const state = crypto.randomUUID();
  return htmlResponse(renderInstallForm(manifest, state, owner));
};

// ---------------------------------------------------------------------------
// `GET /v1/github/installed`
// ---------------------------------------------------------------------------

/**
 * The response shape from `POST /app-manifests/{code}/conversions`. Only the
 * fields we display are decoded; everything else (the full permissions block,
 * `owner`, `created_at`) is ignored.
 */
const ConversionResponse = Schema.Struct({
  id: Schema.Number,
  slug: Schema.String,
  name: Schema.String,
  html_url: Schema.String,
  webhook_secret: Schema.String,
  pem: Schema.String,
  client_id: Schema.String,
  client_secret: Schema.String,
  // `owner.login` is what GitHub assigned as the App's owner — either the
  // signed-in user (personal-owned) or the org login (org-owned). We surface
  // it on the success page so the operator can confirm the owner matches
  // what they picked on the chooser; if they accidentally got prompted for
  // their personal account on the GitHub side, the page makes that visible.
  owner: Schema.Struct({ login: Schema.String }),
});
type ConversionResponse = Schema.Schema.Type<typeof ConversionResponse>;

/** A tagged error covering every way the conversion call can go wrong. */
class ConversionFailed extends Schema.TaggedError<ConversionFailed>()("ConversionFailed", {
  /** Best-effort status; 0 when the fetch itself threw (network error). */
  status: Schema.Number,
  /** Whatever GitHub returned (already string-coerced). */
  body: Schema.String,
  /** Short tag describing the failure mode for the error page. */
  reason: Schema.Literal("network", "non_2xx", "bad_shape"),
}) {}

/** A `fetch` shape the route can be tested against without touching the network. */
export type FetchLike = typeof fetch;

/**
 * Exchange the manifest `code` for the App's credentials. Returns the parsed
 * conversion response on success; a tagged `ConversionFailed` otherwise.
 *
 * GitHub's docs (REST API § Apps § "Create a GitHub App from a manifest")
 * require `Accept: application/vnd.github+json` and recommend pinning
 * `X-GitHub-Api-Version: 2022-11-28`. The `code` itself is the bearer — no
 * `Authorization` header.
 */
const exchangeCode = (
  code: string,
  fetchImpl: FetchLike,
): Effect.Effect<ConversionResponse, ConversionFailed> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "FlareDispatch-Dispatcher",
          },
        }),
      catch: (cause) =>
        new ConversionFailed({
          status: 0,
          body: cause instanceof Error ? cause.message : String(cause),
          reason: "network",
        }),
    });

    const text = yield* Effect.promise(() => res.text());

    if (res.status < 200 || res.status >= 300) {
      return yield* Effect.fail(
        new ConversionFailed({
          status: res.status,
          body: text,
          reason: "non_2xx",
        }),
      );
    }

    // Parse + Schema-validate. Surface a tagged error on bad shape so the
    // caller renders an "unexpected response" page rather than crashing.
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () =>
        new ConversionFailed({
          status: res.status,
          body: text,
          reason: "bad_shape",
        }),
    });

    return yield* Schema.decodeUnknown(ConversionResponse)(parsed).pipe(
      Effect.mapError(
        () =>
          new ConversionFailed({
            status: res.status,
            body: text,
            reason: "bad_shape",
          }),
      ),
    );
  });

/**
 * The "credentials shown ONCE" success page. EVERY interpolated value is run
 * through `htmlEscape` — even the App id, which is a number we control,
 * because the helper costs nothing and keeps the rule simple ("escape all
 * substitutions, no exceptions").
 *
 * The install URL pattern is `<html_url>/installations/new` — per GitHub's
 * Apps API, the App's `html_url` is the marketing page and
 * `<html_url>/installations/new` is the install picker.
 */
const renderSuccess = (app: ConversionResponse): string => {
  const id = htmlEscape(String(app.id));
  const slug = htmlEscape(app.slug);
  const name = htmlEscape(app.name);
  const htmlUrl = htmlEscape(app.html_url);
  const installUrl = htmlEscape(`${app.html_url}/installations/new`);
  const ownerLogin = htmlEscape(app.owner.login);
  const webhookSecret = htmlEscape(app.webhook_secret);
  const clientId = htmlEscape(app.client_id);
  const clientSecret = htmlEscape(app.client_secret);
  const pem = htmlEscape(app.pem);

  return brandPage({
    title: `FlareDispatch — App created (${slug})`,
    marker: "§ GitHub App / 03 — credentials",
    heading: `App created: ${name}`,
    bodyHtml: `  <p class="hint">owner: <code>${ownerLogin}</code> &middot; slug: <code>${slug}</code> &middot; id: <code>${id}</code> &middot; <a href="${htmlUrl}" rel="noreferrer noopener">view on GitHub ↗</a></p>

  <div class="callout callout--warn">
    <strong>These credentials are shown ONCE.</strong> Copy them into <code>wrangler secret put</code> NOW — they will not be displayed again. If you lose them, regenerate from the App&#39;s settings page.
  </div>

  <h2>1. Stash the credentials in Worker secrets</h2>
  <p>Run each of these from your <code>flare-dispatch</code> checkout, pasting the value when prompted:</p>

  <h3><code>GITHUB_APP_ID</code></h3>
  <pre>wrangler secret put GITHUB_APP_ID
${id}</pre>

  <h3><code>GITHUB_WEBHOOK_SECRET</code></h3>
  <pre>wrangler secret put GITHUB_WEBHOOK_SECRET
${webhookSecret}</pre>

  <h3><code>GITHUB_APP_CLIENT_ID</code></h3>
  <pre>wrangler secret put GITHUB_APP_CLIENT_ID
${clientId}</pre>

  <h3><code>GITHUB_APP_CLIENT_SECRET</code></h3>
  <pre>wrangler secret put GITHUB_APP_CLIENT_SECRET
${clientSecret}</pre>

  <h3><code>GITHUB_APP_PRIVATE_KEY</code></h3>
  <p>This is a multi-line PEM. Paste the WHOLE block (including the BEGIN/END lines) into the <code>wrangler secret put</code> prompt, then press <kbd>Ctrl-D</kbd> on a blank line.</p>
  <pre>wrangler secret put GITHUB_APP_PRIVATE_KEY</pre>
  <p>PEM to paste:</p>
  <pre>${pem}</pre>

  <h2>2. Install the App on a repo or org</h2>
  <p>The install picker shows every account/org you can install the App on. Pick <code>${ownerLogin}</code> (or any other org you admin) and choose the repos.</p>
  <p class="cta"><a class="btn" href="${installUrl}" rel="noreferrer noopener">Install ${name}</a></p>

  <h2>3. Verify</h2>
  <p>After installing, dispatch a run from a workflow on the installed repo — the Dispatcher will create a check-run on the commit. See the <a href="${DOCS_ORIGIN}/docs/05-byoc">BYOC setup spec</a> for the end-to-end walkthrough.</p>`,
  });
};

/**
 * Render the error page for any `ConversionFailed`. The GitHub response body
 * is included so the operator can see what went wrong, but it goes through
 * `htmlEscape` — a hostile/buggy upstream cannot inject script tags.
 */
const renderError = (e: ConversionFailed): string => {
  const reasonText = Match.value(e.reason).pipe(
    Match.when("network", () => "Network error reaching api.github.com."),
    Match.when(
      "non_2xx",
      () =>
        `GitHub returned a non-2xx response (HTTP ${e.status}) — the most common cause is an expired or already-converted manifest code (codes are valid for one minute).`,
    ),
    Match.when(
      "bad_shape",
      () => "GitHub returned a 2xx but the response body did not match the expected shape.",
    ),
    Match.exhaustive,
  );

  return brandPage({
    title: "FlareDispatch — App creation failed",
    marker: "§ GitHub App / error",
    heading: "App creation failed",
    bodyHtml: `  <div class="callout callout--err">${htmlEscape(reasonText)}</div>
  <p>GitHub response body (escaped):</p>
  <pre>${htmlEscape(e.body)}</pre>
  <p class="cta"><a class="btn" href="/v1/github/install/new">Restart the flow</a></p>`,
  });
};

/**
 * Handle `GET /v1/github/installed` — the manifest-conversion callback.
 *
 * Missing `code` → 400 JSON (this is a programmer error in the caller, not
 * something a human is going to see — fall back to JSON so it's grep-able in
 * logs). Successful exchange → 200 HTML. Any conversion failure → 502 HTML
 * with the upstream body inlined (escaped).
 */
export const handleInstalled = async (
  request: Request,
  fetchImpl: FetchLike = fetch,
): Promise<Response> => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code === null || code === "") {
    return jsonError(
      "missing_code",
      "expected `code` query parameter from the GitHub manifest callback",
      400,
    );
  }

  // The state echo is intentionally NOT validated yet — see file header. We
  // still read it so the (current) noop access is visible in code review.
  // biome-ignore lint/correctness/noUnusedVariables: see file header re: deferred state binding.
  const _state = url.searchParams.get("state");

  // Run as an `Either` so the typed failure surfaces as a value we can
  // pattern-match on — no `Cause` traversal, no defect handling.
  const result = await Effect.runPromise(Effect.either(exchangeCode(code, fetchImpl)));

  return Either.match(result, {
    onLeft: (e) => htmlResponse(renderError(e), 502),
    onRight: (app) => htmlResponse(renderSuccess(app)),
  });
};

// ---------------------------------------------------------------------------
// `GET /v1/github/install/llms.txt` — agent-runnable install runbook
// ---------------------------------------------------------------------------
//
// The HTML chooser is for a human in a browser. This route is the same flow
// rewritten for an LLM agent (Claude Code, Cursor, …) the operator can hand
// the install to: a flat Markdown runbook with literal shell commands, served
// `text/markdown` so an agent can fetch-and-follow it directly.
//
// The GitHub App *manifest creation* leg is irreducibly interactive — it needs
// a logged-in github.com session and a human click — so the runbook is honest
// about that: it tells the agent to surface ONE browser URL to the operator,
// wait for the credentials the success page prints, then drive everything
// else (`wrangler secret put`, `wrangler deploy`, the verify step). The
// commands are origin-aware: `{origin}` resolves to whichever Dispatcher
// served this file, so the same artifact works on `*.workers.dev`, a custom
// domain, and `wrangler dev`.

/** A `text/markdown; charset=utf-8` response. */
const markdownResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });

/**
 * Render the agent install runbook for a given Dispatcher origin. Pure string
 * assembly — no escaping needed since `origin` is `new URL().origin` (already
 * a well-formed origin, never attacker-controlled markup) and everything else
 * is a static literal.
 */
const renderInstallLlms = (origin: string): string => `# Install FlareDispatch — agent runbook

> You are an AI coding agent installing FlareDispatch's GitHub App for an
> operator. FlareDispatch is BYOC: it runs entirely in the operator's own
> Cloudflare account — there is no shared/hosted App, so you create one they
> own. Follow these steps in order. One step needs a human; the rest are yours
> to run.

> Why create an App rather than OAuth sign-in + install? There is no shared App
> to "just install". OAuth only proves who a user is; it can't hand this Worker
> the App ID + private key it needs to mint installation tokens and post Check
> Runs as a bot. So the flow CREATES a GitHub App the operator owns (via the
> App-manifest flow), then installs it. The personal-vs-org choice is the
> "select an account" step — it happens at creation because App ownership is
> fixed when the App is made and can't be moved afterward.

- Dispatcher origin: ${origin}
- Full docs: ${DOCS_ORIGIN}
- Source + quickstart: ${REPO_URL}#quickstart

## Prerequisites (verify before starting)

1. The operator has a local checkout of \`flare-dispatch\` and \`wrangler\` is
   authenticated (\`wrangler whoami\` succeeds).
2. The Dispatcher is already deployed and reachable at the origin above
   (\`curl -fsS ${origin}/health\` returns 200). If not, deploy it first with
   \`wrangler deploy\` from the checkout, then re-check.

## Step 1 — Human creates the App (interactive, hand this off)

The GitHub App manifest flow requires a logged-in github.com session and a
click — you cannot complete it headlessly. Surface this URL to the operator
and ask them to open it and finish the flow:

    ${origin}/v1/github/install/new

Tell them: pick personal vs. org owner, click through to GitHub, create the
App. GitHub redirects back to a one-time "App created" page that prints five
secret values. Ask them to paste that page's secret block back to you (or to
run the \`wrangler secret put\` commands themselves if they prefer not to share
credentials with an agent).

## Step 2 — Store the five secrets (you run these)

From the operator's \`flare-dispatch\` checkout, set each secret with the value
from the success page:

    wrangler secret put GITHUB_APP_ID
    wrangler secret put GITHUB_WEBHOOK_SECRET
    wrangler secret put GITHUB_APP_CLIENT_ID
    wrangler secret put GITHUB_APP_CLIENT_SECRET
    wrangler secret put GITHUB_APP_PRIVATE_KEY   # multi-line PEM, paste whole block

\`GITHUB_APP_PRIVATE_KEY\` is a multi-line PEM — paste the entire block
including the BEGIN/END lines. Never commit any of these values; they belong
only in Worker Secrets.

## Step 3 — Redeploy so the Worker picks up the secrets

    wrangler deploy

## Step 4 — Install the App on the repos

The success page links to \`<app_html_url>/installations/new\`. Have the
operator open it and select the repos/org to install on. (This is the operator's
choice of scope — surface the link, don't guess.)

## Step 5 — Verify

Open a pull request (or dispatch a run) on an installed repo. Within a few
seconds a FlareDispatch Check Run should appear on the commit. If it does, the
install is complete. If not, see the BYOC setup spec:
${DOCS_ORIGIN}/docs/05-byoc

## Notes

- Idempotent: re-running \`wrangler secret put\` overwrites; re-running
  \`wrangler deploy\` is safe.
- Pure-webhook mode means no \`.github/workflows\` file is required — installing
  the App is the trigger. Details: ${DOCS_ORIGIN}/docs/05-byoc
`;

/**
 * Handle `GET /v1/github/install/llms.txt`. Resolves the runbook against the
 * inbound request's own origin so every command targets THIS Dispatcher.
 */
export const handleInstallLlms = (request: Request): Response =>
  markdownResponse(renderInstallLlms(new URL(request.url).origin));
