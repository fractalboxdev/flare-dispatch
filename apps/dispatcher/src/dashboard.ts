// FlareDispatch Dispatcher — the `GET /` entry-point dashboard (SSR).
//
// A self-contained HTML index of the inspection surface that already lives on
// this Worker: it lists the latest executions and deep-links each to its log
// viewer (`/logs/:id?t=…`) and, for `product-demo` runs, its recorded
// walkthrough (`/demos/:id?t=…`). It is a VIEWER surface — gated behind the same
// Cloudflare Access app as `/logs`, `/demos`, `/replay`, `/v1/executions` — so
// the renderer assumes an already-authenticated operator.
//
// This module is PURE: `renderDashboard` is a string → string template with no
// I/O, so it stays trivially testable (dashboard.test.ts). The route that feeds
// it (token signing, D1 reads, the Access gate) is wired in http-app.ts.

/** One execution row, pre-resolved with its tokened viewer links. */
export interface DashboardRow {
  readonly id: string;
  readonly run: string;
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
  readonly status: string;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  /** Wall-time in ms (`completedAt - startedAt`), or `null` while running. */
  readonly durationMs: number | null;
  /** Per-execution cost rollup in integer micro-USD, or `null` if not computed. */
  readonly costMicroUsd: number | null;
  /** How the cost was derived — `metered | mixed | modeled | unmetered` (null if absent). */
  readonly costBasis: string | null;
  /** Tokened `/logs` URL, or `null` when no log-link secret is configured. */
  readonly logsUrl: string | null;
  /** Tokened `/demos` URL — only set for `product-demo` runs. */
  readonly demosUrl: string | null;
  /**
   * GitHub PR-search URL for this repo's self-heal fix PRs, set ONLY when this
   * execution is a `self-heal-pr` run that opened a verified fix PR (its
   * `summary_json.prStaged === true`). Drives the "self-heal" tag in the viewer
   * — a non-null value means flare-dispatch drove a PR to fix a bug here.
   */
  readonly selfHealPrUrl: string | null;
}

export interface DashboardData {
  /** The dispatcher's public origin (no trailing slash), for canonical/OG. */
  readonly origin: string;
  readonly rows: readonly DashboardRow[];
  /** Wall clock for relative timestamps (injected for deterministic tests). */
  readonly nowMs: number;
  /** `owner/repo` slug for the source link. */
  readonly repoSlug: string;
}

/** HTML-escape a value for safe interpolation into element text / attributes. */
const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Map an execution status onto a badge CSS modifier. */
const badgeClass = (status: string): string => {
  switch (status) {
    case "success":
      return "ok";
    case "failure":
      return "fail";
    case "cancelled":
      return "muted";
    case "running":
    case "started":
      return "live";
    default:
      return "pending";
  }
};

/** Compact relative time, e.g. "3m ago", "2h ago", "—" when unknown. */
const relativeTime = (atMs: number | null, nowMs: number): string => {
  if (atMs === null) return "—";
  const deltaS = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (deltaS < 60) return `${deltaS}s ago`;
  const deltaM = Math.round(deltaS / 60);
  if (deltaM < 60) return `${deltaM}m ago`;
  const deltaH = Math.round(deltaM / 60);
  if (deltaH < 48) return `${deltaH}h ago`;
  return `${Math.round(deltaH / 24)}d ago`;
};

/** Short 7-char sha for display. */
const shortSha = (sha: string): string => (sha.length > 7 ? sha.slice(0, 7) : sha);

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: #e7e9ee; background: #0d1017; max-width: 64rem; margin-inline: auto;
  }
  a { color: #6ea8fe; text-decoration: none; }
  a:hover { text-decoration: underline; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: .75rem; margin-bottom: .25rem; }
  h1 { font-size: 1.4rem; margin: 0; letter-spacing: -0.01em; }
  .tagline { color: #9aa3b2; margin: 0 0 1.75rem; }
  h2 { font-size: .82rem; text-transform: uppercase; letter-spacing: .08em; color: #9aa3b2; margin: 2rem 0 .6rem; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-weight: 600; color: #9aa3b2; padding: .4rem .5rem; border-bottom: 1px solid #232838; }
  td { padding: .55rem .5rem; border-bottom: 1px solid #171b27; vertical-align: baseline; }
  tr:hover td { background: #11151f; }
  .run { font-weight: 600; }
  .repo { color: #c4cad6; }
  .sha { color: #8a93a5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  .when { color: #8a93a5; white-space: nowrap; }
  .links a { margin-right: .75rem; }
  /* A clickable execution row deep-links to its log viewer. The run cell's link
     carries a stretched ::after that turns the whole <tr> into the hit target,
     while the explicit View links are lifted above it so they stay clickable. */
  tr.rowlink { position: relative; cursor: pointer; }
  .run a { color: inherit; font-weight: inherit; }
  .run a::after { content: ""; position: absolute; inset: 0; }
  .links a { position: relative; z-index: 1; }
  .badge {
    display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: 12px; font-weight: 600;
    border: 1px solid transparent;
  }
  .badge.ok { color: #7ee2a8; background: #0f2a1c; border-color: #1c5238; }
  .badge.fail { color: #ff9a9a; background: #2c1518; border-color: #5a2730; }
  .badge.live { color: #8fc2ff; background: #102036; border-color: #234a78; }
  .badge.muted { color: #9aa3b2; background: #1a1e29; border-color: #2b313f; }
  .badge.pending { color: #e4c779; background: #2a2412; border-color: #59491c; }
  /* The self-heal tag: a clickable pill (lifted above the row stretch) that
     deep-links to the repo's flare-dispatch fix PRs. */
  .badge.selfheal { color: #c9b3ff; background: #1d1730; border-color: #3b2d63; position: relative; z-index: 1; margin-left: .45rem; }
  .badge.selfheal:hover { text-decoration: none; border-color: #5a47a0; }
  .empty { color: #9aa3b2; padding: 1.5rem .5rem; border: 1px dashed #2b313f; border-radius: .5rem; text-align: center; }
  footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #171b27; color: #8a93a5; font-size: 13px; }
  footer a { margin-right: 1rem; }
`;

const renderRow = (row: DashboardRow, nowMs: number): string => {
  const links: string[] = [];
  if (row.logsUrl !== null) {
    links.push(`<a href="${esc(row.logsUrl)}">Logs</a>`);
  }
  if (row.demosUrl !== null) {
    links.push(`<a href="${esc(row.demosUrl)}">Demo</a>`);
  }
  const linkCell = links.length > 0 ? links.join("") : '<span class="when">—</span>';
  // The run name is the row's primary deep-link: clicking the execution opens
  // its log viewer. When no log link exists (no secret configured) the row is
  // plain text and not click-through.
  const clickable = row.logsUrl !== null;
  const runCell = clickable
    ? `<a href="${esc(row.logsUrl as string)}" title="View logs">${esc(row.run)}</a>`
    : esc(row.run);
  // Self-heal tag — a pill linking to the repo's fix PRs, shown only when this
  // execution actually drove a PR to fix a bug.
  const selfHealPill =
    row.selfHealPrUrl !== null
      ? ` <a class="badge selfheal" href="${esc(row.selfHealPrUrl)}" title="View flare-dispatch self-heal fix PRs">🩹 self-heal</a>`
      : "";
  return `<tr${clickable ? ' class="rowlink"' : ""}>
    <td><span class="badge ${badgeClass(row.status)}">${esc(row.status)}</span></td>
    <td class="run">${runCell}${selfHealPill}</td>
    <td><span class="repo">${esc(row.repo)}</span> <span class="sha">${esc(shortSha(row.sha))}</span></td>
    <td class="when">${esc(relativeTime(row.startedAt, nowMs))}</td>
    <td class="links">${linkCell}</td>
  </tr>`;
};

const renderTable = (data: DashboardData): string => {
  if (data.rows.length === 0) {
    return `<p class="empty">No executions yet. Dispatch a run to see it appear here.</p>`;
  }
  const body = data.rows.map((row) => renderRow(row, data.nowMs)).join("\n");
  return `<table>
    <thead><tr>
      <th>Status</th><th>Run</th><th>Repo</th><th>Started</th><th>View</th>
    </tr></thead>
    <tbody>
${body}
    </tbody>
  </table>`;
};

/**
 * Render the dashboard page. Pure: all data (rows, tokened URLs, clock) is
 * resolved by the caller and passed in.
 */
export const renderDashboard = (data: DashboardData): string => {
  const canonical = `${data.origin.replace(/\/$/, "")}/`;
  const description =
    "FlareDispatch — dispatch CI/CD runs to Cloudflare and inspect their logs, executions, and recorded product demos.";
  const repoUrl = `https://github.com/${data.repoSlug}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FlareDispatch — Dashboard</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="FlareDispatch — Dashboard" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta name="twitter:card" content="summary" />
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>FlareDispatch</h1>
</header>
<p class="tagline">Dispatch CI/CD runs to Cloudflare — inspect logs, executions, and product demos.</p>

<main>
  <h2>Latest executions</h2>
  ${renderTable(data)}
</main>

<footer>
  <a href="/v1/github/install/new">Install the GitHub App</a>
  <a href="${esc(repoUrl)}">Source</a>
</footer>
</body>
</html>`;
};
